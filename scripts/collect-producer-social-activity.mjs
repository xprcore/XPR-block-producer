import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(process.cwd());
const BP_FILE = path.join(ROOT, "data", "producer-bp-social.json");
const OUT_FILE = path.join(ROOT, "data", "producer-social-activity.json");

const MAX_DAYS = 365;
const MAX_EVENTS_PER_NETWORK = 500;
const FETCH_TIMEOUT_MS = 20000;

const GITHUB_API_VERSION = "2026-03-10";

const USER_AGENT =
  "XPR-Block-Producer-Social-Activity-Collector/1.0 (+https://github.com/xprcore/XPR-block-producer)";

const NETWORKS = [
  "github",
  "telegram",
  "youtube",
  "reddit",
  "medium",
];


// ------------------------------------------------------------
// Generic helpers
// ------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function cutoffIso(days = MAX_DAYS) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanUrl(value) {
  return safeString(value).replace(/[),.;]+$/, "");
}

function uniqueById(events) {
  const map = new Map();

  for (const event of events || []) {
    if (!event) continue;

    const id =
      safeString(event.id) ||
      safeString(event.url) ||
      `${event.network || ""}:${event.timestamp || ""}:${event.title || ""}`;

    if (!map.has(id)) {
      map.set(id, event);
    }
  }

  return [...map.values()].sort(
    (a, b) =>
      new Date(b.timestamp || 0).getTime() -
      new Date(a.timestamp || 0).getTime()
  );
}

function trimEvents(events) {
  return uniqueById(events).slice(0, MAX_EVENTS_PER_NETWORK);
}

function isRecent(timestamp, days = MAX_DAYS) {
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) return false;

  return t >= Date.now() - days * 86400000;
}

function countWindows(events) {
  const now = Date.now();

  const counts = {
    "7D": 0,
    "30D": 0,
    "1Y": 0,
  };

  for (const event of events || []) {
    const t = new Date(event.timestamp || 0).getTime();
    if (!Number.isFinite(t)) continue;

    const age = now - t;

    if (age <= 7 * 86400000) counts["7D"]++;
    if (age <= 30 * 86400000) counts["30D"]++;
    if (age <= 365 * 86400000) counts["1Y"]++;
  }

  return counts;
}

function lastActivity(events) {
  if (!events?.length) return null;

  return (
    events
      .map((e) => e.timestamp)
      .filter(Boolean)
      .sort()
      .at(-1) || null
  );
}

function statusResult(status, events = [], detail = null) {
  return {
    status,
    events: trimEvents(events),
    detail,
  };
}


// ------------------------------------------------------------
// Fetch helper
// ------------------------------------------------------------

async function fetchText(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "*/*",
        ...(options.headers || {}),
      },
      redirect: "follow",
    });

    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      text,
      url: response.url,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("TIMEOUT");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetchText(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      ...(options.headers || {}),
    },
  });

  let json = null;

  try {
    json = JSON.parse(response.text);
  } catch {
    // leave json null
  }

  return {
    ...response,
    json,
  };
}


// ------------------------------------------------------------
// URL parsing
// ------------------------------------------------------------

function parseGithubUrl(value) {
  const url = cleanUrl(value);

  if (!url) return null;

  try {
    const parsed = new URL(url);

    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
      return null;
    }

    const parts = parsed.pathname
      .split("/")
      .map((x) => x.trim())
      .filter(Boolean);

    if (!parts.length) return null;

    return parts[0];
  } catch {
    return null;
  }
}

function parseMediumUrl(value) {
  const url = cleanUrl(value);

  if (!url) return null;

  try {
    const parsed = new URL(url);

    if (
      parsed.hostname !== "medium.com" &&
      parsed.hostname !== "www.medium.com"
    ) {
      return null;
    }

    const parts = parsed.pathname
      .split("/")
      .map((x) => x.trim())
      .filter(Boolean);

    if (!parts.length) return null;

    const first = parts[0];

    if (first.startsWith("@")) {
      return first.slice(1);
    }

    return first;
  } catch {
    return null;
  }
}

