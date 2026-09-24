import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BP_FILE = path.join(ROOT, 'data', 'producer-bp-social.json');
const OUT_FILE = path.join(ROOT, 'data', 'producer-social-activity.json');

const MAX_DAYS = 365;
const FETCH_TIMEOUT_MS = 15_000;

const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  '';

const USER_AGENT =
  'XPR-block-producer-social-activity/1.0 (+https://github.com/xprcore/XPR-block-producer)';

const NETWORKS = [
  'github',
  'telegram',
  'youtube',
  'reddit',
  'medium',
];

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return _;
      }
    })
    .trim();
}

function normalizeTimestamp(value) {
  if (!value) return null;

  const ms = Date.parse(value);

  if (!Number.isNaN(ms)) {
    return new Date(ms).toISOString();
  }

  const numeric = Number(value);

  if (Number.isFinite(numeric)) {
    const millis = numeric < 10_000_000_000
      ? numeric * 1000
      : numeric;

    const d = new Date(millis);

    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }

  return null;
}

function eventTimestamp(event) {
  return normalizeTimestamp(
    event?.timestamp ??
    event?.date ??
    event?.createdAt ??
    event?.created_at ??
    event?.published ??
    event?.updated
  );
}

function eventKey(network, event) {
  if (event?.id) {
    return `${network}:${event.id}`;
  }

  if (event?.url && event?.timestamp) {
    return `${network}:${event.url}:${event.timestamp}`;
  }

  if (event?.url) {
    return `${network}:${event.url}`;
  }

  return `${network}:${JSON.stringify(event)}`;
}

function normalizeEvent(network, event) {
  const timestamp = eventTimestamp(event);

  if (!timestamp) {
    return null;
  }

  const normalized = {
    ...event,
    timestamp,
  };

  if (!normalized.id && normalized.url) {
    normalized.id = normalized.url;
  }

  normalized._key = eventKey(network, normalized);

  return normalized;
}

function mergeEvents(network, oldEvents, newEvents) {
  const map = new Map();

  for (const event of [
    ...(Array.isArray(oldEvents) ? oldEvents : []),
    ...(Array.isArray(newEvents) ? newEvents : []),
  ]) {
    const normalized = normalizeEvent(network, event);

    if (!normalized) continue;

    const key = normalized._key;

    delete normalized._key;

    map.set(key, normalized);
  }

  const cutoff =
    Date.now() -
    MAX_DAYS * 24 * 60 * 60 * 1000;

  return [...map.values()]
    .filter((event) => {
      const ts = Date.parse(event.timestamp);
      return Number.isFinite(ts) && ts >= cutoff;
    })
    .sort(
      (a, b) =>
        Date.parse(b.timestamp) -
        Date.parse(a.timestamp)
    );
}

function windows(events) {
  const now = Date.now();

  const result = {
    '7D': 0,
    '30D': 0,
    '1Y': 0,
  };

  for (const event of events) {
    const ts = Date.parse(event.timestamp);

    if (!Number.isFinite(ts)) continue;

    const age = now - ts;

    if (age <= 7 * 24 * 60 * 60 * 1000) {
      result['7D']++;
    }

    if (age <= 30 * 24 * 60 * 60 * 1000) {
      result['30D']++;
    }

    if (age <= 365 * 24 * 60 * 60 * 1000) {
      result['1Y']++;
    }
  }

  return result;
}

function maxTimestamp(...groups) {
  let latest = null;

  for (const group of groups) {
    for (const event of group || []) {
      const ts = eventTimestamp(event);

      if (!ts) continue;

      if (!latest || Date.parse(ts) > Date.parse(latest)) {
        latest = ts;
      }
    }
  }

  return latest;
}

