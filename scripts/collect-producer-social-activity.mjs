import fs from 'node:fs/promises';

const BP_FILE = new URL('../data/producer-bp-social.json', import.meta.url);
const OUT = new URL('../data/producer-social-activity.json', import.meta.url);

const MAX_DAYS = 365;
const MAX_EVENTS_PER_NETWORK = 5000;

async function readJson(url, fallback) {
  try {
    const text = await fs.readFile(url, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    console.warn(`JSON read failed: ${url.pathname}`);
    console.warn(error.message);
    return fallback;
  }
}

function cleanHandle(value) {
  if (!value) return null;

  let s = String(value).trim();

  if (!s) return null;

  // GitHub
  if (/github\.com\//i.test(s)) {
    try {
      const u = new URL(s);
      return u.pathname
        .split('/')
        .filter(Boolean)[0] || null;
    } catch {}
  }

  // Telegram
  if (/t\.me\//i.test(s)) {
    try {
      const u = new URL(s);
      return u.pathname
        .split('/')
        .filter(Boolean)[0] || null;
    } catch {}
  }

  // Reddit
  if (/reddit\.com\//i.test(s)) {
    try {
      const u = new URL(s);
      const parts = u.pathname
        .split('/')
        .filter(Boolean);

      const i = parts.findIndex(
        x => x.toLowerCase() === 'user'
      );

      if (i >= 0 && parts[i + 1]) {
        return parts[i + 1];
      }

      return parts[0] || null;
    } catch {}
  }

  // Medium
  if (/medium\.com\//i.test(s)) {
    try {
      const u = new URL(s);
      const part = u.pathname
        .split('/')
        .filter(Boolean)[0];

      return part
        ? part.replace(/^@/, '')
        : null;
    } catch {}
  }

  // X / Twitter
  if (/twitter\.com\//i.test(s) || /x\.com\//i.test(s)) {
    try {
      const u = new URL(s);
      return u.pathname
        .split('/')
        .filter(Boolean)[0]
        ?.replace(/^@/, '') || null;
    } catch {}
  }

  return s
    .replace(/^@/, '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .trim();
}

function event(id, ts, extra = {}) {
  return {
    id: String(id),
    ts: new Date(ts).toISOString(),
    ...extra
  };
}

function addUnique(target, events) {
  const map = new Map();

  for (const item of target || []) {
    if (!item?.id || !item?.ts) continue;
    map.set(String(item.id), item);
  }

  for (const item of events || []) {
    if (!item?.id || !item?.ts) continue;
    map.set(String(item.id), item);
  }

  return [...map.values()]
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    .slice(-MAX_EVENTS_PER_NETWORK);
}

function windows(events) {
  const now = Date.now();

  const d7 = now - 7 * 86400000;
  const d30 = now - 30 * 86400000;
  const d365 = now - 365 * 86400000;

  let c7 = 0;
  let c30 = 0;
  let c365 = 0;

  for (const item of events || []) {
    const t = new Date(item.ts).getTime();

    if (!Number.isFinite(t)) continue;

    if (t >= d365) {
      c365++;

      if (t >= d30) {
        c30++;

        if (t >= d7) {
          c7++;
        }
      }
    }
  }

  return {
    "7D": c7,
    "30D": c30,
    "1Y": c365
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    ...options
  });

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  return {
    response,
    data,
    text
  };
}

/* =========================================================
   GITHUB
   ========================================================= */

async function githubEvents(handle) {
  const username = cleanHandle(handle);

  if (!username) {
    return {
      events: [],
      status: 'EMPTY',
      detail: 'No GitHub handle'
    };
  }

  const url =
    `https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=100`;

  try {
    const { response, data } = await fetchJson(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'XPRCore-social-activity'
      }
    });

    if (!response.ok) {
      return {
        events: [],
        status: 'ERROR',
        detail: `HTTP ${response.status}`
      };
    }

    if (!Array.isArray(data)) {
      return {
        events: [],
        status: 'ERROR',
        detail: 'Invalid GitHub response'
      };
    }

    const events = data
      .filter(item => item?.id && item?.created_at)
      .map(item =>
        event(
          `github:${item.id}`,
          item.created_at,
          {
            type: item.type,
            network: 'github',
            repo: item.repo?.name || null,
            url:
              item.repo?.html_url ||
              (
                item.repo?.name
                  ? `https://github.com/${item.repo.name}`
                  : null
              )
          }
        )
      );

    return {
      events,
      status: events.length ? 'OK' : 'EMPTY',
      detail: `${events.length} events`
    };

  } catch (error) {
    return {
      events: [],
      status: 'ERROR',
      detail: error.message
    };
  }
}