function parseRedditUser(value) {
  const url = cleanUrl(value);

  if (!url) return null;

  try {
    const parsed = new URL(url);

    if (
      parsed.hostname !== "reddit.com" &&
      parsed.hostname !== "www.reddit.com"
    ) {
      return null;
    }

    const parts = parsed.pathname
      .split("/")
      .map((x) => x.trim())
      .filter(Boolean);

    const index = parts.findIndex(
      (x) => x.toLowerCase() === "user" || x.toLowerCase() === "u"
    );

    if (index === -1 || !parts[index + 1]) {
      return null;
    }

    return parts[index + 1];
  } catch {
    return null;
  }
}

function parseTelegram(value) {
  const url = cleanUrl(value);

  if (!url) return null;

  try {
    const parsed = new URL(url);

    if (
      parsed.hostname !== "t.me" &&
      parsed.hostname !== "telegram.me"
    ) {
      return null;
    }

    const pathname = parsed.pathname.replace(/^\/+/, "");

    if (!pathname) return null;

    // Private/invite links such as t.me/+M8CY...
    if (pathname.startsWith("+")) {
      return {
        type: "invite",
        value: pathname,
      };
    }

    // Public channel/group
    const channel = pathname.split("/")[0];

    if (!channel) return null;

    return {
      type: "public",
      value: channel,
    };
  } catch {
    return null;
  }
}


// ------------------------------------------------------------
// YouTube URL parsing
// ------------------------------------------------------------

function parseYoutube(value) {
  const url = cleanUrl(value);

  if (!url) return null;

  try {
    const parsed = new URL(url);

    const hostname = parsed.hostname.toLowerCase();

    if (
      hostname !== "youtube.com" &&
      hostname !== "www.youtube.com" &&
      hostname !== "m.youtube.com"
    ) {
      return null;
    }

    const pathname = parsed.pathname;

    // /channel/UCxxxx
    const channelMatch = pathname.match(
      /^\/channel\/(UC[a-zA-Z0-9_-]+)\/?/
    );

    if (channelMatch) {
      return {
        type: "channelId",
        value: channelMatch[1],
      };
    }

    // /@channel/UCxxxx
    const embeddedChannelMatch = pathname.match(
      /^\/@[^/]+\/(UC[a-zA-Z0-9_-]+)\/?/
    );

    if (embeddedChannelMatch) {
      return {
        type: "channelId",
        value: embeddedChannelMatch[1],
      };
    }

    // Any UC... appearing in path
    const ucMatch = pathname.match(
      /(UC[a-zA-Z0-9_-]{20,})/
    );

    if (ucMatch) {
      return {
        type: "channelId",
        value: ucMatch[1],
      };
    }

    // /@handle
    const handleMatch = pathname.match(/^\/@([^/]+)/);

    if (handleMatch) {
      return {
        type: "handle",
        value: handleMatch[1],
      };
    }

    // /user/name
    const userMatch = pathname.match(/^\/user\/([^/]+)/);

    if (userMatch) {
      return {
        type: "handle",
        value: userMatch[1],
      };
    }

    // /c/name
    const customMatch = pathname.match(/^\/c\/([^/]+)/);

    if (customMatch) {
      return {
        type: "handle",
        value: customMatch[1],
      };
    }

    return null;
  } catch {
    return null;
  }
}


// ------------------------------------------------------------
// GitHub
// ------------------------------------------------------------