function extractHandle(value) {
  if (!value) return null;

  let input = String(value).trim();

  if (!input) return null;

  if (!/^https?:\/\//i.test(input)) {
    input = `https://${input}`;
  }

  try {
    const url = new URL(input);

    const parts = url.pathname
      .split('/')
      .map((x) => x.trim())
      .filter(Boolean);

    if (!parts.length) return null;

    if (
      parts[0].toLowerCase() === 's' &&
      parts[1]
    ) {
      return parts[1].replace(/^@/, '');
    }

    return parts[0].replace(/^@/, '');
  } catch {
    return input
      .replace(/^@/, '')
      .replace(/^.*\/\//, '')
      .split('/')
      .filter(Boolean)
      .pop()
      ?.replace(/^@/, '') || null;
  }
}

function isPrivateTelegram(value) {
  const text = String(value || '');

  return (
    text.includes('t.me/+') ||
    text.includes('telegram.me/+') ||
    text.includes('joinchat/')
  );
}

function youtubeChannelIdFromValue(value) {
  if (!value) return null;

  const text = String(value).trim();

  const match = text.match(
    /\b(UC[a-zA-Z0-9_-]{20,})\b/
  );

  return match ? match[1] : null;
}

function youtubeHandleFromValue(value) {
  if (!value) return null;

  const text = String(value).trim();

  const match = text.match(
    /youtube\.com\/@([^/?#]+)/i
  );

  if (match) {
    return `@${match[1]}`;
  }

  const plain = text.match(/^@([a-zA-Z0-9._-]+)$/);

  if (plain) {
    return `@${plain[1]}`;
  }

  return null;
}

async function fetchText(
  url,
  {
    headers = {},
    timeoutMs = FETCH_TIMEOUT_MS,
  } = {}
) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        ...headers,
      },
    });

    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      text,
      url: response.url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function githubEvents(username) {
  const clean = extractHandle(username);

  if (!clean) {
    return {
      status: 'UNSUPPORTED',
      events: [],
      detail: 'Invalid GitHub profile',
    };
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
  };

  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  const url =
    `https://api.github.com/users/${encodeURIComponent(clean)}/events/public?per_page=100`;

  let response;

  try {
    response = await fetchText(url, {
      headers,
    });
  } catch (error) {
    return {
      status: 'ERROR',
      events: [],
      detail: error?.message || 'GitHub request failed',
    };
  }

  if (response.status === 404) {
    return {
      status: 'NOT_FOUND',
      events: [],
      detail: `GitHub user not found: ${clean}`,
    };
  }

  if (
    response.status === 403 ||
    response.status === 429
  ) {
    const retryAfter =
      response.headers.get('retry-after');

    return {
      status: 'RATE_LIMITED',
      events: [],
      detail:
        `GitHub rate limit (${response.status})` +
        (retryAfter
          ? `; retry-after=${retryAfter}s`
          : ''),
    };
  }

  if (!response.ok) {
    return {
      status: 'ERROR',
      events: [],
      detail: `GitHub HTTP ${response.status}`,
    };
  }

  let data;

  try {
    data = JSON.parse(response.text);
  } catch {
    return {
      status: 'ERROR',
      events: [],
      detail: 'Invalid GitHub JSON response',
    };
  }

  if (!Array.isArray(data)) {
    return {
      status: 'ERROR',
      events: [],
      detail: 'Unexpected GitHub response',
    };
  }

  const events = [];

  for (const item of data) {
    const timestamp = normalizeTimestamp(
      item.created_at
    );

    if (!timestamp) continue;

    const repoName =
      item?.repo?.name ||
      '';

    const type =
      item?.type ||
      'GitHubEvent';

    const actor =
      item?.actor?.login ||
      clean;

    const eventId =
      item?.id ||
      `${repoName}:${timestamp}:${type}`;

    events.push({
      id: eventId,
      timestamp,
      type,
      actor,
      repo: repoName,
      title: `${type} — ${repoName || actor}`,
      url: repoName
        ? `https://github.com/${repoName}`
        : `https://github.com/${actor}`,
    });
  }

  return {
    status: events.length
      ? 'OK'
      : 'NO_ACTIVITY',
    events,
    detail: events.length
      ? `${events.length} public events`
      : 'No public GitHub events returned',
  };
}