/* =========================================================
   TELEGRAM
   ========================================================= */

async function telegramEvents(handle) {
  const username = cleanHandle(handle);

  if (!username) {
    return {
      events: [],
      status: 'EMPTY',
      detail: 'No Telegram handle'
    };
  }

  const url =
    `https://t.me/s/${encodeURIComponent(username)}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 XPRCore-social-activity'
      }
    });

    const html = await response.text();

    if (!response.ok) {
      return {
        events: [],
        status: 'ERROR',
        detail: `HTTP ${response.status}`
      };
    }

    const events = [];

    const regex =
      /data-post="([^"]+)"[\s\S]{0,500}?datetime="([^"]+)"/gi;

    let match;

    while ((match = regex.exec(html)) !== null) {
      const postId = match[1];
      const timestamp = match[2];

      if (!postId || !timestamp) continue;

      const d = new Date(timestamp);

      if (Number.isNaN(d.getTime())) continue;

      events.push(
        event(
          `telegram:${postId}`,
          d.toISOString(),
          {
            network: 'telegram',
            url: `https://t.me/${postId}`
          }
        )
      );
    }

    return {
      events,
      status: events.length ? 'OK' : 'EMPTY',
      detail: `${events.length} posts`
    };

  } catch (error) {
    return {
      events: [],
      status: 'ERROR',
      detail: error.message
    };
  }
}

/* =========================================================
   REDDIT
   ========================================================= */

async function redditEvents(value) {
  const username = cleanHandle(value);

  if (!username) {
    return {
      events: [],
      status: 'EMPTY',
      detail: 'No Reddit handle'
    };
  }

  const events = [];

  try {
    const endpoints = [
      `https://www.reddit.com/user/${encodeURIComponent(username)}/submitted.json?limit=100`,
      `https://www.reddit.com/user/${encodeURIComponent(username)}/comments.json?limit=100`
    ];

    for (const url of endpoints) {
      try {
        const response = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'XPRCore-social-activity/1.0'
          }
        });

        if (!response.ok) {
          continue;
        }

        const data = await response.json();

        const children =
          data?.data?.children || [];

        for (const child of children) {
          const item = child?.data;

          if (!item?.id || !item?.created_utc) {
            continue;
          }

          events.push(
            event(
              `reddit:${item.id}`,
              new Date(
                item.created_utc * 1000
              ).toISOString(),
              {
                network: 'reddit',
                kind: child.kind || null,
                subreddit: item.subreddit || null,
                url: item.permalink
                  ? `https://www.reddit.com${item.permalink}`
                  : null
              }
            )
          );
        }

      } catch (error) {
        console.warn(
          `Reddit endpoint failed for ${username}:`,
          error.message
        );
      }
    }

    const unique = addUnique([], events);

    return {
      events: unique,
      status: unique.length ? 'OK' : 'EMPTY',
      detail: `${unique.length} events`
    };

  } catch (error) {
    return {
      events: [],
      status: 'ERROR',
      detail: error.message
    };
  }
}

/* =========================================================
   MEDIUM
   ========================================================= */

