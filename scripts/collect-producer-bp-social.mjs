import fs from 'node:fs/promises';

const OUT = new URL('../data/producer-bp-social.json', import.meta.url);
const OVERRIDES = new URL('../data/bp-url-overrides.json', import.meta.url);
const RPCS = [
  'https://proton.eosusa.io',
  'https://api.protonnz.com',
  'https://proton.protonuk.io',
  'https://proton.cryptolions.io',
  'https://proton.eoscafeblock.com',
  'https://api.totalproton.tech'
];
const XPR_CHAIN_ID = '384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0';
const FETCH_TIMEOUT = 12000;

const NETWORKS = [
  'telegram','twitter','github','youtube','facebook','keybase','reddit','discord',
  'wechat','medium','steemit','hive','instagram','linkedin','tiktok','mastodon'
];

const aliases = {
  telegram:'telegram', telegramurl:'telegram', telegramusername:'telegram', telegramchannel:'telegram',
  twitter:'twitter', twitterurl:'twitter', twitterusername:'twitter', x:'twitter', xurl:'twitter', xusername:'twitter',
  github:'github', githuburl:'github', githubusername:'github', githubuser:'github',
  youtube:'youtube', youtubeurl:'youtube', youtubechannel:'youtube', youtubeusername:'youtube',
  facebook:'facebook', facebookurl:'facebook', facebookpage:'facebook', facebookusername:'facebook',
  keybase:'keybase', keybaseurl:'keybase', keybaseusername:'keybase',
  reddit:'reddit', redditurl:'reddit', redditusername:'reddit',
  discord:'discord', discordurl:'discord', discordusername:'discord',
  wechat:'wechat', wechaturl:'wechat', wechatusername:'wechat',
  medium:'medium', mediumurl:'medium', mediumusername:'medium',
  steemit:'steemit', steemiturl:'steemit', steemitusername:'steemit',
  hive:'hive', hiveurl:'hive', hiveusername:'hive',
  instagram:'instagram', instagramurl:'instagram', instagramusername:'instagram',
  linkedin:'linkedin', linkedinurl:'linkedin', linkedinusername:'linkedin',
  tiktok:'tiktok', tiktokurl:'tiktok', tiktokusername:'tiktok',
  mastodon:'mastodon', mastodonurl:'mastodon', mastodonusername:'mastodon'
};