async function telegramEvents(value) {
  if (isPrivateTelegram(value)) {
    return {
      status: 'UNSUPPORTED',
      events: [],
      detail:
        'Private/invite Telegram link cannot be read without joining the channel',
    };
  }

  const handle = extractHandle(value);

  if (!handle) {
    return {
      status: 'UNSUPPORTED',
      events: [],
      detail: 'Invalid Telegram channel URL',
    };
  }

  const url =
    `https://t.me/s/${encodeURIComponent(handle)}`;

  let response;

  try {
    response = await fetchText(url, {
      headers: {
        Accept:
          'text/html,application/xhtml+xml',
      },
    });
  } catch (error) {
    return {
      status: 'ERROR',
      events: [],
      detail:
        error?.message ||
        'Telegram request failed',
    };
  }

  if (
    response.status === 403 ||
    response.status === 429
  ) {
    return {
      status: 'RATE_LIMITED',
      events: [],
      detail:
        `Telegram HTTP ${response.status}`,
    };
  }

  if (response.status === 404) {
    return {
      status: 'NOT_FOUND',
      events: [],
      detail:
        `Telegram channel not found: ${handle}`,
    };
  }

  if (!response.ok) {
    return {
      status: 'ERROR',
      events: [],
      detail:
        `Telegram HTTP ${response.status}`,
    };
  }

  const html = response.text;

  const events = [];

  /*
   * Telegram public channel preview contains blocks like:
   *
   * <a class="tgme_widget_message_date"
   *    href="https://t.me/channel/123">
   *   <time datetime="2026-09-24T12:34:56+00:00"></time>
   * </a>
   */

  const dateRegex =
    /<a[^>]+class="tgme_widget_message_date"[^>]+href="([^"]+)"[^>]*>[\s\S]*?<time[^>]+datetime="([^"]+)"/gi;

  let match;

  while ((match = dateRegex.exec(html))) {
    const postUrl = decodeHtml(match[1]);
    const timestamp = normalizeTimestamp(match[2]);

    if (!timestamp || !postUrl) continue;

    const messageId =
      postUrl.split('/').pop() ||
      `${timestamp}`;

    const start =
      Math.max(
        0,
        html.lastIndexOf(
          'tgme_widget_message',
          match.index
        )
      );

    const chunk =
      html.slice(start, match.index);

    let title = '';

    const textMatch =
      chunk.match(
        /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i
      );

    if (textMatch) {
      title = cleanText(
        decodeHtml(textMatch[1])
      ).slice(0, 200);
    }

    events.push({
      id: messageId,
      timestamp,
      type: 'post',
      title:
        title ||
        `Telegram post ${messageId}`,
      url: postUrl,
    });
  }

  const unique = mergeEvents(
    'telegram',
    [],
    events
  );

  return {
    status: unique.length
      ? 'OK'
      : 'NO_ACTIVITY',
    events: unique,
    detail: unique.length
      ? `${unique.length} public Telegram posts found`
      : 'No public Telegram posts found in current feed',
  };
}

async function resolveYoutubeChannelId(value) {
  const direct =
    youtubeChannelIdFromValue(value);

  if (direct) {
    return {
      status: 'OK',
      channelId: direct,
    };
  }

  const handle =
    youtubeHandleFromValue(value);

  let url = String(value || '').trim();

  /*
   * Support:
   *   https://youtube.com/@channel
   *   https://youtube.com/@channel/UCxxxx
   *   @channel
   *   https://youtube.com/c/name
   *   https://youtube.com/user/name
   */

  if (handle) {
    url =
      `https://www.youtube.com/${handle}`;
  } else if (
    /^@/.test(url)
  ) {
    url =
      `https://www.youtube.com/${url}`;
  }

  if (
    !/^https?:\/\//i.test(url)
  ) {
    url =
      `https://www.youtube.com/${url.replace(/^\/+/, '')}`;
  }

  let response;

  try {
    response = await fetchText(url, {
      headers: {
        Accept:
          'text/html,application/xhtml+xml',
      },
    });
  } catch (error) {
    return {
      status: 'ERROR',
      detail:
        error?.message ||
        'YouTube channel lookup failed',
    };
  }

  if (response.status === 404) {
    return {
      status: 'NOT_FOUND',
      detail:
        `YouTube channel not found: ${value}`,
    };
  }

  if (!response.ok) {
    return {
      status: 'ERROR',
      detail:
        `YouTube channel lookup HTTP ${response.status}`,
    };
  }

  const html = response.text;

  const patterns = [
    /"channelId":"(UC[a-zA-Z0-9_-]{20,})"/,
    /"externalId":"(UC[a-zA-Z0-9_-]{20,})"/,
    /<meta[^>]+itemprop="channelId"[^>]+content="(UC[a-zA-Z0-9_-]{20,})"/i,
    /<link[^>]+itemprop="url"[^>]+href="https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{20,})"/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match?.[1]) {
      return {
        status: 'OK',
        channelId: match[1],
      };
    }
  }

  return {
    status: 'NOT_FOUND',
    detail:
      `Could not resolve YouTube channel ID: ${value}`,
  };
}

