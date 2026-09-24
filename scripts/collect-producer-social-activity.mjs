import fs from 'node:fs/promises';

const BP_FILE = new URL('../data/producer-bp-social.json', import.meta.url);
const OUT = new URL('../data/producer-social-activity.json', import.meta.url);
const MAX_DAYS = 365;

async function readJson(url, fallback) {
  try { return JSON.parse(await fs.readFile(url, 'utf8')); }
  catch { return fallback; }
}

function cleanHandle(value) {
  if (!value) return '';
  return String(value).replace(/^@/, '').trim();
}

function toDateMs(v) {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : null;
}

function cutoffMs(days) {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'accept': 'application/json',
      'user-agent': 'XPRCORE-social-activity/1.0',
      ...(options.headers || {})
    }
  });
  if (!res.ok) return null;
  return await res.json();
}

async function githubEvents(handle) {
  const user = cleanHandle(handle);
  if (!user) return [];
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const data = await fetchJson(`https://api.github.com/users/${encodeURIComponent(user)}/events/public?per_page=100&page=${page}`);
    // A missing/deleted/private GitHub account must not stop the whole collector.
    if (!Array.isArray(data) || !data.length) break;
    for (const e of data) {
      const ts = toDateMs(e.created_at);
      if (ts && ts >= cutoffMs(MAX_DAYS)) out.push({ id: `github:${e.id}`, ts });
    }
    if (data.length < 100) break;
    if (out.length && Math.min(...out.map(x => x.ts)) < cutoffMs(MAX_DAYS)) break;
  }
  return out;
}

async function telegramEvents(handle) {
  const user = cleanHandle(handle);
  if (!user) return [];
  const out = [];
  let before = '';
  for (let page = 0; page < 8; page++) {
    const url = `https://t.me/s/${encodeURIComponent(user)}${before ? `?before=${encodeURIComponent(before)}` : ''}`;
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 XPRCORE-social-activity/1.0' }});
    if (!res.ok) break;
    const html = await res.text();
    const re = /data-post=["'][^/"']+\/(\d+)["'][\s\S]*?<time[^>]+datetime=["']([^"']+)["']/gi;
    let m, found = 0, minId = Infinity;
    while ((m = re.exec(html))) {
      const ts = toDateMs(m[2]);
      const id = Number(m[1]);
      if (ts) out.push({ id: `telegram:${user}:${id}`, ts });
      if (Number.isFinite(id)) { minId = Math.min(minId, id); found++; }
    }
    if (!found || !Number.isFinite(minId)) break;
    if (out.length && Math.min(...out.map(x => x.ts)) < cutoffMs(MAX_DAYS)) break;
    before = String(minId);
  }
  return out;
}

async function redditEvents(urlOrHandle) {
  let u = String(urlOrHandle || '').trim();
  if (!u) return [];
  let user = cleanHandle(u.replace(/^https?:\/\/(www\.)?reddit\.com\/user\//i, '').replace(/\/.*$/, ''));
  if (!user) return [];
  const out = [];
  for (const kind of ['submitted', 'comments']) {
    const url = `https://www.reddit.com/user/${encodeURIComponent(user)}/${kind}.json?limit=100`;
    try {
      const data = await fetchJson(url, { headers: { 'user-agent': 'XPRCORE-social-activity/1.0' }});
      const children = data?.data?.children || [];
      for (const item of children) {
        const ts = Number(item?.data?.created_utc) * 1000;
        if (Number.isFinite(ts) && ts >= cutoffMs(MAX_DAYS)) {
          out.push({ id: `reddit:${kind}:${item.data.id}`, ts });
        }
      }
    } catch {}
  }
  return out;
}

async function mediumEvents(urlOrHandle) {
  let u = String(urlOrHandle || '').trim();
  if (!u) return [];
  let handle = cleanHandle(u.replace(/^https?:\/\/medium\.com\/@/i, '').replace(/^@/, '').replace(/\/.*$/, ''));
  if (!handle) return [];
  try {
    const res = await fetch(`https://medium.com/feed/@${encodeURIComponent(handle)}`, {headers:{'user-agent':'XPRCORE-social-activity/1.0'}});
    if (!res.ok) return [];
    const xml = await res.text();
    const out = [];
    const re = /<item>[\s\S]*?<guid[^>]*>([\s\S]*?)<\/guid>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>[\s\S]*?<\/item>/gi;
    let m;
    while ((m = re.exec(xml))) {
      const ts = toDateMs(m[2]);
      if (ts && ts >= cutoffMs(MAX_DAYS)) out.push({id:`medium:${m[1].trim()}`, ts});
    }
    return out;
  } catch { return []; }
}

async function youtubeEvents(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const channelId = (raw.match(/channel\/([A-Za-z0-9_-]+)/) || [])[1] ||
                    (raw.match(/channel\/?([A-Za-z0-9_-]+)/) || [])[1];
  if (!channelId) return [];
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {headers:{'user-agent':'XPRCORE-social-activity/1.0'}});
    if (!res.ok) return [];
    const xml = await res.text();
    const out = [];
    const re = /<entry>[\s\S]*?<yt:videoId>([^<]+)<\/yt:videoId>[\s\S]*?<published>([^<]+)<\/published>[\s\S]*?<\/entry>/gi;
    let m;
    while ((m = re.exec(xml))) {
      const ts = toDateMs(m[2]);
      if (ts && ts >= cutoffMs(MAX_DAYS)) out.push({id:`youtube:${m[1]}`, ts});
    }
    return out;
  } catch { return []; }
}

