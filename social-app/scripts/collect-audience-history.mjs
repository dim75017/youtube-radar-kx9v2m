import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIENCE_PLATFORMS,
  assertAudienceHistory,
  emptyEngagementByPeriod,
  latestAudienceObservation,
  recalculateAudienceEngagement,
} from "../lib/audience-metrics.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_HISTORY_PATH = resolve(ROOT, "data", "audience-history.json");
const DEFAULT_POSTS_PATH = resolve(ROOT, "data", "public-history.json");
const CHANNEL_ID = "UCSJ4gkVC6NrvII8umztf0Ow";
const MAX_RESPONSE_BYTES = 4_000_000;
const FETCH_TIMEOUT_MS = 25_000;

const PROFILE_URLS = {
  youtube: "https://www.youtube.com/@LofiGirl",
  instagram: "https://www.instagram.com/lofigirl/",
  tiktok: "https://www.tiktok.com/@lofigirl",
  x: "https://x.com/lofigirl",
};

export const AUDIENCE_COLLECTORS = {
  youtube: collectYouTube,
  instagram: collectInstagram,
  tiktok: collectTikTok,
  x: collectX,
};

/**
 * Collect every account independently. A failed source leaves its prior
 * observations untouched; successful observations are appended as captured.
 */
export async function collectAudienceHistory(options = {}) {
  const historyPath = options.historyPath ?? DEFAULT_HISTORY_PATH;
  const postsPath = options.postsPath ?? DEFAULT_POSTS_PATH;
  const outputPath = options.outputPath ?? historyPath;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const collectors = options.collectors ?? AUDIENCE_COLLECTORS;
  const capturedAt = canonicalNow(options.now);
  const write = options.write !== false;

  const [historyValue, publicHistory] = await Promise.all([
    readJson(historyPath),
    readJson(postsPath),
  ]);
  const history = assertAudienceHistory(historyValue);
  const posts = Array.isArray(publicHistory?.posts) ? publicHistory.posts : [];
  const next = structuredClone(history);
  const successes = [];
  const failures = [];

  const settled = await Promise.allSettled(
    AUDIENCE_PLATFORMS.map(async (platform) => {
      const collector = collectors[platform];
      if (typeof collector !== "function") {
        throw new Error(`Collecteur ${platform} absent.`);
      }
      const observation = await collector({ env, fetchImpl, capturedAt });
      return { platform, observation: validateCollectedObservation(observation) };
    }),
  );

  for (const [index, result] of settled.entries()) {
    const platform = AUDIENCE_PLATFORMS[index];
    if (result.status === "rejected") {
      failures.push({ platform, error: errorMessage(result.reason) });
      continue;
    }
    const latest = latestAudienceObservation(next.platforms[platform]);
    if (latest && Date.parse(result.value.observation.capturedAt) <= Date.parse(latest.capturedAt)) {
      failures.push({
        platform,
        error: "Le nouveau relevé n’est pas postérieur au dernier point conservé.",
      });
      continue;
    }
    const plausibilityError = audienceObservationPlausibilityError(
      latest,
      result.value.observation,
    );
    if (plausibilityError) {
      failures.push({ platform, error: plausibilityError });
      continue;
    }
    if (latest && parisCalendarDay(latest.capturedAt) === parisCalendarDay(result.value.observation.capturedAt)) {
      const latestIndex = next.platforms[platform].observations.findIndex(
        (item) => item.capturedAt === latest.capturedAt,
      );
      next.platforms[platform].observations[latestIndex] = result.value.observation;
    } else {
      next.platforms[platform].observations.push(result.value.observation);
    }
    successes.push({
      platform,
      followers: result.value.observation.followers,
      precision: result.value.observation.precision,
    });
  }

  const recalculated = recalculateAudienceEngagement(next, posts, capturedAt);
  assertAudienceHistory(recalculated);
  if (write) await writeJsonAtomically(outputPath, recalculated);
  return { history: recalculated, successes, failures };
}