async function youtubeEvents(value) {
  const resolved =
    await resolveYoutubeChannelId(value);

  if (resolved.status !== 'OK') {
    return {
      status: resolved.status,
      events: [],
      detail: resolved.detail,
    };
  }

  const channelId =
    resolved.channelId;

  const url =
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;

  let response;

  try {
    response = await fetchText(url, {
      headers: {
        Accept:
          'application/atom+xml,application/xml,text/xml',
      },
    });
  } catch (error) {
    return {
      status: 'ERROR',
      events: [],
      detail:
        error?.message ||
        'YouTube feed request failed',
    };
  }

  if (response.status === 404) {
    return {
      status: 'NOT_FOUND',
      events: [],
      detail:
        `YouTube feed not found for ${channelId}`,
    };
  }

  if (!response.ok) {
    return {
      status: 'ERROR',
      events: [],
      detail:
        `YouTube HTTP ${response.status}`,
    };
  }

  const xml = response.text;

  const events = [];

  const entryRegex =
    /<entry>([\s\S]*?)<\/entry>/gi;

  let entryMatch;

  while ((entryMatch = entryRegex.exec(xml))) {
    const entry = entryMatch[1];

    const videoId =
      entry.match(
        /<yt:videoId>([^<]+)<\/yt:videoId>/i
      )?.[1] ||
      entry.match(
        /<id>yt:video:([^<]+)<\/id>/i
      )?.[1];

    const published =
      entry.match(
        /<published>([^<]+)<\/published>/i
      )?.[1];

    const title =
      entry.match(
        /<title>([\s\S]*?)<\/title>/i
      )?.[1];

    if (!videoId || !published) {
      continue;
    }

    const timestamp =
      normalizeTimestamp(published);

    if (!timestamp) continue;

    events.push({
      id: videoId,
      timestamp,
      type: 'video',
      title: cleanText(
        decodeHtml(title || 'YouTube video')
      ),
      url:
        `https://www.youtube.com/watch?v=${videoId}`,
      channelId,
    });
  }

  return {
    status: events.length
      ? 'OK'
      : 'NO_ACTIVITY',
    events,
    detail: events.length
      ? `${events.length} YouTube videos found`
      : 'No YouTube videos in current feed',
  };
}

function extractRssEntries(xml) {
  const entries = [];

  const entryRegex =
    /<item>([\s\S]*?)<\/item>/gi;

  let match;

  while ((match = entryRegex.exec(xml))) {
    const item = match[1];

    const title =
      item.match(
        /<title>([\s\S]*?)<\/title>/i
      )?.[1];

    const link =
      item.match(
        /<link>([\s\S]*?)<\/link>/i
      )?.[1];

    const guid =
      item.match(
        /<guid[^>]*>([\s\S]*?)<\/guid>/i
      )?.[1];

    const pubDate =
      item.match(
        /<pubDate>([\s\S]*?)<\/pubDate>/i
      )?.[1];

    const published =
      item.match(
        /<published>([\s\S]*?)<\/published>/i
      )?.[1] ||
      item.match(
        /<dc:date>([\s\S]*?)<\/dc:date>/i
      )?.[1] ||
      pubDate;

    entries.push({
      id: cleanText(
        decodeHtml(guid || link || '')
      ),
      title: cleanText(
        decodeHtml(title || '')
      ),
      url: cleanText(
        decodeHtml(link || '')
      ),
      timestamp:
        normalizeTimestamp(
          cleanText(
            decodeHtml(published || '')
          )
        ),
    });
  }

  return entries;
}