async function githubEvents(value) {
  const username = parseGithubUrl(value);

  if (!username) {
    return statusResult(
      "UNSUPPORTED",
      [],
      "Invalid GitHub profile URL"
    );
  }

  const apiUrl =
    `https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=100`;

  try {
    const response = await fetchJson(apiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    });

    if (response.status === 404) {
      return statusResult(
        "NOT_FOUND",
        [],
        `GitHub user not found: ${username}`
      );
    }

    if (response.status === 403) {
      return statusResult(
        "ERROR",
        [],
        `GitHub HTTP 403 for ${username}`
      );
    }

    if (!response.ok) {
      return statusResult(
        "ERROR",
        [],
        `GitHub HTTP ${response.status} for ${username}`
      );
    }

    if (!Array.isArray(response.json)) {
      return statusResult(
        "ERROR",
        [],
        `Unexpected GitHub response for ${username}`
      );
    }

    const events = response.json
      .map((event) => {
        const timestamp = event.created_at;

        if (!timestamp || !isRecent(timestamp)) {
          return null;
        }

        return {
          id: `github:${event.id}`,
          network: "github",
          type: event.type || "GitHubEvent",
          title:
            event.repo?.name
              ? `${event.type || "GitHub activity"} — ${event.repo.name}`
              : event.type || "GitHub activity",
          timestamp,
          url: event.repo?.name
            ? `https://github.com/${event.repo.name}`
            : `https://github.com/${username}`,
          source: `https://github.com/${username}`,
          actor: username,
        };
      })
      .filter(Boolean);

    return statusResult(
      events.length ? "OK" : "NO_ACTIVITY",
      events,
      events.length
        ? `${events.length} public events`
        : `No public events returned for ${username}`
    );
  } catch (error) {
    return statusResult(
      "ERROR",
      [],
      `GitHub ${error?.message || String(error)}`
    );
  }
}


// ------------------------------------------------------------
// Telegram
// ------------------------------------------------------------

function parseTelegramPosts(html, channel) {
  const events = [];

  /*
   Telegram public channel pages use:
   https://t.me/s/<channel>
  */

  const blockRegex =
    /<div class="tgme_widget_message[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi;

  const blocks = html.match(blockRegex) || [];

  for (const block of blocks) {
    const dateMatch = block.match(
      /datetime="([^"]+)"/i
    );

    if (!dateMatch) continue;

    const timestamp = new Date(dateMatch[1]).toISOString();

    if (!isRecent(timestamp)) continue;

    const postMatch = block.match(
      /data-post="([^"]+)"/i
    );

    const postId =
      postMatch?.[1]?.split("/").at(-1) ||
      timestamp;

    const textMatch = block.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i
    );

    const titleText = textMatch
      ? textMatch[1]
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, " ")
          .trim()
      : `Telegram activity`;

    events.push({
      id: `telegram:${channel}:${postId}`,
      network: "telegram",
      type: "post",
      title: titleText.slice(0, 180) || "Telegram post",
      timestamp,
      url: `https://t.me/${channel}/${postId}`,
      source: `https://t.me/${channel}`,
    });
  }

  return trimEvents(events);
}