export function audienceObservationPlausibilityError(previous, current) {
  if (!previous) return null;
  const previousTimestamp = Date.parse(previous.capturedAt);
  const currentTimestamp = Date.parse(current.capturedAt);
  if (
    !Number.isFinite(previousTimestamp) ||
    !Number.isFinite(currentTimestamp) ||
    previous.followers <= 0 ||
    current.followers <= 0
  ) {
    return "Le relevé audience ne permet pas un contrôle de cohérence.";
  }
  const ratio = current.followers / previous.followers;
  const elapsedDays = (currentTimestamp - previousTimestamp) / (24 * 60 * 60 * 1_000);
  const implausible = elapsedDays <= 7
    ? ratio < 0.8 || ratio > 1.25
    : ratio < 0.5 || ratio > 3;
  return implausible
    ? `Variation audience incohérente (${previous.followers} → ${current.followers}) ; dernier bon relevé conservé.`
    : null;
}

async function collectYouTube({ env, fetchImpl, capturedAt }) {
  if (nonempty(env.YOUTUBE_API_KEY)) {
    const request = new URL("https://www.googleapis.com/youtube/v3/channels");
    request.searchParams.set("part", "statistics");
    request.searchParams.set("id", CHANNEL_ID);
    request.searchParams.set("key", env.YOUTUBE_API_KEY);
    try {
      const payload = await fetchJson(fetchImpl, request, {});
      const statistics = payload?.items?.[0]?.statistics;
      if (statistics?.hiddenSubscriberCount === true) {
        throw new Error("Le compteur YouTube est masqué.");
      }
      const followers = strictPositiveInteger(statistics?.subscriberCount);
      if (followers === null) throw new Error("subscriberCount YouTube absent.");
      return observation({
        capturedAt,
        followers,
        precision: "platform-rounded",
        sourceUrl: "https://www.googleapis.com/youtube/v3/channels",
        label: "YouTube Data API v3 · compteur public arrondi à trois chiffres significatifs",
      });
    } catch {
      // The public profile remains an honest fallback when the API is unavailable.
    }
  }

  const html = await fetchText(
    fetchImpl,
    `${PROFILE_URLS.youtube}/about`,
    { Accept: "text/html,application/xhtml+xml" },
  );
  const label = firstMatch(html, [
    /"subscriberCountText"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/i,
    /"subscriberCountText"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)"/i,
    /([\d.,]+\s*[KMB]?)\s+(?:subscribers|abonnés)/i,
  ]);
  const followers = compactCount(label);
  if (followers === null) throw new Error("Compteur public YouTube non parsable.");
  return observation({
    capturedAt,
    followers,
    precision: "platform-rounded",
    sourceUrl: PROFILE_URLS.youtube,
    label: `Profil public YouTube · ${cleanLabel(label)}`,
  });
}

async function collectInstagram({ env, fetchImpl, capturedAt }) {
  if (nonempty(env.INSTAGRAM_ACCESS_TOKEN) && nonempty(env.INSTAGRAM_USER_ID)) {
    const version = /^v\d+\.\d+$/.test(nonempty(env.INSTAGRAM_API_VERSION) ?? "")
      ? env.INSTAGRAM_API_VERSION
      : "v23.0";
    const endpoint = `https://graph.instagram.com/${version}/${encodeURIComponent(env.INSTAGRAM_USER_ID)}?fields=followers_count`;
    try {
      const payload = await fetchJson(fetchImpl, endpoint, {
        Authorization: `Bearer ${env.INSTAGRAM_ACCESS_TOKEN}`,
      });
      const followers = strictPositiveInteger(payload?.followers_count);
      if (followers === null) throw new Error("followers_count Instagram absent.");
      return observation({
        capturedAt,
        followers,
        precision: "exact",
        sourceUrl: `https://graph.instagram.com/${version}/${encodeURIComponent(env.INSTAGRAM_USER_ID)}`,
        label: "Instagram Graph API · followers_count du compte professionnel",
      });
    } catch {
      // Only a parsed public value may replace the failed official read.
    }
  }

  const html = await fetchText(fetchImpl, PROFILE_URLS.instagram, {
    Accept: "text/html,application/xhtml+xml",
  });
  const exact = firstMatch(html, [
    /"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/i,
    /"follower_count"\s*:\s*(\d+)/i,
    /"followers_count"\s*:\s*(\d+)/i,
  ]);
  const exactFollowers = strictPositiveInteger(exact);
  if (exactFollowers !== null) {
    return observation({
      capturedAt,
      followers: exactFollowers,
      precision: "exact",
      sourceUrl: PROFILE_URLS.instagram,
      label: "Profil public Instagram · compteur entier exposé par la page",
    });
  }
  const compact = firstMatch(html, [
    /([\d.,]+\s*[KMB]?)\s+(?:Followers|abonnés)/i,
  ]);
  const followers = compactCount(compact);
  if (followers === null) throw new Error("Compteur public Instagram non parsable.");
  return observation({
    capturedAt,
    followers,
    precision: "platform-rounded",
    sourceUrl: PROFILE_URLS.instagram,
    label: `Profil public Instagram · ${cleanLabel(compact)}`,
  });
}