function extractAtomEntries(xml) {
  const entries = [];

  const entryRegex =
    /<entry>([\s\S]*?)<\/entry>/gi;

  let match;

  while ((match = entryRegex.exec(xml))) {
    const entry = match[1];

    const id =
      entry.match(
        /<id>([\s\S]*?)<\/id>/i
      )?.[1];

    const title =
      entry.match(
        /<title[^>]*>([\s\S]*?)<\/title>/i
      )?.[1];

    const published =
      entry.match(
        /<published>([\s\S]*?)<\/published>/i
      )?.[1] ||
      entry.match(
        /<updated>([\s\S]*?)<\/updated>/i
      )?.[1];

    const link =
      entry.match(
        /<link[^>]+href="([^"]+)"/i
      )?.[1];

    entries.push({
      id: cleanText(
        decodeHtml(id || link || '')
      ),
      title: cleanText(
        decodeHtml(title || '')
      ),
      url: cleanText(
        decodeHtml(link || '')
      ),
      timestamp:
        normalizeTimestamp(
          cleanText(
            decodeHtml(published || '')
          )
        ),
    });
  }

  return entries;
}

async function redditEvents(username) {
  const clean = extractHandle(username);

  if (!clean) {
    return {
      status: 'UNSUPPORTED',
      events: [],
      detail: 'Invalid Reddit username',
    };
  }

  /*
   * Use Reddit's public RSS representation first.
   * This avoids treating temporary JSON/API 429s
   * as "no activity".
   */

  const url =
    `https://www.reddit.com/user/${encodeURIComponent(clean)}/submitted.rss?limit=100`;

  let response;

  try {
    response = await fetchText(url, {
      headers: {
        Accept:
          'application/rss+xml,application/xml,text/xml',
      },
    });
  } catch (error) {
    return {
      status: 'ERROR',
      events: [],
      detail:
        error?.message ||
        'Reddit request failed',
    };
  }

  if (
    response.status === 403 ||
    response.status === 429
  ) {
    return {
      status: 'RATE_LIMITED',
      events: [],
      detail:
        `Reddit HTTP ${response.status}`,
    };
  }

  if (response.status === 404) {
    return {
      status: 'NOT_FOUND',
      events: [],
      detail:
        `Reddit user not found: ${clean}`,
    };
  }

  if (!response.ok) {
    return {
      status: 'ERROR',
      events: [],
      detail:
        `Reddit HTTP ${response.status}`,
    };
  }

  const xml = response.text;

  const raw =
    extractRssEntries(xml);

  const events = raw
    .filter((item) => item.timestamp)
    .map((item) => ({
      id:
        item.id ||
        item.url,
      timestamp:
        item.timestamp,
      type: 'submission',
      title:
        item.title ||
        `Reddit activity by ${clean}`,
      url:
        item.url ||
        `https://www.reddit.com/user/${clean}`,
      username: clean,
    }));

  return {
    status: events.length
      ? 'OK'
      : 'NO_ACTIVITY',
    events,
    detail: events.length
      ? `${events.length} Reddit submissions found`
      : 'No Reddit submissions returned',
  };
}

async function mediumEvents(username) {
  const clean = extractHandle(username);

  if (!clean) {
    return {
      status: 'UNSUPPORTED',
      events: [],
      detail: 'Invalid Medium username',
    };
  }

  const candidates = [
    `https://medium.com/feed/@${encodeURIComponent(clean)}`,
    `https://medium.com/feed/${encodeURIComponent(clean)}`,
  ];

  let lastStatus = null;

  for (const url of candidates) {
    let response;

    try {
      response = await fetchText(url, {
        headers: {
          Accept:
            'application/rss+xml,application/xml,text/xml',
        },
      });
    } catch (error) {
      return {
        status: 'ERROR',
        events: [],
        detail:
          error?.message ||
          'Medium request failed',
      };
    }

    lastStatus = response.status;

    if (response.status === 404) {
      continue;
    }

    if (
      response.status === 403 ||
      response.status === 429
    ) {
      return {
        status: 'RATE_LIMITED',
        events: [],
        detail:
          `Medium HTTP ${response.status}`,
      };
    }

    if (!response.ok) {
      continue;
    }

    const raw =
      extractRssEntries(response.text);

    const events = raw
      .filter((item) => item.timestamp)
      .map((item) => ({
        id:
          item.id ||
          item.url,
        timestamp:
          item.timestamp,
        type: 'article',
        title:
          item.title ||
          `Medium article by ${clean}`,
        url:
          item.url ||
          `https://medium.com/@${clean}`,
        username: clean,
      }));

    return {
      status: events.length
        ? 'OK'
        : 'NO_ACTIVITY',
      events,
      detail: events.length
        ? `${events.length} Medium articles found`
        : 'No Medium articles returned',
    };
  }

  return {
    status: 'NOT_FOUND',
    events: [],
    detail:
      `Medium profile/feed not found: ${clean} (last HTTP ${lastStatus})`,
  };
}