async function mediumEvents(value) {
  const username = cleanHandle(value);

  if (!username) {
    return {
      events: [],
      status: 'EMPTY',
      detail: 'No Medium handle'
    };
  }

  const url =
    `https://medium.com/feed/@${encodeURIComponent(username)}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'XPRCore-social-activity/1.0'
      }
    });

    const xml = await response.text();

    if (!response.ok) {
      return {
        events: [],
        status: 'ERROR',
        detail: `HTTP ${response.status}`
      };
    }

    const events = [];

    const itemRegex =
      /<item>([\s\S]*?)<\/item>/gi;

    let itemMatch;

    while ((itemMatch = itemRegex.exec(xml)) !== null) {
      const item = itemMatch[1];

      const guid =
        item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1]
          ?.trim();

      const pubDate =
        item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]
          ?.trim();

      const link =
        item.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]
          ?.trim();

      if (!guid || !pubDate) continue;

      const d = new Date(pubDate);

      if (Number.isNaN(d.getTime())) continue;

      events.push(
        event(
          `medium:${guid}`,
          d.toISOString(),
          {
            network: 'medium',
            url: link || null
          }
        )
      );
    }

    return {
      events,
      status: events.length ? 'OK' : 'EMPTY',
      detail: `${events.length} posts`
    };

  } catch (error) {
    return {
      events: [],
      status: 'ERROR',
      detail: error.message
    };
  }
}

/* =========================================================
   YOUTUBE
   ========================================================= */

async function youtubeEvents(value) {
  const username = cleanHandle(value);

  if (!username) {
    return {
      events: [],
      status: 'EMPTY',
      detail: 'No YouTube handle'
    };
  }

  /*
   * YouTube RSS requires a channel ID.
   * @handle cannot reliably be converted to a channel
   * without YouTube's API/search layer.
   *
   * Therefore don't pretend that an @handle was found.
   */
  if (username.startsWith('UC')) {
    const url =
      `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(username)}`;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'XPRCore-social-activity/1.0'
        }
      });

      const xml = await response.text();

      if (!response.ok) {
        return {
          events: [],
          status: 'ERROR',
          detail: `HTTP ${response.status}`
        };
      }

      const events = [];

      const entryRegex =
        /<entry>([\s\S]*?)<\/entry>/gi;

      let match;

      while ((match = entryRegex.exec(xml)) !== null) {
        const entry = match[1];

        const id =
          entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/i)?.[1];

        const published =
          entry.match(/<published>(.*?)<\/published>/i)?.[1];

        if (!id || !published) continue;

        const d = new Date(published);

        if (Number.isNaN(d.getTime())) continue;

        events.push(
          event(
            `youtube:${id}`,
            d.toISOString(),
            {
              network: 'youtube',
              url: `https://www.youtube.com/watch?v=${id}`
            }
          )
        );
      }

      return {
        events,
        status: events.length ? 'OK' : 'EMPTY',
        detail: `${events.length} videos`
      };

    } catch (error) {
      return {
        events: [],
        status: 'ERROR',
        detail: error.message
      };
    }
  }

  return {
    events: [],
    status: 'EMPTY',
    detail: 'YouTube handle requires channel ID for RSS'
  };
}

/* =========================================================
   MAIN
   ========================================================= */