async function telegramEvents(value) {
  const parsed = parseTelegram(value);

  if (!parsed) {
    return statusResult(
      "UNSUPPORTED",
      [],
      "Invalid Telegram URL"
    );
  }

  if (parsed.type === "invite") {
    return statusResult(
      "UNSUPPORTED",
      [],
      "Private/invite Telegram link cannot be read without joining the channel"
    );
  }

  const channel = parsed.value;

  const publicUrl = `https://t.me/s/${encodeURIComponent(channel)}`;

  try {
    const response = await fetchText(publicUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (response.status === 404) {
      return statusResult(
        "NOT_FOUND",
        [],
        `Telegram public channel not found: ${channel}`
      );
    }

    if (!response.ok) {
      return statusResult(
        "ERROR",
        [],
        `Telegram HTTP ${response.status}`
      );
    }

    const events = parseTelegramPosts(
      response.text,
      channel
    );

    return statusResult(
      events.length ? "OK" : "NO_ACTIVITY",
      events,
      events.length
        ? `${events.length} public posts`
        : `No recent public posts found for ${channel}`
    );
  } catch (error) {
    return statusResult(
      "ERROR",
      [],
      `Telegram ${error?.message || String(error)}`
    );
  }
}


// ------------------------------------------------------------
// YouTube
// ------------------------------------------------------------

function parseYoutubeFeed(xml, sourceUrl) {
  const events = [];

  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/gi) || [];

  for (const entry of entries) {
    const idMatch = entry.match(
      /<yt:videoId>([^<]+)<\/yt:videoId>/i
    );

    const publishedMatch = entry.match(
      /<published>([^<]+)<\/published>/i
    );

    const titleMatch = entry.match(
      /<media:title>([\s\S]*?)<\/media:title>/i
    );

    if (!idMatch || !publishedMatch) continue;

    const timestamp = new Date(
      publishedMatch[1].trim()
    ).toISOString();

    if (!isRecent(timestamp)) continue;

    const videoId = idMatch[1].trim();

    const title = titleMatch
      ? titleMatch[1]
          .replace(/<!\[CDATA\[/g, "")
          .replace(/\]\]>/g, "")
          .trim()
      : "YouTube video";

    events.push({
      id: `youtube:${videoId}`,
      network: "youtube",
      type: "video",
      title,
      timestamp,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      source: sourceUrl,
    });
  }

  return trimEvents(events);
}

async function youtubeEvents(value) {
  const parsed = parseYoutube(value);

  if (!parsed) {
    return statusResult(
      "UNSUPPORTED",
      [],
      "Unrecognized YouTube URL"
    );
  }

  if (parsed.type === "handle") {
    /*
     YouTube RSS requires a channel ID.
     We intentionally do not guess a channel ID from a handle.
    */

    return statusResult(
      "UNSUPPORTED",
      [],
      `YouTube handle requires channel ID: @${parsed.value}`
    );
  }

  const channelId = parsed.value;

  const feedUrl =
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;

  try {
    const response = await fetchText(feedUrl, {
      headers: {
        Accept: "application/atom+xml,application/xml,text/xml",
      },
    });

    if (response.status === 404) {
      return statusResult(
        "NOT_FOUND",
        [],
        `YouTube channel not found: ${channelId}`
      );
    }

    if (!response.ok) {
      return statusResult(
        "ERROR",
        [],
        `YouTube HTTP ${response.status}`
      );
    }

    const events = parseYoutubeFeed(
      response.text,
      `https://www.youtube.com/channel/${channelId}`
    );

    return statusResult(
      events.length ? "OK" : "NO_ACTIVITY",
      events,
      events.length
        ? `${events.length} recent videos`
        : `No recent videos found for ${channelId}`
    );
  } catch (error) {
    return statusResult(
      "ERROR",
      [],
      `YouTube ${error?.message || String(error)}`
    );
  }
}


// ------------------------------------------------------------
// Reddit
// ------------------------------------------------------------

function parseRedditFeed(xml, username) {
  const events = [];

  const entries =
    xml.match(/<entry>[\s\S]*?<\/entry>/gi) || [];

  for (const entry of entries) {
    const idMatch = entry.match(
      /<id>([\s\S]*?)<\/id>/i
    );

    const publishedMatch = entry.match(
      /<updated>([\s\S]*?)<\/updated>/i
    );

    const titleMatch = entry.match(
      /<title>([\s\S]*?)<\/title>/i
    );

    const linkMatch = entry.match(
      /<link[^>]+href="([^"]+)"/i
    );

    if (!publishedMatch) continue;

    const timestamp = new Date(
      publishedMatch[1].trim()
    ).toISOString();

    if (!isRecent(timestamp)) continue;

    const id =
      idMatch?.[1]?.trim() ||
      `${timestamp}:${titleMatch?.[1] || ""}`;

    const title =
      titleMatch?.[1]
        ?.replace(/<!\[CDATA\[/g, "")
        .replace(/\]\]>/g, "")
        .trim() ||
      "Reddit activity";

    const url =
      linkMatch?.[1]?.trim() ||
      `https://www.reddit.com/user/${username}/`;

    events.push({
      id: `reddit:${id}`,
      network: "reddit",
      type: "post",
      title,
      timestamp,
      url,
      source: `https://www.reddit.com/user/${username}/`,
    });
  }

  return trimEvents(events);
}