async function collectTikTok({ env, fetchImpl, capturedAt }) {
  if (nonempty(env.TIKTOK_ACCESS_TOKEN)) {
    const endpoint = "https://open.tiktokapis.com/v2/user/info/?fields=follower_count";
    try {
      const payload = await fetchJson(fetchImpl, endpoint, {
        Authorization: `Bearer ${env.TIKTOK_ACCESS_TOKEN}`,
      });
      if (payload?.error?.code && payload.error.code !== "ok") {
        throw new Error(`TikTok API: ${payload.error.code}`);
      }
      const followers = strictPositiveInteger(payload?.data?.user?.follower_count);
      if (followers === null) throw new Error("follower_count TikTok absent.");
      return observation({
        capturedAt,
        followers,
        precision: "exact",
        sourceUrl: "https://open.tiktokapis.com/v2/user/info/",
        label: "TikTok User Info API v2 · scope user.info.stats",
      });
    } catch {
      // Fall through to the creator embed without weakening validation.
    }
  }

  const publicSources = [
    {
      url: PROFILE_URLS.tiktok,
      sourceUrl: PROFILE_URLS.tiktok,
      label: "Métadonnée publique TikTok statsV2",
    },
    {
      url: "https://www.tiktok.com/embed/@lofigirl",
      sourceUrl: "https://www.tiktok.com/embed/@lofigirl",
      label: "TikTok creator embed · followerCount entier statsV2",
    },
  ];
  for (const source of publicSources) {
    try {
      const html = await fetchText(fetchImpl, source.url, {
        Accept: "text/html,application/xhtml+xml",
      });
      const raw = firstMatch(html, [
        /"statsV2"\s*:\s*\{[^{}]*"followerCount"\s*:\s*"?(\d+)"?/i,
        /"followerCount"\s*:\s*"?(\d+)"?/i,
        /"follower_count"\s*:\s*"?(\d+)"?/i,
      ]);
      const followers = strictPositiveInteger(raw);
      if (followers === null) continue;
      return observation({
        capturedAt,
        followers,
        precision: "exact",
        sourceUrl: source.sourceUrl,
        label: source.label,
      });
    } catch {
      // Try the next public TikTok representation.
    }
  }
  throw new Error("Compteur TikTok statsV2 non parsable.");
}

async function collectX({ env, fetchImpl, capturedAt }) {
  const bearer = nonempty(env.X_BEARER_TOKEN) ?? nonempty(env.TWITTER_BEARER_TOKEN);
  if (bearer) {
    const endpoint = "https://api.x.com/2/users/by/username/lofigirl?user.fields=public_metrics";
    try {
      const payload = await fetchJson(fetchImpl, endpoint, {
        Authorization: `Bearer ${bearer}`,
      });
      const followers = strictPositiveInteger(
        payload?.data?.public_metrics?.followers_count,
      );
      if (followers === null) throw new Error("followers_count X absent.");
      return observation({
        capturedAt,
        followers,
        precision: "exact",
        sourceUrl: "https://api.x.com/2/users/by/username/lofigirl",
        label: "X API v2 User Lookup · public_metrics.followers_count",
      });
    } catch {
      // The public profile may still expose an honestly rounded counter.
    }
  }

  const html = await fetchText(fetchImpl, PROFILE_URLS.x, {
    Accept: "text/html,application/xhtml+xml",
  });
  const label = firstMatch(html, [
    /([\d.,]+\s*[KMB]?)\s+(?:Followers|abonnés)/i,
    /"followers_count"\s*:\s*"?(\d+)"?/i,
  ]);
  const followers = compactCount(label);
  if (followers === null) throw new Error("Compteur public X non parsable.");
  return observation({
    capturedAt,
    followers,
    precision: "platform-rounded",
    sourceUrl: PROFILE_URLS.x,
    label: `Profil public X · ${cleanLabel(label)}`,
  });
}

export function compactCount(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const decoded = decodeJsonEscapes(value)
    .replace(/[\u00a0\u202f\s]/g, "")
    .trim()
    .toUpperCase();
  const match = decoded.match(/^([\d.,]+)([KMB])?$/);
  if (!match) return null;
  const suffix = match[2] ?? "";
  const multiplier = { "": 1, K: 1_000, M: 1_000_000, B: 1_000_000_000 }[suffix];
  const decimal = suffix
    ? Number(match[1].replace(",", "."))
    : Number(match[1].replace(/[.,]/g, ""));
  const count = Math.round(decimal * multiplier);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function validateCollectedObservation(value) {
  const candidate = observation(value);
  // Reuse the complete validator without exporting a weaker partial contract.
  assertAudienceHistory({
    version: 2,
    generatedAt: candidate.capturedAt,
    platforms: Object.fromEntries(
      AUDIENCE_PLATFORMS.map((platform) => [platform, {
        profileUrl: PROFILE_URLS[platform],
        observations: [{ ...candidate }],
        engagementByPeriod: emptyEngagementByPeriod(),
      }]),
    ),
  });
  return candidate;
}

function observation(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Le collecteur n’a pas retourné d’observation.");
  }
  return {
    capturedAt: value.capturedAt,
    followers: value.followers,
    precision: value.precision,
    sourceUrl: value.sourceUrl,
    label: value.label,
  };
}

async function fetchJson(fetchImpl, url, headers) {
  return JSON.parse(await fetchText(fetchImpl, url, {
    Accept: "application/json",
    ...headers,
  }));
}

async function fetchText(fetchImpl, url, headers) {
  const response = await fetchImpl(url, {
    headers: {
      "User-Agent": "lofi-social-radar/1.0",
      ...headers,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response?.ok) {
    throw new Error(`Source indisponible (${response?.status ?? "sans statut"}).`);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("Réponse audience trop volumineuse.");
  }
  return text;
}

function firstMatch(source, patterns) {
  if (typeof source !== "string") return null;
  const representations = [source, decodeJsonEscapes(source)];
  for (const representation of representations) {
    for (const pattern of patterns) {
      const value = representation.match(pattern)?.[1];
      if (value) return decodeJsonEscapes(value);
    }
  }
  return null;
}

function decodeJsonEscapes(value) {
  return String(value)
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"');
}

function strictPositiveInteger(value) {
  const count = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function cleanLabel(value) {
  return decodeJsonEscapes(value ?? "compteur observé").replace(/\s+/g, " ").trim();
}

function nonempty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function canonicalNow(value) {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("Date de collecte invalide.");
  return date.toISOString();
}

function parisCalendarDay(value) {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonAtomically(path, value) {
  const temporary = `${path}.${process.pid}.next`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "Échec inconnu.");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  collectAudienceHistory()
    .then(({ successes, failures }) => {
      process.stdout.write(`${JSON.stringify({ successes, failures }, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