async function main() {
  const bp = await readJson(
    BP_FILE,
    { producers: {} }
  );

  const old = await readJson(
    OUT,
    {
      version: 2,
      coverageStart: new Date().toISOString(),
      producers: {}
    }
  );

  const producers =
    bp?.producers || {};

  const result = {
    version: 2,
    updatedAt: new Date().toISOString(),

    /*
     * Keep original coverage start so 1Y grows
     * over time instead of resetting every run.
     */
    coverageStart:
      old.coverageStart ||
      new Date().toISOString(),

    producerCount:
      Object.keys(producers).length,

    producers: {}
  };

  let producersWithActivity = 0;
  let producersWithoutActivity = 0;
  let totalNetworkErrors = 0;

  console.log('');
  console.log('========================================');
  console.log(' XPR Producer Social Activity Collector');
  console.log('========================================');
  console.log(
    `Producers: ${Object.keys(producers).length}`
  );
  console.log('');

  for (const [owner, record] of Object.entries(producers)) {
    const existing =
      old.producers?.[owner] || {
        events: {}
      };

    const social =
      record?.social || {};

    const events = {
      ...(existing.events || {})
    };

    const diagnostics = {};

    console.log(`\n[${owner}]`);

    const tasks = [];

    /*
     * GITHUB
     */
    if (social.github) {
      tasks.push({
        network: 'github',
        value: social.github,
        fn: () => githubEvents(social.github)
      });
    }

    /*
     * TELEGRAM
     */
    if (social.telegram) {
      tasks.push({
        network: 'telegram',
        value: social.telegram,
        fn: () => telegramEvents(social.telegram)
      });
    }

    /*
     * YOUTUBE
     */
    if (social.youtube) {
      tasks.push({
        network: 'youtube',
        value: social.youtube,
        fn: () => youtubeEvents(social.youtube)
      });
    }

    /*
     * REDDIT
     */
    if (social.reddit) {
      tasks.push({
        network: 'reddit',
        value: social.reddit,
        fn: () => redditEvents(social.reddit)
      });
    }

    /*
     * MEDIUM
     */
    if (social.medium) {
      tasks.push({
        network: 'medium',
        value: social.medium,
        fn: () => mediumEvents(social.medium)
      });
    }

    if (!tasks.length) {
      console.log('  NO SOCIAL PROFILES');

      diagnostics.status = 'NO_SOCIAL_PROFILES';

      result.producers[owner] = {
        owner,
        social,
        activity: {
          "7D": 0,
          "30D": 0,
          "1Y": 0
        },
        networkActivity: {},
        lastSocialActivity: null,
        events,
        diagnostics
      };

      producersWithoutActivity++;
      continue;
    }

    /*
     * Run networks sequentially.
     *
     * This is slower than Promise.all(), but avoids
     * hammering Reddit/GitHub/etc. simultaneously
     * and makes diagnostics much easier.
     */
    for (const task of tasks) {
      try {
        const resultData =
          await task.fn();

        const incoming =
          resultData?.events || [];

        const previous =
          events[task.network] || [];

        events[task.network] =
          addUnique(
            previous,
            incoming
          );

        diagnostics[task.network] = {
          status:
            resultData.status || 'UNKNOWN',

          detail:
            resultData.detail || '',

          newEvents:
            incoming.length,

          storedEvents:
            events[task.network].length
        };

        if (resultData.status === 'ERROR') {
          totalNetworkErrors++;
        }

        console.log(
          `  ${task.network.padEnd(9)} ` +
          `${resultData.status.padEnd(6)} ` +
          `${resultData.detail || ''} ` +
          `(stored ${events[task.network].length})`
        );

      } catch (error) {
        diagnostics[task.network] = {
          status: 'ERROR',
          detail: error.message,
          newEvents: 0,
          storedEvents:
            (events[task.network] || []).length
        };

        totalNetworkErrors++;

        console.log(
          `  ${task.network.padEnd(9)} ERROR  ${error.message}`
        );
      }
    }

    /*
     * Calculate per-network statistics.
     */
    const networkActivity = {};
    const all = [];

    for (const [network, networkEvents] of Object.entries(events)) {
      const cleaned =
        addUnique([], networkEvents);

      events[network] = cleaned;

      const count =
        windows(cleaned);

      const last =
        cleaned.length
          ? cleaned[cleaned.length - 1].ts
          : null;

      networkActivity[network] = {
        count,
        lastActivity:
          last
            ? new Date(last).toISOString()
            : null
      };

      all.push(...cleaned);
    }

    /*
     * Overall activity.
     */
    const uniqueAll =
      addUnique([], all);

    const activity =
      windows(uniqueAll);

    const last =
      uniqueAll.length
        ? uniqueAll[uniqueAll.length - 1].ts
        : null;

    const hasActivity =
      uniqueAll.length > 0;

    if (hasActivity) {
      producersWithActivity++;
    } else {
      producersWithoutActivity++;
    }

    result.producers[owner] = {
      owner,
      social,
      activity,
      networkActivity,
      lastSocialActivity:
        last
          ? new Date(last).toISOString()
          : null,
      events,
      diagnostics
    };

    console.log(
      `  TOTAL     ` +
      `7D=${activity["7D"]} ` +
      `30D=${activity["30D"]} ` +
      `1Y=${activity["1Y"]}`
    );
  }

  await fs.writeFile(
    OUT,
    JSON.stringify(result, null, 2) + '\n'
  );

  console.log('');
  console.log('========================================');
  console.log(' SUMMARY');
  console.log('========================================');
  console.log(
    `Producers checked:      ${result.producerCount}`
  );
  console.log(
    `With activity:          ${producersWithActivity}`
  );
  console.log(
    `Without activity:       ${producersWithoutActivity}`
  );
  console.log(
    `Network errors:         ${totalNetworkErrors}`
  );
  console.log(
    `Output:                 ${OUT.pathname}`
  );
  console.log('========================================');
  console.log('');
}

main().catch(error => {
  console.error('');
  console.error('FATAL COLLECTOR ERROR');
  console.error(error);
  console.error('');
  process.exit(1);
});