async function redditEvents(value) {
  const username = parseRedditUser(value);

  if (!username) {
    return statusResult(
      "UNSUPPORTED",
      [],
      "Invalid Reddit user URL"
    );
  }

  const feedUrl =
    `https://www.reddit.com/user/${encodeURIComponent(username)}/.rss`;

  try {
    const response = await fetchText(feedUrl, {
      headers: {
        Accept: "application/atom+xml,application/xml,text/xml",
      },
    });

    if (response.status === 404) {
      return statusResult(
        "NOT_FOUND",
        [],
        `Reddit user not found: ${username}`
      );
    }

    if (!response.ok) {
      return statusResult(
        "ERROR",
        [],
        `Reddit HTTP ${response.status}`
      );
    }

    const events = parseRedditFeed(
      response.text,
      username
    );

    return statusResult(
      events.length ? "OK" : "NO_ACTIVITY",
      events,
      events.length
        ? `${events.length} recent Reddit posts`
        : `No recent Reddit activity found for ${username}`
    );
  } catch (error) {
    return statusResult(
      "ERROR",
      [],
      `Reddit ${error?.message || String(error)}`
    );
  }
}


// ------------------------------------------------------------
// Medium
// ------------------------------------------------------------

function parseMediumFeed(xml, username) {
  const events = [];

  const items =
    xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

  for (const item of items) {
    const guidMatch = item.match(
      /<guid[^>]*>([\s\S]*?)<\/guid>/i
    );

    const titleMatch = item.match(
      /<title>([\s\S]*?)<\/title>/i
    );

    const dateMatch = item.match(
      /<pubDate>([\s\S]*?)<\/pubDate>/i
    );

    const linkMatch = item.match(
      /<link>([\s\S]*?)<\/link>/i
    );

    if (!dateMatch) continue;

    const timestamp = new Date(
      dateMatch[1].trim()
    ).toISOString();

    if (!isRecent(timestamp)) continue;

    const id =
      guidMatch?.[1]?.trim() ||
      linkMatch?.[1]?.trim() ||
      `${timestamp}:${titleMatch?.[1] || ""}`;

    const title =
      titleMatch?.[1]
        ?.replace(/<!\[CDATA\[/g, "")
        .replace(/\]\]>/g, "")
        .trim() ||
      "Medium post";

    const url =
      linkMatch?.[1]?.trim() ||
      `https://medium.com/@${username}`;

    events.push({
      id: `medium:${id}`,
      network: "medium",
      type: "post",
      title,
      timestamp,
      url,
      source: `https://medium.com/@${username}`,
    });
  }

  return trimEvents(events);
}

async function mediumEvents(value) {
  const username = parseMediumUrl(value);

  if (!username) {
    return statusResult(
      "UNSUPPORTED",
      [],
      "Invalid Medium profile URL"
    );
  }

  const feedUrl =
    `https://medium.com/feed/@${encodeURIComponent(username)}`;

  try {
    const response = await fetchText(feedUrl, {
      headers: {
        Accept: "application/rss+xml,application/xml,text/xml",
      },
    });

    if (response.status === 404) {
      return statusResult(
        "NOT_FOUND",
        [],
        `Medium profile not found: ${username}`
      );
    }

    if (!response.ok) {
      return statusResult(
        "ERROR",
        [],
        `Medium HTTP ${response.status}`
      );
    }

    const events = parseMediumFeed(
      response.text,
      username
    );

    return statusResult(
      events.length ? "OK" : "NO_ACTIVITY",
      events,
      events.length
        ? `${events.length} recent Medium posts`
        : `No recent Medium posts found for ${username}`
    );
  } catch (error) {
    return statusResult(
      "ERROR",
      [],
      `Medium ${error?.message || String(error)}`
    );
  }
}


