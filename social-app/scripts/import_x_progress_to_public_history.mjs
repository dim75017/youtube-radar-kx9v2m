/**
 * Import a certified X API collection into data/public-history.json.
 *
 * A completed Full Archive pass replaces the previous X slice. A completed
 * incremental pass only appends or enriches rows and can never remove one.
 * Both modes fail closed when the collector checkpoint is incomplete or when
 * the input does not match the official collector schema.
 */
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { hasUnpairedSurrogate, sanitizeJsonUnicode, truncateUnicode } from "./lib/well_formed_unicode.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_PROGRESS_PATH = resolve(ROOT, "work", "x-scan-progress.json");
const DEFAULT_HISTORY_PATH = resolve(ROOT, "data", "public-history.json");
const DEFAULT_SUMMARY_PATH = resolve(ROOT, "data", "public-history-summary.json");
const PROVIDER = "x-api-v2-full-archive";
const ENDPOINT = "https://api.x.com/2/tweets/search/all";
const QUERY = "from:lofigirl -is:retweet";
const START_TIME = "2006-03-21T00:00:00Z";
const COMPLETE_STATUS = "complete-api-full-archive";
const X_ACCOUNT_URL = "https://x.com/lofigirl";
const FORMATS = new Set(["static", "text", "video"]);
const MEDIA_TYPES = new Set(["animated_gif", "photo", "video"]);

function parseOptions(argv) {
  const options = { dryRun: false };
  for (const argument of argv) {
    if (argument === "--dry-run") options.dryRun = true;
    else throw new Error(`Option inconnue : ${argument}`);
  }
  return options;
}

function configuredPath(environmentName, fallback) {
  const configured = process.env[environmentName];
  if (!configured) return fallback;
  return isAbsolute(configured) ? configured : resolve(ROOT, configured);
}

async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${label} illisible (${path}) : ${error?.message ?? error}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} n'est pas un JSON valide (${path}) : ${error?.message ?? error}`);
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} doit être un objet.`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} doit être un tableau.`);
  return value;
}

function requireString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} doit être une chaîne${allowEmpty ? "" : " non vide"}.`);
  }
  return value;
}

function requireNullableString(value, label) {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${label} doit être une chaîne ou null.`);
  }
  return value;
}

function requireIso(value, label) {
  const string = requireString(value, label);
  if (!Number.isFinite(Date.parse(string))) throw new Error(`${label} n'est pas une date ISO valide.`);
  return string;
}

function requireNullableMetric(value, label) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} doit être un entier positif ou nul, ou null.`);
  }
  return value;
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} doit être un entier positif ou nul.`);
  }
  return value;
}