function networkStatusObject(
  status,
  detail,
  events
) {
  const count = windows(events);

  return {
    count,
    lastActivity:
      events[0]?.timestamp ||
      null,
    status,
    detail,
    checkedAt: nowIso(),
  };
}

async function loadJson(file, fallback) {
  try {
    const raw =
      await fs.readFile(file, 'utf8');

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function saveJson(file, data) {
  await fs.mkdir(
    path.dirname(file),
    { recursive: true }
  );

  await fs.writeFile(
    file,
    `${JSON.stringify(data, null, 2)}\n`,
    'utf8'
  );
}

function networkFunction(network) {
  switch (network) {
    case 'github':
      return githubEvents;

    case 'telegram':
      return telegramEvents;

    case 'youtube':
      return youtubeEvents;

    case 'reddit':
      return redditEvents;

    case 'medium':
      return mediumEvents;

    default:
      return null;
  }
}

function printProducerHeader(owner) {
  console.log(`\n[${owner}]`);
}

async function collectProducer(
  owner,
  record,
  oldProducer
) {
  const social =
    record?.social || {};

  const oldEvents =
    oldProducer?.events || {};

  const events = {};
  const networkActivity = {};
  const diagnostics = {
    checkedAt: nowIso(),
    networks: {},
  };

  let totalNewEvents = 0;

  for (const network of NETWORKS) {
    const profile =
      social?.[network];

    if (!profile) {
      continue;
    }

    const fn =
      networkFunction(network);

    if (!fn) {
      continue;
    }

    printProducerHeader(owner);

    console.log(
      `  ${network.padEnd(9)} checking ${profile}`
    );

    let result;

    try {
      result =
        await fn(profile);
    } catch (error) {
      result = {
        status: 'ERROR',
        events: [],
        detail:
          error?.message ||
          'Unexpected collector error',
      };
    }

    const oldNetworkEvents =
      Array.isArray(oldEvents[network])
        ? oldEvents[network]
        : [];

    /*
     * IMPORTANT:
     *
     * We always merge old + new events.
     * Therefore a temporary 429/error never
     * destroys existing activity history.
     */

    const merged =
      mergeEvents(
        network,
        oldNetworkEvents,
        result.events || []
      );

    const newCount =
      (result.events || []).length;

    totalNewEvents += newCount;

    events[network] = merged;

    networkActivity[network] =
      networkStatusObject(
        result.status,
        result.detail,
        merged
      );

    diagnostics.networks[network] = {
      source: profile,
      status: result.status,
      detail: result.detail,
      fetchedEvents: newCount,
      storedEvents: merged.length,
      checkedAt: nowIso(),
    };

    console.log(
      `  ${network.padEnd(9)} ${result.status.padEnd(13)} ` +
      `${newCount} new / ${merged.length} stored` +
      (
        result.detail
          ? ` — ${result.detail}`
          : ''
      )
    );

    /*
     * Small delay between sources to reduce
     * accidental burst/rate-limit behaviour.
     */
    await sleep(150);
  }

  /*
   * Preserve networks that existed previously
   * but aren't present in the current BP record.
   */
  for (const network of NETWORKS) {
    if (
      events[network] === undefined &&
      Array.isArray(oldEvents[network])
    ) {
      events[network] =
        mergeEvents(
          network,
          oldEvents[network],
          []
        );

      networkActivity[network] =
        networkStatusObject(
          'NOT_CHECKED',
          'No profile configured in BP social record',
          events[network]
        );
    }
  }

  const allEvents = Object.values(events)
    .flat()
    .filter(Boolean)
    .sort(
      (a, b) =>
        Date.parse(b.timestamp) -
        Date.parse(a.timestamp)
    );

  const activity =
    windows(allEvents);

  const lastSocialActivity =
    allEvents[0]?.timestamp ||
    null;

  const producer = {
    owner,
    activity,
    networkActivity,
    lastSocialActivity,
    events,
    diagnostics,
  };

  return {
    producer,
    newEvents: totalNewEvents,
    allEvents,
  };
}

function makeNetworkSummary(producers) {
  const summary = {};

  for (const producer of Object.values(producers)) {
    for (const [network, info] of Object.entries(
      producer?.networkActivity || {}
    )) {
      if (!summary[network]) {
        summary[network] = {
          OK: 0,
          NO_ACTIVITY: 0,
          NOT_FOUND: 0,
          RATE_LIMITED: 0,
          UNSUPPORTED: 0,
          ERROR: 0,
          NOT_CHECKED: 0,
        };
      }

      const status =
        info?.status ||
        'ERROR';

      if (
        summary[network][status] === undefined
      ) {
        summary[network][status] = 0;
      }

      summary[network][status]++;
    }
  }

  return summary;
}

function printSummary(
  producers,
  diagnostics
) {
  let withActivity = 0;
  let withoutActivity = 0;

  for (const producer of Object.values(producers)) {
    const oneYear =
      producer?.activity?.['1Y'] || 0;

    if (oneYear > 0) {
      withActivity++;
    } else {
      withoutActivity++;
    }
  }

  console.log('\n');
  console.log('='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  console.log(
    `Producers checked ${Object.keys(producers).length}`
  );

  console.log(
    `With activity     ${withActivity}`
  );

  console.log(
    `Without activity  ${withoutActivity}`
  );

  console.log(
    `New events        ${diagnostics.newEvents}`
  );

  console.log('\nNetwork summary:');

  const networkSummary =
    makeNetworkSummary(producers);

  for (const network of Object.keys(networkSummary).sort()) {
    const s =
      networkSummary[network];

    console.log(
      ` ${network.padEnd(9)} ` +
      `OK=${s.OK || 0} ` +
      `NO_ACTIVITY=${s.NO_ACTIVITY || 0} ` +
      `NOT_FOUND=${s.NOT_FOUND || 0} ` +
      `RATE_LIMITED=${s.RATE_LIMITED || 0} ` +
      `UNSUPPORTED=${s.UNSUPPORTED || 0} ` +
      `ERROR=${s.ERROR || 0}`
    );
  }

  console.log('='.repeat(70));
}

async function main() {
  console.log(
    'Collecting producer social activity...'
  );

  console.log(
    `Started: ${nowIso()}`
  );

  const bp =
    await loadJson(
      BP_FILE,
      { producers: {} }
    );

  const old =
    await loadJson(
      OUT_FILE,
      {
        version: 2,
        producers: {},
      }
    );

  const producers =
    bp?.producers || {};

  const oldProducers =
    old?.producers || {};

  const outputProducers = {};

  let totalNewEvents = 0;

  const ownerNames =
    Object.keys(producers).sort();

  console.log(
    `Producers found: ${ownerNames.length}`
  );

  for (const owner of ownerNames) {
    const record =
      producers[owner];

    const existing =
      oldProducers[owner] || {
        owner,
        events: {},
      };

    const result =
      await collectProducer(
        owner,
        record,
        existing
      );

    outputProducers[owner] =
      result.producer;

    totalNewEvents +=
      result.newEvents;

    /*
     * Keep the collector sequential.
     * This is slower but much safer for public
     * APIs and rate limits.
     */
    await sleep(100);
  }

  const now =
    new Date();

  const coverageStart =
    new Date(
      now.getTime() -
      MAX_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

  const output = {
    version: 3,
    updatedAt: now.toISOString(),
    coverageStart,
    producerCount:
      ownerNames.length,
    producers:
      outputProducers,
  };

  await saveJson(
    OUT_FILE,
    output
  );

  printSummary(
    outputProducers,
    {
      newEvents:
        totalNewEvents,
    }
  );

  console.log(
    `\nOutput: ${OUT_FILE}`
  );
}

main().catch((error) => {
  console.error(
    '\nFATAL:',
    error?.stack ||
    error
  );

  process.exit(1);
});