// ------------------------------------------------------------
// Existing data
// ------------------------------------------------------------

async function readJson(file, fallback) {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}


// ------------------------------------------------------------
// Main
// ------------------------------------------------------------

async function main() {
  console.log("");
  console.log("========================================");
  console.log(" XPR Producer Social Activity Collector");
  console.log("========================================");
  console.log("");

  const bp = await readJson(BP_FILE, {
    version: 2,
    producers: {},
  });

  const old = await readJson(OUT_FILE, {
    version: 2,
    producers: {},
  });

  const producers = bp?.producers || {};
  const oldProducers = old?.producers || {};

  console.log(
    `Producers: ${Object.keys(producers).length}`
  );
  console.log("");

  let withActivity = 0;
  let withoutActivity = 0;
  let networkErrors = 0;

  const output = {
    version: 2,
    updatedAt: nowIso(),
    coverageStart: cutoffIso(MAX_DAYS),
    producerCount: Object.keys(producers).length,
    producers: {},
  };

  for (const [owner, record] of Object.entries(producers)) {
    console.log(`[${owner}]`);

    const previous =
      oldProducers[owner] || {
        owner,
        activity: {
          "7D": 0,
          "30D": 0,
          "1Y": 0,
        },
        networkActivity: {},
        lastSocialActivity: null,
        events: {},
      };

    const social = record?.social || {};

    const producerEvents = {};
    const networkActivity = {};
    const diagnostics = {};

    let producerHasActivity = false;
    let producerLastActivity = null;

    for (const network of NETWORKS) {
      const url = social?.[network];

      /*
       Preserve previously collected events even if the current
       source is temporarily unavailable.
      */
      const previousEvents = Array.isArray(
        previous?.events?.[network]
      )
        ? previous.events[network]
        : [];

      if (!url) {
        continue;
      }

      let result;

      try {
        switch (network) {
          case "github":
            result = await githubEvents(url);
            break;

          case "telegram":
            result = await telegramEvents(url);
            break;

          case "youtube":
            result = await youtubeEvents(url);
            break;

          case "reddit":
            result = await redditEvents(url);
            break;

          case "medium":
            result = await mediumEvents(url);
            break;

          default:
            result = statusResult(
              "UNSUPPORTED",
              [],
              `Unsupported network: ${network}`
            );
        }
      } catch (error) {
        result = statusResult(
          "ERROR",
          [],
          error?.message || String(error)
        );
      }

      /*
       Merge newly discovered events with existing history.
       This is important because GitHub only exposes events from
       the last 30 days through the Events API.
      */
      const merged = trimEvents([
        ...result.events,
        ...previousEvents,
      ]).filter((event) =>
        isRecent(event.timestamp, MAX_DAYS)
      );

      producerEvents[network] = merged;

      const counts = countWindows(merged);
      const last = lastActivity(merged);

      networkActivity[network] = {
        count: counts,
        lastActivity: last,
        status: result.status,
        detail: result.detail,
        source: cleanUrl(url),
      };

      diagnostics[network] = {
        status: result.status,
        detail: result.detail,
        source: cleanUrl(url),
        fetchedAt: nowIso(),
        discovered: result.events.length,
        stored: merged.length,
      };

      if (merged.length > 0) {
        producerHasActivity = true;
      }

      if (last) {
        if (
          !producerLastActivity ||
          new Date(last).getTime() >
            new Date(producerLastActivity).getTime()
        ) {
          producerLastActivity = last;
        }
      }

      const statusText =
        result.status.padEnd(11);

      let detailText = "";

      if (result.status === "OK") {
        detailText =
          `${result.events.length} events`;
      } else if (result.status === "NO_ACTIVITY") {
        detailText = "0 events";
      } else {
        detailText =
          result.detail || result.status;
      }

      console.log(
        `  ${network.padEnd(9)} ${statusText} ${detailText} (stored ${merged.length})`
      );
    }

    /*
     Include old networks that are no longer present in the current
     social definition, so existing history is not accidentally deleted.
    */
    for (const [network, events] of Object.entries(
      previous?.events || {}
    )) {
      if (producerEvents[network]) continue;

      if (!Array.isArray(events)) continue;

      const preserved = trimEvents(events).filter((event) =>
        isRecent(event.timestamp, MAX_DAYS)
      );

      if (preserved.length) {
        producerEvents[network] = preserved;

        const counts = countWindows(preserved);
        const last = lastActivity(preserved);

        networkActivity[network] = {
          count: counts,
          lastActivity: last,
          status: "PRESERVED",
          detail: "Preserved from previous collection",
          source:
            previous?.networkActivity?.[network]?.source ||
            null,
        };
      }
    }

    const allEvents = Object.values(producerEvents)
      .flat()
      .filter(Boolean);

    const activity = countWindows(allEvents);

    if (producerHasActivity || allEvents.length > 0) {
      withActivity++;
    } else {
      withoutActivity++;
    }

    for (const network of Object.keys(networkActivity)) {
      const status =
        networkActivity[network]?.status;

      if (status === "ERROR") {
        networkErrors++;
      }
    }

    console.log(
      `  TOTAL     7D=${activity["7D"]} 30D=${activity["30D"]} 1Y=${activity["1Y"]}`
    );

    console.log("");

    output.producers[owner] = {
      owner,
      activity,
      networkActivity,
      lastSocialActivity: producerLastActivity,
      events: producerEvents,
      diagnostics,
    };
  }

  /*
   Global diagnostics
  */
  const networkSummary = {};

  for (const network of NETWORKS) {
    networkSummary[network] = {
      OK: 0,
      NO_ACTIVITY: 0,
      NOT_FOUND: 0,
      UNSUPPORTED: 0,
      ERROR: 0,
    };

    for (const producer of Object.values(
      output.producers
    )) {
      const status =
        producer?.networkActivity?.[network]?.status;

      if (status && networkSummary[network][status] !== undefined) {
        networkSummary[network][status]++;
      }
    }
  }

  output.diagnostics = {
    generatedAt: nowIso(),
    maxDays: MAX_DAYS,
    networkSummary,
  };

  await fs.writeFile(
    OUT_FILE,
    JSON.stringify(output, null, 2) + "\n",
    "utf8"
  );

  console.log("========================================");
  console.log(" SUMMARY");
  console.log("========================================");
  console.log(
    `Producers checked:      ${Object.keys(producers).length}`
  );
  console.log(
    `With activity:          ${withActivity}`
  );
  console.log(
    `Without activity:       ${withoutActivity}`
  );
  console.log(
    `Network errors:         ${networkErrors}`
  );
  console.log("");
  console.log("Network summary:");

  for (const [network, summary] of Object.entries(
    networkSummary
  )) {
    console.log(
      `  ${network.padEnd(9)} ` +
        `OK=${summary.OK} ` +
        `NO_ACTIVITY=${summary.NO_ACTIVITY} ` +
        `NOT_FOUND=${summary.NOT_FOUND} ` +
        `UNSUPPORTED=${summary.UNSUPPORTED} ` +
        `ERROR=${summary.ERROR}`
    );
  }

  console.log("");
  console.log(`Output: ${OUT_FILE}`);
  console.log("========================================");
}

main().catch((error) => {
  console.error("");
  console.error("FATAL COLLECTOR ERROR");
  console.error(error);
  process.exit(1);
});