function requireSnowflake(value, label) {
  const id = requireString(String(value ?? ""), label);
  if (!/^\d{1,30}$/.test(id) || BigInt(id) <= 0n) {
    throw new Error(`${label} n'est pas un identifiant X valide.`);
  }
  return id;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function titleFromText(value) {
  const title = String(value ?? "").replace(/\s+/g, " ").trim();
  return title ? truncateUnicode(title, 180) : "Post X Lofi Girl";
}

function markerActivityAt(marker) {
  if (!isRecord(marker)) return Number.NEGATIVE_INFINITY;
  for (const key of ["completedAt", "lastPageAt", "startedAt"]) {
    if (typeof marker[key] === "string" && Number.isFinite(Date.parse(marker[key]))) {
      return Date.parse(marker[key]);
    }
  }
  return Number.NEGATIVE_INFINITY;
}

function activeScan(progress) {
  const candidates = [];
  if (progress.xApiFullArchive != null) {
    candidates.push({ mode: "full-archive", marker: progress.xApiFullArchive });
  }
  if (progress.xApiIncremental != null) {
    candidates.push({ mode: "incremental", marker: progress.xApiIncremental });
  }
  if (!candidates.length) {
    throw new Error("Import X refusé : aucun checkpoint Full Archive ou incrémental n'est présent.");
  }
  candidates.sort((left, right) => markerActivityAt(right.marker) - markerActivityAt(left.marker));
  return candidates[0];
}

function validateMarker(mode, value, postCount) {
  const marker = requireRecord(value, `checkpoint ${mode}`);
  if (marker.provider !== PROVIDER) {
    throw new Error(`Import X refusé : provider inattendu (${String(marker.provider ?? "absent")}).`);
  }
  if (marker.endpoint !== ENDPOINT) {
    throw new Error(`Import X refusé : endpoint inattendu (${String(marker.endpoint ?? "absent")}).`);
  }
  if (marker.query !== QUERY) {
    throw new Error(`Import X refusé : requête inattendue (${String(marker.query ?? "absente")}).`);
  }
  if (marker.mode !== mode) {
    throw new Error(`Import X refusé : le checkpoint actif annonce le mode ${String(marker.mode ?? "absent")} au lieu de ${mode}.`);
  }
  if (marker.nextToken !== null) {
    throw new Error("Import X refusé : le checkpoint conserve un nextToken, le scan n'est donc pas terminé.");
  }
  requireIso(marker.startedAt, `${mode}.startedAt`);
  requireIso(marker.lastPageAt, `${mode}.lastPageAt`);
  requireIso(marker.completedAt, `${mode}.completedAt`);
  const resultCount = requireCount(marker.resultCount, `${mode}.resultCount`);
  if (resultCount !== postCount) {
    throw new Error(`Import X refusé : resultCount=${resultCount}, mais posts contient ${postCount} ligne(s).`);
  }
  requireCount(marker.pagesThisRun, `${mode}.pagesThisRun`);
  requireCount(marker.fetchedThisRun, `${mode}.fetchedThisRun`);

  if (mode === "full-archive") {
    if (marker.startTime !== START_TIME || marker.sinceId !== null) {
      throw new Error("Import X refusé : le Full Archive ne porte pas la fenêtre historique attendue.");
    }
    if (postCount === 0) throw new Error("Import X refusé : un Full Archive vide ne peut pas remplacer l'historique public.");
    if (marker.fetchedThisRun < postCount) {
      throw new Error("Import X refusé : fetchedThisRun est inférieur au nombre de posts uniques.");
    }
  } else {
    if (marker.startTime !== null) {
      throw new Error("Import X refusé : un checkpoint incrémental doit avoir startTime=null.");
    }
    requireSnowflake(marker.sinceId, "incremental.sinceId");
    const observedIds = requireArray(marker.observedIds, "incremental.observedIds");
    const uniqueObservedIds = new Set();
    for (const [index, value] of observedIds.entries()) {
      const id = requireSnowflake(value, `incremental.observedIds[${index}]`);
      if (uniqueObservedIds.has(id)) {
        throw new Error(`Import X refusé : incremental.observedIds contient le doublon ${id}.`);
      }
      uniqueObservedIds.add(id);
    }
    const pagesSinceBaseline = requireCount(marker.pagesSinceBaseline, "incremental.pagesSinceBaseline");
    const fetchedSinceBaseline = requireCount(marker.fetchedSinceBaseline, "incremental.fetchedSinceBaseline");
    if (pagesSinceBaseline === 0) {
      throw new Error("Import X refusé : un checkpoint incrémental terminé doit avoir lu au moins une page.");
    }
    if (fetchedSinceBaseline < uniqueObservedIds.size) {
      throw new Error("Import X refusé : fetchedSinceBaseline est inférieur au nombre d'identifiants observés.");
    }
  }
  return marker;
}

function validateMedia(value, label) {
  const media = requireArray(value, label);
  return media.map((entry, index) => {
    const item = requireRecord(entry, `${label}[${index}]`);
    requireString(item.mediaKey, `${label}[${index}].mediaKey`);
    if (!MEDIA_TYPES.has(item.type)) {
      throw new Error(`${label}[${index}].type est inconnu (${String(item.type ?? "absent")}).`);
    }
    requireNullableString(item.url, `${label}[${index}].url`);
    requireNullableString(item.previewImageUrl, `${label}[${index}].previewImageUrl`);
    requireNullableMetric(item.width, `${label}[${index}].width`);
    requireNullableMetric(item.height, `${label}[${index}].height`);
    requireNullableMetric(item.durationMs, `${label}[${index}].durationMs`);
    requireNullableString(item.altText, `${label}[${index}].altText`);
    if (item.publicMetrics !== null && !isRecord(item.publicMetrics)) {
      throw new Error(`${label}[${index}].publicMetrics doit être un objet ou null.`);
    }
    return cloneJson(item);
  });
}

function metricHistoryFromRaw(raw) {
  if (!isRecord(raw) || raw.metricHistory == null) return [];
  const history = requireArray(raw.metricHistory, "raw.metricHistory");
  return history.map((entry, index) => {
    const point = requireRecord(entry, `raw.metricHistory[${index}]`);
    return {
      capturedAt: requireIso(point.capturedAt ?? point.captured_at, `raw.metricHistory[${index}].capturedAt`),
      views: requireNullableMetric(point.views, `raw.metricHistory[${index}].views`),
      likes: requireNullableMetric(point.likes, `raw.metricHistory[${index}].likes`),
      comments: requireNullableMetric(point.comments, `raw.metricHistory[${index}].comments`),
      shares: requireNullableMetric(point.shares, `raw.metricHistory[${index}].shares`),
      saves: requireNullableMetric(point.saves, `raw.metricHistory[${index}].saves`),
      pollVotes: point.pollVotes == null && point.poll_votes == null
        ? null
        : requireNullableMetric(point.pollVotes ?? point.poll_votes, `raw.metricHistory[${index}].pollVotes`),
      source: requireNullableString(point.source ?? null, `raw.metricHistory[${index}].source`),
    };
  });
}

function mergeMetricHistory(...histories) {
  const byCapturedAt = new Map();
  for (const history of histories) {
    for (const point of history) {
      const current = byCapturedAt.get(point.capturedAt);
      byCapturedAt.set(point.capturedAt, {
        capturedAt: point.capturedAt,
        views: point.views ?? current?.views ?? null,
        likes: point.likes ?? current?.likes ?? null,
        comments: point.comments ?? current?.comments ?? null,
        shares: point.shares ?? current?.shares ?? null,
        saves: point.saves ?? current?.saves ?? null,
        pollVotes: point.pollVotes ?? current?.pollVotes ?? null,
        source: point.source ?? current?.source ?? null,
      });
    }
  }
  return [...byCapturedAt.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
}

function normalizeApiPost(value, index, marker) {
  const rawRow = requireRecord(value, `posts[${index}]`);
  const rawTitle = requireString(rawRow.title, `posts[${index}].title`, { allowEmpty: true });
  const titleNeedsRepair = hasUnpairedSurrogate(rawTitle);
  const row = sanitizeJsonUnicode(rawRow);
  const id = requireSnowflake(row.externalId ?? row.id, `posts[${index}].externalId`);
  if (row.id != null && requireSnowflake(row.id, `posts[${index}].id`) !== id) {
    throw new Error(`posts[${index}] contient deux identifiants différents.`);
  }
  if (row.platform !== "x") throw new Error(`posts[${index}].platform doit être "x".`);
  const expectedUrl = `https://x.com/lofigirl/status/${id}`;
  if (row.url !== expectedUrl) throw new Error(`posts[${index}].url ne correspond pas à l'identifiant ${id}.`);

  const text = requireString(row.text, `posts[${index}].text`, { allowEmpty: true });
  const normalizedTitle = requireString(row.title, `posts[${index}].title`, { allowEmpty: true });
  // Preserve existing titles byte-for-byte unless they contain a malformed
  // surrogate. Those legacy titles are rebuilt from the complete post text,
  // which restores the emoji instead of replacing half of it with U+FFFD.
  const title = titleNeedsRepair ? titleFromText(text) : normalizedTitle;
  const publishedAt = requireIso(row.publishedAt, `posts[${index}].publishedAt`);
  if (row.time != null && requireIso(row.time, `posts[${index}].time`) !== publishedAt) {
    throw new Error(`posts[${index}] contient deux dates de publication différentes.`);
  }
  if (!FORMATS.has(row.format)) {
    throw new Error(`posts[${index}].format est inconnu (${String(row.format ?? "absent")}).`);
  }
  const thumbnailUrl = requireNullableString(row.thumbnailUrl, `posts[${index}].thumbnailUrl`);
  if (row.image != null && requireNullableString(row.image, `posts[${index}].image`) !== thumbnailUrl) {
    throw new Error(`posts[${index}] contient deux miniatures différentes.`);
  }

  const collectedMetrics = {
    views: requireNullableMetric(row.views, `posts[${index}].views`),
    likes: requireNullableMetric(row.likes, `posts[${index}].likes`),
    comments: requireNullableMetric(row.comments, `posts[${index}].comments`),
    shares: requireNullableMetric(row.shares, `posts[${index}].shares`),
    saves: requireNullableMetric(row.saves, `posts[${index}].saves`),
  };
  // Text-only rows that were already present in the browser checkpoint can
  // legitimately have no `media` key after the API merge. Treat that exact
  // absence as an empty attachment list; any non-text format will still fail
  // the format/media consistency check below.
  const media = validateMedia(row.media ?? [], `posts[${index}].media`);
  const hasVideo = media.some((item) => item.type === "video" || item.type === "animated_gif");
  const hasPhoto = media.some((item) => item.type === "photo");
  const expectedFormat = hasVideo ? "video" : hasPhoto ? "static" : "text";
  if (row.format !== expectedFormat) {
    throw new Error(`posts[${index}].format=${row.format}, mais les médias indiquent ${expectedFormat}.`);
  }

  const raw = requireRecord(row.raw, `posts[${index}].raw`);
  if (raw.collector !== PROVIDER) {
    throw new Error(`posts[${index}] ne provient pas du collecteur officiel ${PROVIDER}.`);
  }
  const firstObservedAt = requireIso(raw.firstObservedAt, `posts[${index}].raw.firstObservedAt`);
  const lastObservedAt = requireIso(raw.lastObservedAt, `posts[${index}].raw.lastObservedAt`);
  const publicMetrics = requireRecord(raw.publicMetrics, `posts[${index}].raw.publicMetrics`);
  const apiMetrics = {
    views: requireNullableMetric(publicMetrics.impression_count, `posts[${index}].raw.publicMetrics.impression_count`),
    likes: requireNullableMetric(publicMetrics.like_count, `posts[${index}].raw.publicMetrics.like_count`),
    comments: requireNullableMetric(publicMetrics.reply_count, `posts[${index}].raw.publicMetrics.reply_count`),
    saves: requireNullableMetric(publicMetrics.bookmark_count, `posts[${index}].raw.publicMetrics.bookmark_count`),
  };
  const retweets = requireNullableMetric(publicMetrics.retweet_count, `posts[${index}].raw.publicMetrics.retweet_count`);
  const quotes = requireNullableMetric(publicMetrics.quote_count, `posts[${index}].raw.publicMetrics.quote_count`);
  apiMetrics.shares = retweets == null && quotes == null ? null : (retweets ?? 0) + (quotes ?? 0);
  const priorPublicProfileMetrics = {};
  const metrics = {};
  for (const key of ["views", "likes", "comments", "shares", "saves"]) {
    const collected = collectedMetrics[key];
    const official = apiMetrics[key];
    if (collected !== official) {
      // mergePost intentionally retained the maximum from the earlier browser
      // checkpoint. A count can later decline (unlikes/unreposts), so keep that
      // earlier value as provenance while publishing the latest API snapshot.
      if (collected == null || (official != null && collected < official)) {
        throw new Error(`posts[${index}].${key} ne correspond pas à raw.publicMetrics.`);
      }
      priorPublicProfileMetrics[key] = collected;
    }
    metrics[key] = official ?? collected;
  }

  const previousHistory = metricHistoryFromRaw(raw);
  const observation = {
    capturedAt: lastObservedAt || marker.completedAt,
    ...metrics,
    pollVotes: null,
    source: PROVIDER,
  };
  return {
    platform: "x",
    externalId: id,
    url: expectedUrl,
    title,
    text,
    format: row.format,
    thumbnailUrl,
    publishedAt,
    ...metrics,
    raw: {
      ...cloneJson(raw),
      collector: PROVIDER,
      firstObservedAt,
      lastObservedAt,
      publishedAtPrecision: "exact",
      media,
      ...(Object.keys(priorPublicProfileMetrics).length
        ? { priorPublicProfileMetricMaxima: priorPublicProfileMetrics }
        : {}),
      metricHistory: mergeMetricHistory(previousHistory, [observation]),
    },
  };
}

function validateSnapshot(value) {
  const snapshot = requireRecord(value, "data/public-history.json");
  requireIso(snapshot.generatedAt, "public-history.generatedAt");
  requireArray(snapshot.coverage, "public-history.coverage");
  requireArray(snapshot.posts, "public-history.posts");
  const xCoverage = snapshot.coverage.filter((item) => isRecord(item) && item.platform === "x");
  if (xCoverage.length > 1) throw new Error("public-history.coverage contient plusieurs entrées X.");
  const xIds = new Set();
  for (const [index, post] of snapshot.posts.entries()) {
    requireRecord(post, `public-history.posts[${index}]`);
    if (post.platform !== "x") continue;
    const id = requireSnowflake(post.externalId, `public-history.posts[${index}].externalId`);
    if (xIds.has(id)) throw new Error(`public-history contient un doublon X pour ${id}.`);
    xIds.add(id);
  }
  return { snapshot, xCoverage: xCoverage[0] ?? null };
}

function isoBounds(posts) {
  const dates = posts.map((post) => post.publishedAt).sort();
  return { oldestPublishedAt: dates[0] ?? null, newestPublishedAt: dates.at(-1) ?? null };
}

function fullCoverage(posts, marker, importedAt) {
  const bounds = isoBounds(posts);
  return {
    platform: "x",
    accountUrl: X_ACCOUNT_URL,
    scope: "posts originaux et réponses publics de @lofigirl via X API v2 Full Archive, retweets exclus",
    status: COMPLETE_STATUS,
    itemCount: posts.length,
    ...bounds,
    limitations: [
      `Source officielle : X API v2 Full Archive (${ENDPOINT}), requête « ${QUERY} » depuis ${START_TIME}.`,
      "Les retweets sont exclus volontairement ; les posts originaux et les réponses publiés par @lofigirl sont inclus.",
      "Les contenus supprimés, privés, protégés ou retenus par X ne peuvent pas être retournés par l'API.",
      `Les compteurs publics sont des instantanés relevés au plus tard le ${marker.completedAt} et peuvent évoluer.`,
    ],
    provenance: {
      provider: PROVIDER,
      endpoint: ENDPOINT,
      query: QUERY,
      startTime: START_TIME,
      fullArchiveStartedAt: marker.startedAt,
      fullArchiveCompletedAt: marker.completedAt,
      apiRowsRead: marker.fetchedThisRun,
      uniquePostsImported: posts.length,
      importedAt,
    },
  };
}

function coverageWithIncremental(existing, posts, marker, importedAt) {
  const provenance = isRecord(existing.provenance) ? existing.provenance : {};
  return {
    ...existing,
    status: COMPLETE_STATUS,
    itemCount: posts.length,
    ...isoBounds(posts),
    provenance: {
      ...provenance,
      lastIncremental: {
        provider: PROVIDER,
        endpoint: ENDPOINT,
        query: QUERY,
        sinceId: marker.sinceId,
        startedAt: marker.startedAt,
        completedAt: marker.completedAt,
        apiRowsRead: marker.fetchedSinceBaseline,
        rowsInCheckpoint: marker.resultCount,
        importedAt,
      },
    },
  };
}

function replaceCoverage(coverage, incoming) {
  const index = coverage.findIndex((item) => isRecord(item) && item.platform === "x");
  if (index < 0) return [...coverage, incoming];
  return coverage.map((item, itemIndex) => itemIndex === index ? incoming : item);
}

function mergeIncrementalPost(existing, incoming) {
  if (!existing) return incoming;
  const existingRaw = isRecord(existing.raw) ? existing.raw : {};
  const incomingRaw = incoming.raw;
  const histories = mergeMetricHistory(
    metricHistoryFromRaw(existingRaw),
    metricHistoryFromRaw(incomingRaw),
  );
  return {
    ...existing,
    ...incoming,
    title: incoming.title || existing.title || "",
    text: incoming.text || existing.text || "",
    thumbnailUrl: incoming.thumbnailUrl ?? existing.thumbnailUrl ?? null,
    raw: {
      ...cloneJson(existingRaw),
      ...cloneJson(incomingRaw),
      firstObservedAt: existingRaw.firstObservedAt ?? incomingRaw.firstObservedAt,
      lastObservedAt: incomingRaw.lastObservedAt ?? existingRaw.lastObservedAt,
      media: incomingRaw.media?.length ? incomingRaw.media : existingRaw.media ?? [],
      metricHistory: histories,
    },
  };
}

function sortPosts(posts) {
  return [...posts].sort((left, right) => {
    const dateOrder = String(right.publishedAt ?? "").localeCompare(String(left.publishedAt ?? ""));
    return dateOrder || `${left.platform}:${left.externalId}`.localeCompare(`${right.platform}:${right.externalId}`);
  });
}

function latestIso(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

async function writeAtomically(path, value) {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.next`;
  try {
    const normalized = sanitizeJsonUnicode(value);
    if (hasUnpairedSurrogate(normalized)) {
      throw new Error("Refus d'ecrire un JSON contenant un surrogate UTF-16 isole.");
    }
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
    await writeFile(temporaryPath, serialized, "utf8");
    JSON.parse(await readFile(temporaryPath, "utf8"));
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const progressPath = configuredPath("X_PROGRESS_PATH", DEFAULT_PROGRESS_PATH);
  const historyPath = configuredPath("PUBLIC_HISTORY_PATH", DEFAULT_HISTORY_PATH);
  const summaryPath = configuredPath("PUBLIC_HISTORY_SUMMARY_PATH", DEFAULT_SUMMARY_PATH);
  const progress = requireRecord(await readJson(progressPath, "Progression X"), "work/x-scan-progress.json");
  const publicSummary = requireRecord(
    sanitizeJsonUnicode(await readJson(summaryPath, "Résumé de l'historique public")),
    "data/public-history-summary.json",
  );
  const { snapshot, xCoverage } = validateSnapshot(
    sanitizeJsonUnicode(await readJson(historyPath, "Historique public")),
  );
  const progressPosts = requireArray(progress.posts, "progress.posts");
  const active = activeScan(progress);
  const marker = validateMarker(active.mode, active.marker, progressPosts.length);
  const observedIds = active.mode === "incremental" ? new Set(marker.observedIds) : null;

  const incomingById = new Map();
  for (const [index, row] of progressPosts.entries()) {
    if (active.mode === "incremental") {
      const candidate = requireRecord(row, `posts[${index}]`);
      const id = requireSnowflake(candidate.externalId ?? candidate.id, `posts[${index}].externalId`);
      // Baseline rows keep the checkpoint exhaustive, but they were not read
      // in this API pass and must stay strictly untouched.
      if (!observedIds.has(id)) continue;
    }
    const post = normalizeApiPost(row, index, marker);
    if (incomingById.has(post.externalId)) {
      throw new Error(`Import X refusé : doublon ${post.externalId} dans progress.posts.`);
    }
    incomingById.set(post.externalId, post);
  }
  if (active.mode === "incremental" && incomingById.size !== observedIds.size) {
    throw new Error(`Import X refusé : ${observedIds.size} identifiant(s) ont été observés, mais ${incomingById.size} ligne(s) correspondante(s) sont présentes.`);
  }

  const nonXPosts = snapshot.posts.filter((post) => post.platform !== "x");
  const existingXPosts = snapshot.posts.filter((post) => post.platform === "x");
  const existingById = new Map(existingXPosts.map((post) => [post.externalId, post]));
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let finalXPosts;
  let nextCoverage;

  if (active.mode === "full-archive") {
    finalXPosts = [...incomingById.values()];
    if (finalXPosts.length < existingXPosts.length) {
      throw new Error(`Import X refusé : le Full Archive réduirait X de ${existingXPosts.length} à ${finalXPosts.length} posts.`);
    }
    for (const post of finalXPosts) {
      const existing = existingById.get(post.externalId);
      if (!existing) inserted += 1;
      else if (JSON.stringify(existing) === JSON.stringify(post)) unchanged += 1;
      else updated += 1;
    }
    nextCoverage = fullCoverage(finalXPosts, marker, marker.completedAt);
  } else {
    if (!xCoverage || xCoverage.status !== COMPLETE_STATUS) {
      throw new Error(`Import incrémental refusé : coverage[x].status doit déjà valoir "${COMPLETE_STATUS}".`);
    }
    if (xCoverage.itemCount !== existingXPosts.length) {
      throw new Error(`Import incrémental refusé : coverage[x].itemCount=${String(xCoverage.itemCount)} mais ${existingXPosts.length} posts X sont présents.`);
    }
    if (incomingById.size === 0) {
      process.stdout.write(`${JSON.stringify({
        dryRun: options.dryRun,
        mode: active.mode,
        previousXPosts: existingXPosts.length,
        incomingXPosts: 0,
        finalXPosts: existingXPosts.length,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        changed: false,
        willWrite: false,
        reason: "Aucun nouveau post retourné par l'API ; historique laissé strictement inchangé.",
      }, null, 2)}\n`);
      return;
    }
    const merged = new Map(existingById);
    for (const incoming of incomingById.values()) {
      const existing = merged.get(incoming.externalId);
      const next = mergeIncrementalPost(existing, incoming);
      merged.set(incoming.externalId, next);
      if (!existing) inserted += 1;
      else if (JSON.stringify(existing) === JSON.stringify(next)) unchanged += 1;
      else updated += 1;
    }
    finalXPosts = [...merged.values()];
    if (finalXPosts.length < existingXPosts.length) {
      throw new Error(`Import incrémental refusé : X passerait de ${existingXPosts.length} à ${finalXPosts.length} posts.`);
    }
    nextCoverage = coverageWithIncremental(xCoverage, finalXPosts, marker, marker.completedAt);
  }

  const finalPosts = sortPosts([...nonXPosts, ...finalXPosts]);
  const nextSnapshot = {
    ...snapshot,
    generatedAt: latestIso(snapshot.generatedAt, marker.completedAt),
    coverage: replaceCoverage(snapshot.coverage, nextCoverage),
    posts: finalPosts,
  };
  if (nextSnapshot.posts.length < snapshot.posts.length) {
    throw new Error(`Import X refusé : le snapshot total passerait de ${snapshot.posts.length} à ${nextSnapshot.posts.length} posts.`);
  }
  const nextPublicSummary = {
    ...publicSummary,
    generatedAt: nextSnapshot.generatedAt,
    totalPostCount: nextSnapshot.posts.length,
    platformCounts: {
      ...publicSummary.platformCounts,
      x: finalXPosts.length,
    },
    formatCounts: {
      ...publicSummary.formatCounts,
      x: {
        static: finalXPosts.filter((post) => post.format === "static").length,
        video: finalXPosts.filter((post) => post.format === "video").length,
        text: finalXPosts.filter((post) => post.format === "text").length,
      },
    },
    coverage: nextSnapshot.coverage,
  };
  const changed = JSON.stringify(nextSnapshot) !== JSON.stringify(snapshot);
  if (changed && !options.dryRun) {
    await Promise.all([
      writeAtomically(historyPath, nextSnapshot),
      writeAtomically(summaryPath, nextPublicSummary),
    ]);
  }

  const summary = {
    dryRun: options.dryRun,
    mode: active.mode,
    previousXPosts: existingXPosts.length,
    incomingXPosts: incomingById.size,
    finalXPosts: finalXPosts.length,
    inserted,
    updated,
    unchanged,
    ...isoBounds(finalXPosts),
    changed,
    willWrite: changed && !options.dryRun,
    coverageStatus: nextCoverage.status,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