function timeoutSignal(ms = FETCH_TIMEOUT) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function fetchText(url, options = {}) {
  const { signal, done } = timeoutSignal();
  try {
    const r = await fetch(url, {
      ...options,
      signal,
      headers: { 'user-agent': 'XPRCORE producer-bp-social/1.1', 'accept': 'text/html,application/json,*/*', ...(options.headers || {}) }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { done(); }
}

async function fetchJson(url, options = {}) {
  const { signal, done } = timeoutSignal();
  try {
    const r = await fetch(url, {
      ...options,
      signal,
      headers: { 'user-agent': 'XPRCORE producer-bp-social/1.0', 'accept': 'application/json', ...(options.headers || {}) }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { done(); }
}

async function rpc(path, body) {
  for (const base of RPCS) {
    try {
      const data = await fetchJson(base + path, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
      if (data?.error) throw new Error(data.error.what || 'RPC error');
      return data;
    } catch {}
  }
  throw new Error('No XPR RPC endpoint available');
}

function normalizeUrl(v) {
  try {
    const u = new URL(String(v || '').trim());
    if (!/^https?:$/i.test(u.protocol)) return '';
    return u.href;
  } catch { return ''; }
}
function originOf(v) {
  try { const u = new URL(v); return u.origin; } catch { return ''; }
}
function normalizeAccount(v) { return String(v || '').trim().toLowerCase(); }

function extractBPJsonURL(chains, origin) {
  if (!chains || typeof chains !== 'object') return '';
  const found = [];
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const x of value) walk(x); return; }
    let s = '';
    try { s = JSON.stringify(value).toLowerCase(); } catch {}
    if (s.includes(XPR_CHAIN_ID)) found.push(value);
    for (const key of Object.keys(value)) walk(value[key]);
  }
  walk(chains);
  for (const item of found) {
    for (const key of ['bp_json','bpJson','bp_json_url','bpJsonUrl','producer_json','producerJson','url','href']) {
      const candidate = item?.[key];
      if (typeof candidate !== 'string' || !candidate.trim()) continue;
      try { return new URL(candidate.trim(), origin + '/').href; } catch {}
    }
  }
  return '';
}

function makeSocial(network, value) {
  if (typeof value !== 'string') return '';
  let v = value.trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (network === 'telegram' && (v.startsWith('+') || v.startsWith('-100'))) return `https://t.me/${v}`;
  if (network === 'mastodon' && v.includes('@')) return `https://${v.replace(/^@/, '')}`;
  v = v.replace(/^@/, '').replace(/^\/+|\/+$/g, '');
  const roots = {
    telegram:'https://t.me/', twitter:'https://x.com/', github:'https://github.com/', youtube:'https://www.youtube.com/@',
    facebook:'https://www.facebook.com/', keybase:'https://keybase.io/', reddit:'https://www.reddit.com/user/',
    discord:'https://discord.com/users/', wechat:'https://www.wechat.com/', medium:'https://medium.com/@',
    steemit:'https://steemit.com/@', hive:'https://peakd.com/@', instagram:'https://www.instagram.com/',
    linkedin:'https://www.linkedin.com/in/', tiktok:'https://www.tiktok.com/@', mastodon:'https://'
  };
  return roots[network] ? roots[network] + v : '';
}

function socialFromBP(bp) {
  const out = {};
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const x of value) walk(x); return; }
    for (const [key, val] of Object.entries(value)) {
      const nk = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
      const network = aliases[nk];
      if (network && !out[network]) {
        const values = Array.isArray(val) ? val : [val];
        for (const item of values) {
          if (typeof item !== 'string') continue;
          const u = makeSocial(network, item);
          if (u) { out[network] = u; break; }
        }
      }
      if (val && typeof val === 'object') walk(val);
    }
  }
  walk(bp?.org?.social || bp?.org?.socials || bp?.social || bp?.socials || bp);

  // The BP standard defines org.github_user separately from org.social.
  // Treat it as the producer's GitHub profile so producers such as EOSUSA
  // are not shown as having no social presence.
  if (!out.github) {
    const githubValue = bp?.org?.github_user ?? bp?.github_user;
    const values = Array.isArray(githubValue) ? githubValue : [githubValue];
    for (const item of values) {
      if (typeof item !== 'string' || !item.trim()) continue;
      const u = makeSocial('github', item);
      if (u) { out.github = u; break; }
    }
  }

  return out;
}

function addCandidate(list, value, base) {
  try {
    const u = new URL(String(value || '').trim(), base);
    if (!/^https?:$/i.test(u.protocol)) return;
    list.push(u.href);
  } catch {}
}

function pathCandidates(website, owner) {
  const out = [];
  try {
    const u = new URL(website);
    const path = u.pathname.replace(/\/+$/, '');
    const parts = path.split('/').filter(Boolean);
    const last = parts.at(-1) || '';

    // If the registered URL already points to a JSON file, try it directly.
    if (/\.json$/i.test(path)) out.push(u.href);

    // Standard and common XPR/Antelope variants.
    out.push(new URL('/bp.json', u.origin).href);
    out.push(new URL('/.well-known/bp.json', u.origin).href);
    out.push(new URL('/proton.json', u.origin).href);
    out.push(new URL('/xpr.json', u.origin).href);

    // Preserve the producer's registered path. This catches e.g. /cafe/bp.json,
    // /proton/bp.json and /bp/proton/bp.json without a per-producer rule.
    if (path) {
      out.push(new URL(path + (path.endsWith('.json') ? '' : '/bp.json'), u.origin).href);
      out.push(new URL(path + (path.endsWith('.json') ? '' : '/proton.json'), u.origin).href);
      out.push(new URL(path + (path.endsWith('.json') ? '' : '/xpr.json'), u.origin).href);
      if (last) {
        out.push(new URL(`/${last}.json`, u.origin).href);
        out.push(new URL(`/${last}/bp.json`, u.origin).href);
      }
    }

    // A few safe account-derived filenames help with new producers using
    // account-specific JSON files.
    const account = normalizeAccount(owner);
    if (account) {
      out.push(new URL(`/${account}.json`, u.origin).href);
      out.push(new URL(`/${account}/bp.json`, u.origin).href);
    }
  } catch {}
  return out;
}

async function discoverFromHtml(website) {
  try {
    const html = await fetchText(website);
    const urls = [];
    const re = /(?:href|src)=[\"']([^\"']+)[\"']/gi;
    let m;
    while ((m = re.exec(html)) && urls.length < 40) {
      const raw = m[1];
      if (!/\.json(?:[?#]|$)/i.test(raw)) continue;
      if (!/(bp|proton|xpr|producer|chain)/i.test(raw)) continue;
      addCandidate(urls, raw, website);
    }
    return urls;
  } catch { return []; }
}

async function loadOverrides() {
  try {
    const raw = await fs.readFile(OVERRIDES, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

async function readBP(producer, overrides = {}) {
  const website = normalizeUrl(producer.url);
  const origin = originOf(website);
  if (!origin) return { social: {}, bpUrl: null, error: 'invalid producer url' };

  const urls = [];
  const known = overrides[normalizeAccount(producer.owner)];
  if (typeof known === 'string' && known.trim()) urls.push(known.trim());
  else if (Array.isArray(known)) urls.push(...known.filter(x => typeof x === 'string' && x.trim()));

  // First use the registered URL itself/path and the standard root locations.
  urls.push(...pathCandidates(website, producer.owner));

  // Standard chains.json can explicitly map the XPR chain to a producer JSON.
  for (const base of [origin, website.replace(/\/+$/, '')]) {
    try {
      const chains = await fetchJson(base + '/chains.json');
      const chainBP = extractBPJsonURL(chains, base);
      if (chainBP) urls.unshift(chainBP);
    } catch {}
  }

  // Last discovery step: inspect the producer website for linked JSON files.
  urls.push(...await discoverFromHtml(website));

  for (const bpUrl of [...new Set(urls)]) {
    try {
      const bp = await fetchJson(bpUrl);
      if (!bp || typeof bp !== 'object') continue;
      const bpAccount = normalizeAccount(bp.producer_account_name || bp.producerAccountName || bp.owner || bp.producer);
      if (bpAccount && bpAccount !== normalizeAccount(producer.owner)) continue;
      const social = socialFromBP(bp);
      const looksLikeBP = Boolean(bpAccount) || Object.keys(social).length > 0 || Boolean(bp.org);
      if (!looksLikeBP) continue;
      return { social, bpUrl, website: origin };
    } catch {}
  }
  return { social: {}, bpUrl: null, website: origin, error: 'bp.json unavailable' };
}

async function main() {
  const result = await rpc('/v1/chain/get_table_rows', { json:true, code:'eosio', scope:'eosio', table:'producers', limit:1000 });
  const active = (result.rows || [])
    .filter(p => Boolean(p.is_active))
    .sort((a,b) => Number(a.rank || 999999) - Number(b.rank || 999999));

  const overrides = await loadOverrides();
  const records = {};
  for (const p of active) {
    const bp = await readBP(p, overrides);
    records[p.owner] = {
      owner: p.owner,
      rank: Number.isFinite(Number(p.rank)) ? Number(p.rank) : null,
      website: p.url || null,
      bpUrl: bp.bpUrl,
      social: bp.social,
      fetchedAt: new Date().toISOString(),
      error: bp.error || null
    };
  }

  const payload = {
    version: 2,
    chainId: XPR_CHAIN_ID,
    updatedAt: new Date().toISOString(),
    producerCount: active.length,
    producers: records
  };
  await fs.writeFile(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`saved ${active.length} active producers to ${OUT.pathname}`);
}

main().catch(err => { console.error(err); process.exit(1); });