function addUnique(target, events) {
  const map = new Map((target || []).map(e => [`${e.id}|${e.ts}`, e]));
  for (const e of events || []) if (e?.id && Number.isFinite(e.ts)) map.set(`${e.id}|${e.ts}`, e);
  return [...map.values()].sort((a,b) => a.ts - b.ts).filter(e => e.ts >= cutoffMs(MAX_DAYS));
}

function windows(events) {
  const now = Date.now();
  const count = days => events.filter(e => e.ts >= now - days*86400000).length;
  return { "7D": count(7), "30D": count(30), "1Y": count(365) };
}

async function main() {
  const bp = await readJson(BP_FILE, { producers: {} });
  const old = await readJson(OUT, { version: 1, producers: {} });
  const result = {
    version: 2,
    updatedAt: new Date().toISOString(),
    coverageStart: old.coverageStart || new Date().toISOString(),
    producerCount: 0,
    producers: {}
  };

  const producers = bp?.producers || {};
  for (const [owner, record] of Object.entries(producers)) {
    const existing = old.producers?.[owner] || { events: {} };
    const social = record?.social || {};
    const events = existing.events || {};

    const tasks = [];
    if (social.telegram) tasks.push(['telegram', telegramEvents(social.telegram)]);
    if (social.github) tasks.push(['github', githubEvents(social.github)]);
    if (social.youtube) tasks.push(['youtube', youtubeEvents(social.youtube)]);
    if (social.reddit) tasks.push(['reddit', redditEvents(social.reddit)]);
    if (social.medium) tasks.push(['medium', mediumEvents(social.medium)]);

    for (const [network, promise] of tasks) {
      try {
        const collected = await promise;
        if (Array.isArray(collected)) {
          events[network] = addUnique(events[network], collected);
        }
      } catch (err) {
        // Never let one broken/unavailable social profile stop all producers.
        console.warn(`${owner}: ${network} skipped: ${err?.message || err}`);
      }
    }

    const networkActivity = {};
    const all = [];
    for (const [network, ev] of Object.entries(events)) {
      if (!Array.isArray(ev)) continue;
      const w = windows(ev);
      const last = ev.length ? ev[ev.length - 1].ts : null;
      networkActivity[network] = { count: w, lastActivity: last ? new Date(last).toISOString() : null };
      all.push(...ev);
    }
    const uniqueAll = addUnique([], all);
    const w = windows(uniqueAll);
    const last = uniqueAll.length ? uniqueAll[uniqueAll.length - 1].ts : null;

    result.producers[owner] = {
      owner,
      social,
      activity: w,
      networkActivity,
      lastSocialActivity: last ? new Date(last).toISOString() : null,
      events
    };
  }

  result.producerCount = Object.keys(result.producers).length;
  await fs.writeFile(OUT, JSON.stringify(result, null, 2) + '\n');
  console.log(`saved social activity for ${result.producerCount} producers`);
}

main().catch(err => { console.error(err); process.exit(1); });
