import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HISTORY_PATH = process.env.PUBLIC_HISTORY_PATH
  ? resolve(process.env.PUBLIC_HISTORY_PATH)
  : resolve(ROOT, "data", "public-history.json");
const SUMMARY_PATH = process.env.PUBLIC_HISTORY_SUMMARY_PATH
  ? resolve(process.env.PUBLIC_HISTORY_SUMMARY_PATH)
  : resolve(ROOT, "data", "public-history-summary.json");
const INSTAGRAM_MEDIA_DIR = process.env.OWNER_COMMENT_INSTAGRAM_MEDIA_DIR
  ? resolve(process.env.OWNER_COMMENT_INSTAGRAM_MEDIA_DIR)
  : resolve(ROOT, "public", "media", "instagram");
const INSTAGRAM_MEDIA_BASE =
  "https://dim75017.github.io/youtube-radar-kx9v2m/social/media/instagram";
const PLATFORMS = new Set(["instagram", "tiktok"]);
const MEDIA_CONCURRENCY = 4;
const MEDIA_TIMEOUT_MS = 20_000;
const MAX_MEDIA_BYTES = 5_000_000;
const RECONCILIATION_WINDOW_MS = 36 * 60 * 60 * 1_000;
const DUPLICATE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1_000;

function parseOptions(argv) {
  const options = { input: null, report: null, dryRun: false, skipMediaCache: false };
  for (const argument of argv) {
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--skip-media-cache") options.skipMediaCache = true;
    else if (argument.startsWith("--input=")) options.input = argument.slice("--input=".length);
    else if (argument.startsWith("--report=")) options.report = argument.slice("--report=".length);
    else throw new Error(`Option inconnue : ${argument}`);
  }
  if (!options.input) throw new Error("--input=<fichier JSON privé> est requis.");
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} doit être un objet.`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} doit être une chaîne non vide.`);
  }
  return value.trim();
}

function nullableString(value, label) {
  if (value == null) return null;
  return requireString(value, label);
}

function nullableCount(value, label) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} doit être un entier positif ou null.`);
  }
  return value;
}

function requireIso(value, label) {
  const normalized = requireString(value, label);
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`${label} doit être une date ISO valide.`);
  return new Date(normalized).toISOString();
}

function nullableIso(value, label) {
  return value == null ? null : requireIso(value, label);
}

function safeHttpsUrl(value, label, platform, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  const normalized = requireString(value, label);
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${label} doit être une URL valide.`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} doit utiliser HTTPS.`);
  const hostname = url.hostname.toLowerCase();
  const allowed = platform === "instagram"
    ? hostname === "instagram.com" || hostname.endsWith(".instagram.com") || hostname.endsWith(".cdninstagram.com") || hostname.endsWith(".fbcdn.net")
    : hostname === "tiktok.com" || hostname.endsWith(".tiktok.com");
  if (!allowed) throw new Error(`${label} ne correspond pas à ${platform}.`);
  return url.toString();
}

function safeInstagramActivitySourceUrl(value, platform) {
  if (value == null) return null;
  if (platform !== "instagram") {
    throw new Error("input.activitySourceUrl est réservé à Instagram.");
  }
  const normalized = requireString(value, "input.activitySourceUrl");
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("input.activitySourceUrl doit être une URL valide.");
  }
  const hostname = url.hostname.toLowerCase();
  const validHost = hostname === "instagram.com" || hostname === "www.instagram.com";
  const validPath = /^\/your_activity\/interactions\/comments\/?$/u.test(url.pathname);
  if (
    url.protocol !== "https:" ||
    !validHost ||
    !validPath ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "input.activitySourceUrl doit être la page HTTPS Instagram /your_activity/interactions/comments.",
    );
  }
  return "https://www.instagram.com/your_activity/interactions/comments/";
}

function isHostOrSubdomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function safeThumbnailUrl(value, label, platform, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  const normalized = requireString(value, label);
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${label} doit être une URL valide.`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} doit utiliser HTTPS.`);
  const hostname = url.hostname.toLowerCase();
  const allowed = platform === "instagram"
    ? ["instagram.com", "cdninstagram.com", "fbcdn.net"].some((domain) => isHostOrSubdomain(hostname, domain))
    : ["tiktokcdn.com", "tiktokcdn-eu.com", "tiktokcdn-us.com"].some((domain) => isHostOrSubdomain(hostname, domain));
  if (!allowed) throw new Error(`${label} ne correspond pas à un CDN ${platform} autorisé.`);
  return url.toString();
}

function instagramShortcode(contentUrl) {
  let url;
  try {
    url = new URL(contentUrl);
  } catch {
    return null;
  }
  return url.pathname.match(
    /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]{5,64})(?:\/|$)/,
  )?.[1] ?? null;
}

function directInstagramThumbnailUrl(contentUrl) {
  const shortcode = instagramShortcode(contentUrl);
  return shortcode ? `https://www.instagram.com/p/${shortcode}/media/?size=l` : null;
}

async function usableJpeg(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 1_000 || info.size > MAX_MEDIA_BYTES) return false;
    const bytes = await readFile(path);
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeAtomically(path, bytes) {
  const temporary = `${path}.${process.pid}.${Date.now()}.next`;
  try {
    await writeFile(temporary, bytes);
    try {
      await rename(temporary, path);
    } catch (error) {
      if (!["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(error?.code)) throw error;
      await unlink(path).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
      await rename(temporary, path);
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function cachedInstagramThumbnailUrlForKey(cacheKey) {
  return `${INSTAGRAM_MEDIA_BASE}/${cacheKey}.jpg`;
}

function unresolvedInstagramThumbnailKey(commentId) {
  const digest = createHash("sha256")
    .update(`instagram-owner-comment:${commentId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `comment-${digest}`;
}

async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function downloadInstagramThumbnail(media) {
  const destination = resolve(INSTAGRAM_MEDIA_DIR, `${media.cacheKey}.jpg`);
  if (await usableJpeg(destination)) return "cached";

  const candidates = [media.sourceUrl, media.directUrl].filter(
    (value, index, values) =>
      typeof value === "string" && value.startsWith("https://") && values.indexOf(value) === index,
  );
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.8",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0.0.0 Safari/537.36",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("image/jpeg")) {
        throw new Error(`type inattendu ${contentType || "absent"}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (
        bytes.length < 1_000 ||
        bytes.length > MAX_MEDIA_BYTES ||
        bytes[0] !== 0xff ||
        bytes[1] !== 0xd8 ||
        bytes[2] !== 0xff
      ) {
        throw new Error(`JPEG invalide (${bytes.length} octets)`);
      }
      await writeAtomically(destination, bytes);
      return "downloaded";
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Miniature Instagram ${media.cacheKey} indisponible : ${lastError?.message ?? lastError}`,
  );
}

async function cacheInstagramThumbnails(mediaItems) {
  const unique = new Map();
  for (const media of mediaItems) {
    if (media) unique.set(media.cacheKey, media);
  }
  await mkdir(INSTAGRAM_MEDIA_DIR, { recursive: true });
  const queue = [...unique.values()];
  let cursor = 0;
  let downloaded = 0;
  let cached = 0;
  const failed = [];
  async function worker() {
    while (cursor < queue.length) {
      const media = queue[cursor++];
      try {
        const result = await downloadInstagramThumbnail(media);
        if (result === "downloaded") downloaded += 1;
        else cached += 1;
      } catch (error) {
        failed.push({
          cacheKey: media.cacheKey,
          externalId: media.externalId,
          publicUrl: media.publicUrl,
          error: error?.message ?? String(error),
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MEDIA_CONCURRENCY, Math.max(1, queue.length)) }, () => worker()),
  );
  return { downloaded, cached, failed };
}

function derivedAuthorProfileUrl(platform, authorHandle) {
  if (typeof authorHandle !== "string") return null;
  const normalized = authorHandle.trim().replace(/^@/u, "");
  if (!/^[A-Za-z0-9._]{1,30}$/u.test(normalized)) return null;
  if (platform === "instagram") {
    return `https://www.instagram.com/${encodeURIComponent(normalized)}/`;
  }
  if (platform === "tiktok") {
    return `https://www.tiktok.com/@${encodeURIComponent(normalized)}`;
  }
  return null;
}

function precision(value, label) {
  if (value == null) return "unknown";
  if (!["exact", "platform-rounded", "unknown"].includes(value)) {
    throw new Error(`${label} est invalide.`);
  }
  return value;
}

function publishedAtPrecision(value, publishedAt, label) {
  if (!publishedAt) {
    if (value != null && value !== "unknown") {
      throw new Error(`${label} doit être unknown lorsque publishedAt est null.`);
    }
    return "unknown";
  }
  if (value == null) return "exact";
  if (!['exact', 'approximate', 'unknown'].includes(value)) {
    throw new Error(`${label} est invalide.`);
  }
  return value;
}

function effectivePublishedAtPrecision(post) {
  const explicit = post?.raw?.publishedAtPrecision;
  if (explicit === "exact" || explicit === "approximate") return explicit;
  if (
    post?.platform === "instagram" &&
    post?.publishedAt &&
    (post?.raw?.commentIdKind === "native" || post?.raw?.nativeCommentId)
  ) {
    return "exact";
  }
  return "unknown";
}

function preferredPublishedAt(existing, incoming) {
  if (!existing?.publishedAt) {
    return {
      value: incoming?.publishedAt ?? null,
      precision: effectivePublishedAtPrecision(incoming),
    };
  }
  if (!incoming?.publishedAt) {
    return {
      value: existing.publishedAt,
      precision: effectivePublishedAtPrecision(existing),
    };
  }
  const rank = { unknown: 0, approximate: 1, exact: 2 };
  const existingPrecision = effectivePublishedAtPrecision(existing);
  const incomingPrecision = effectivePublishedAtPrecision(incoming);
  if (rank[incomingPrecision] > rank[existingPrecision]) {
    return { value: incoming.publishedAt, precision: incomingPrecision };
  }
  return { value: existing.publishedAt, precision: existingPrecision };
}

function commentIdKind(value, label) {
  if (value == null) return "native";
  if (!["native", "synthetic"].includes(value)) {
    throw new Error(`${label} doit être native ou synthetic.`);
  }
  return value;
}

function normalizedUnicodeText(value) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function canonicalPlatformTarget(platform, ...candidates) {
  const contentIds = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const normalized = candidate.trim();
    let url = null;
    try {
      url = new URL(normalized);
    } catch {
      contentIds.push(normalized.normalize("NFKC"));
      continue;
    }

    if (platform === "instagram") {
      const shortcode = instagramShortcode(url.toString());
      if (shortcode) return `instagram:shortcode:${shortcode}`;
    } else {
      const contentId = url.pathname.match(
        /^\/(?:@[^/]+\/)?(?:video|photo)\/(\d{10,30})(?:\/|$)/,
      )?.[1];
      if (contentId) return `tiktok:content:${contentId}`;
    }

    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return `${platform}:url:${url.toString()}`;
  }

  const contentId = contentIds.find(Boolean);
  return contentId ? `${platform}:content:${contentId}` : null;
}

function normalizedIdentity({ platform, text, publishedAt, target, url }) {
  return {
    targetKey: canonicalPlatformTarget(
      platform,
      target?.url,
      url,
      target?.contentId,
      target?.content_id,
    ),
    text: normalizedUnicodeText(text),
    publishedAt: nullableIdentityIso(publishedAt),
  };
}

function nullableIdentityIso(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function identityDateMatches(left, right) {
  if (!left || !right) return false;
  return Math.abs(Date.parse(left) - Date.parse(right)) <= RECONCILIATION_WINDOW_MS;
}

function identitiesMatch(left, right) {
  return Boolean(
    left.targetKey &&
      left.targetKey === right.targetKey &&
      left.text === right.text &&
      identityDateMatches(left.publishedAt, right.publishedAt),
  );
}

function duplicateContradictions(left, right) {
  const conflicts = [];
  if (left.idKind !== right.idKind) conflicts.push("idKind");
  if (left.identity.text !== right.identity.text) conflicts.push("text");
  if (
    left.identity.targetKey &&
    right.identity.targetKey &&
    left.identity.targetKey !== right.identity.targetKey
  ) {
    conflicts.push("target");
  }
  if (
    left.identity.publishedAt &&
    right.identity.publishedAt &&
    effectivePublishedAtPrecision(left.post) === "exact" &&
    effectivePublishedAtPrecision(right.post) === "exact" &&
    Math.abs(
      Date.parse(left.identity.publishedAt) - Date.parse(right.identity.publishedAt),
    ) > DUPLICATE_TIMESTAMP_TOLERANCE_MS
  ) {
    conflicts.push("publishedAt");
  }
  for (const metric of ["likes", "comments"]) {
    const leftValue = left.post?.[metric];
    const rightValue = right.post?.[metric];
    if (leftValue != null && rightValue != null && leftValue !== rightValue) {
      conflicts.push(metric === "comments" ? "replies" : metric);
    }
  }
  return conflicts;
}

function unavailableTarget(value, label) {
  const unavailable = value.unavailable ?? false;
  if (typeof unavailable !== "boolean") {
    throw new Error(`${label}.unavailable doit être un booléen.`);
  }
  const status = nullableString(value.status, `${label}.status`);
  if (status != null && !["available", "unavailable", "deleted"].includes(status)) {
    throw new Error(`${label}.status est invalide.`);
  }
  return unavailable || status === "unavailable" || status === "deleted";
}

function normalizedComment(entry, index, platform, capturedAt, activitySourceUrl) {
  const row = requireRecord(entry, `comments[${index}]`);
  const id = requireString(row.id, `comments[${index}].id`);
  if (!/^[A-Za-z0-9._:-]{1,240}$/.test(id)) {
    throw new Error(`comments[${index}].id contient des caractères non autorisés.`);
  }
  const text = requireString(row.text, `comments[${index}].text`);
  const target = requireRecord(row.target, `comments[${index}].target`);
  const idKind = commentIdKind(row.idKind, `comments[${index}].idKind`);
  const isUnavailable = unavailableTarget(target, `comments[${index}].target`);
  const explicitContentUrl = safeHttpsUrl(
    target.url,
    `comments[${index}].target.url`,
    platform,
    { nullable: true },
  );
  const explicitCommentUrl = safeHttpsUrl(
    row.url,
    `comments[${index}].url`,
    platform,
    { nullable: true },
  );
  const publishedAt = nullableIso(row.publishedAt, `comments[${index}].publishedAt`);
  const datePrecision = publishedAtPrecision(
    row.publishedAtPrecision,
    publishedAt,
    `comments[${index}].publishedAtPrecision`,
  );
  const observation = row.observation == null
    ? {}
    : requireRecord(row.observation, `comments[${index}].observation`);
  const relativeAge = nullableString(
    observation.relativeAge,
    `comments[${index}].observation.relativeAge`,
  );
  const stableSyntheticId = nullableString(
    observation.stableSyntheticId,
    `comments[${index}].observation.stableSyntheticId`,
  );
  if (stableSyntheticId && !/^instagram-synthetic-[a-f0-9]{64}$/u.test(stableSyntheticId)) {
    throw new Error(`comments[${index}].observation.stableSyntheticId est invalide.`);
  }
  const contentId = nullableString(target.contentId, `comments[${index}].target.contentId`);
  const identity = normalizedIdentity({
    platform,
    text,
    publishedAt,
    target: { url: explicitContentUrl, contentId },
    url: explicitCommentUrl,
  });

  const authorizedActivityFallback =
    platform === "instagram" && isUnavailable ? activitySourceUrl : null;
  if (!explicitContentUrl && !explicitCommentUrl && !authorizedActivityFallback) {
    if (!isUnavailable) {
      throw new Error(
        `comments[${index}] doit fournir target.url ou url, sauf cible explicitement indisponible.`,
      );
    }
    return {
      id,
      idKind,
      identity,
      post: null,
      media: null,
      quarantine: {
        id,
        reason: "target-unavailable-without-public-url",
        text,
        publishedAt,
        target: {
          contentId,
          title: nullableString(target.title, `comments[${index}].target.title`),
          unavailable: true,
        },
      },
    };
  }

  const contentUrl = explicitContentUrl ?? explicitCommentUrl;
  const commentUrl = explicitCommentUrl ?? explicitContentUrl ?? authorizedActivityFallback;
  const audienceValue = nullableCount(target.audienceValue, `comments[${index}].target.audienceValue`);
  const audiencePrecision = precision(target.audiencePrecision, `comments[${index}].target.audiencePrecision`);
  const sourceThumbnailUrl = safeThumbnailUrl(
    target.thumbnailUrl,
    `comments[${index}].target.thumbnailUrl`,
    platform,
    { nullable: true },
  );
  let thumbnailUrl = sourceThumbnailUrl;
  let media = null;
  if (platform === "instagram") {
    if (isUnavailable) {
      if (sourceThumbnailUrl) {
        const cacheKey = unresolvedInstagramThumbnailKey(id);
        thumbnailUrl = cachedInstagramThumbnailUrlForKey(cacheKey);
        media = {
          cacheKey,
          externalId: `comment:${id}`,
          publicUrl: thumbnailUrl,
          sourceUrl: sourceThumbnailUrl,
          directUrl: null,
        };
      } else {
        thumbnailUrl = null;
      }
    } else {
      const shortcode = instagramShortcode(contentUrl);
      thumbnailUrl = shortcode
        ? cachedInstagramThumbnailUrlForKey(shortcode)
        : sourceThumbnailUrl;
      media = shortcode
        ? {
            cacheKey: shortcode,
            externalId: `comment:${id}`,
            publicUrl: thumbnailUrl,
            sourceUrl: sourceThumbnailUrl,
            directUrl: directInstagramThumbnailUrl(contentUrl),
          }
        : null;
    }
  }
  const metrics = row.metrics == null ? {} : requireRecord(row.metrics, `comments[${index}].metrics`);
  const likes = nullableCount(metrics.likes, `comments[${index}].metrics.likes`);
  const replies = nullableCount(metrics.replies, `comments[${index}].metrics.replies`);
  const targetTitle = nullableString(target.title, `comments[${index}].target.title`) ??
    (isUnavailable ? `Contenu ${platform} indisponible` : `Contenu ${platform} commenté`);
  const authorHandle = nullableString(
    target.authorHandle,
    `comments[${index}].target.authorHandle`,
  );
  const explicitAuthorProfileUrl = safeHttpsUrl(
    target.authorProfileUrl,
    `comments[${index}].target.authorProfileUrl`,
    platform,
    { nullable: true },
  );
  const source = `authorized-${platform}-activity`;
  const metricHistory = likes == null && replies == null
    ? []
    : [{
        capturedAt,
        views: null,
        likes,
        comments: replies,
        shares: null,
        saves: null,
        pollVotes: null,
        source,
      }];

  const post = {
    platform,
    externalId: `comment:${id}`,
    url: commentUrl,
    title: targetTitle,
    text,
    format: "comment",
    thumbnailUrl,
    publishedAt,
    views: null,
    likes,
    comments: replies,
    shares: null,
    saves: null,
    raw: {
      collector: source,
      activityType: "published-comment",
      sourceKind: source,
      commentIdKind: idKind,
      ...(idKind === "native" ? { nativeCommentId: id } : {}),
      publishedAtPrecision: datePrecision,
      firstObservedAt: capturedAt,
      lastObservedAt: capturedAt,
      ...(relativeAge
        ? {
            commentObservation: {
              relativeAge,
              observedAt: nullableIso(
                observation.observedAt,
                `comments[${index}].observation.observedAt`,
              ) ?? capturedAt,
              ...(stableSyntheticId ? { stableSyntheticId } : {}),
            },
          }
        : {}),
      commentTarget: {
        contentId,
        url: explicitContentUrl,
        title: targetTitle,
        thumbnailUrl,
        authorHandle,
        authorName: nullableString(target.authorName, `comments[${index}].target.authorName`),
        authorProfileUrl:
          explicitAuthorProfileUrl ?? derivedAuthorProfileUrl(platform, authorHandle),
        audienceValue,
        audienceLabel: nullableString(target.audienceLabel, `comments[${index}].target.audienceLabel`),
        audiencePrecision,
        audienceObservedAt: nullableIso(target.audienceObservedAt, `comments[${index}].target.audienceObservedAt`),
        source,
        unavailable: isUnavailable,
      },
      metricHistory,
    },
  };
  return {
    id,
    idKind,
    identity,
    post,
    media,
    quarantine: null,
  };
}

function mergeComment(existing, incoming) {
  if (!existing) return incoming;
  const existingTarget = isRecord(existing.raw?.commentTarget) ? existing.raw.commentTarget : {};
  const incomingTarget = isRecord(incoming.raw?.commentTarget) ? incoming.raw.commentTarget : {};
  const history = new Map();
  for (const point of [
    ...(Array.isArray(existing.raw?.metricHistory) ? existing.raw.metricHistory : []),
    ...(Array.isArray(incoming.raw?.metricHistory) ? incoming.raw.metricHistory : []),
  ]) {
    if (point?.capturedAt && Number.isFinite(Date.parse(point.capturedAt))) {
      const previousPoint = history.get(point.capturedAt) ?? {};
      history.set(point.capturedAt, mergeNullableRecord(previousPoint, point));
    }
  }
  const incomingTargetUnavailable = incomingTarget.unavailable === true;
  const preserveExistingTarget =
    incomingTargetUnavailable && hasAvailablePublicTarget(existingTarget);
  const mergedTarget = preserveExistingTarget
    ? {
        ...incomingTarget,
        ...existingTarget,
        unavailable: false,
      }
    : mergeNullableRecord(existingTarget, incomingTarget);
  const published = preferredPublishedAt(existing, incoming);
  const mergedCommentObservation = mergeNullableRecord(
    isRecord(existing.raw?.commentObservation) ? existing.raw.commentObservation : {},
    isRecord(incoming.raw?.commentObservation) ? incoming.raw.commentObservation : {},
  );
  return {
    ...existing,
    ...incoming,
    url: incomingTargetUnavailable && existing.url ? existing.url : incoming.url,
    title: preserveExistingTarget
      ? existing.title
      : isGenericCommentTargetTitle(incoming.title)
        ? existing.title ?? incoming.title
        : incoming.title,
    thumbnailUrl: preserveExistingTarget
      ? existing.thumbnailUrl ?? null
      : incoming.thumbnailUrl ?? existing.thumbnailUrl ?? null,
    publishedAt: published.value,
    likes: incoming.likes ?? existing.likes ?? null,
    comments: incoming.comments ?? existing.comments ?? null,
    raw: {
      ...(existing.raw ?? {}),
      ...incoming.raw,
      publishedAtPrecision: published.precision,
      firstObservedAt: [existing.raw?.firstObservedAt, incoming.raw.firstObservedAt].filter(Boolean).sort().at(0),
      lastObservedAt: [existing.raw?.lastObservedAt, incoming.raw.lastObservedAt].filter(Boolean).sort().at(-1),
      commentTarget: mergedTarget,
      ...(Object.keys(mergedCommentObservation).length
        ? { commentObservation: mergedCommentObservation }
        : {}),
      metricHistory: [...history.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)),
    },
  };
}

function hasAvailablePublicTarget(target) {
  if (target.unavailable === true || typeof target.url !== "string") return false;
  try {
    return new URL(target.url).protocol === "https:";
  } catch {
    return false;
  }
}

function mergeNullableRecord(existing, incoming) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "title" && isGenericCommentTargetTitle(value) && !isGenericCommentTargetTitle(merged[key])) {
      continue;
    }
    if (key === "audiencePrecision" && value === "unknown" && merged[key] && merged[key] !== "unknown") {
      continue;
    }
    if (value != null || merged[key] == null) merged[key] = value;
  }
  return merged;
}

function isGenericCommentTargetTitle(value) {
  return typeof value === "string" &&
    /^Contenu (?:instagram|tiktok) (?:commenté|indisponible)$/i.test(value.trim());
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function latestIso(...values) {
  return values.filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value))).sort().at(-1);
}

function normalizedExistingComment(post) {
  const target = isRecord(post.raw?.commentTarget) ? post.raw.commentTarget : {};
  return normalizedIdentity({
    platform: post.platform,
    text: typeof post.text === "string" ? post.text : "",
    publishedAt: post.publishedAt,
    target,
    url: post.url,
  });
}

function existingNativeIdContradictions(existing, incoming) {
  const identity = normalizedExistingComment(existing);
  const conflicts = [];
  if (identity.text !== incoming.identity.text) conflicts.push("text");
  if (
    identity.targetKey &&
    incoming.identity.targetKey &&
    identity.targetKey !== incoming.identity.targetKey
  ) {
    conflicts.push("target");
  }
  if (
    identity.publishedAt &&
    incoming.identity.publishedAt &&
    effectivePublishedAtPrecision(existing) === "exact" &&
    effectivePublishedAtPrecision(incoming.post) === "exact" &&
    !identityDateMatches(identity.publishedAt, incoming.identity.publishedAt)
  ) {
    conflicts.push("publishedAt");
  }
  return conflicts;
}

function platformNativeId(platform, externalId) {
  const id = String(externalId ?? "").replace(/^comment:/u, "");
  if (platform === "instagram" || platform === "tiktok") return /^\d{10,30}$/u.test(id);
  return false;
}

function isLegacySyntheticComment(post) {
  if (post?.format !== "comment") return false;
  const raw = isRecord(post.raw) ? post.raw : {};
  if (raw.commentIdKind === "native" || raw.nativeCommentId) return false;
  if (raw.commentIdKind === "synthetic" || raw.syntheticCommentId === true) return true;
  if (/legacy|synthetic/i.test(String(raw.collector ?? raw.sourceKind ?? ""))) return true;
  return !platformNativeId(post.platform, post.externalId);
}

function reconciliationIndex(snapshotPosts, platform) {
  const index = new Map();
  for (const post of snapshotPosts) {
    if (post.platform !== platform || !isLegacySyntheticComment(post)) continue;
    const identity = normalizedExistingComment(post);
    if (!identity.targetKey || !identity.text || !identity.publishedAt) continue;
    const key = `${identity.targetKey}\u0000${identity.text}`;
    const entries = index.get(key) ?? [];
    entries.push({ post, identity });
    index.set(key, entries);
  }
  return index;
}

function mergeDuplicateInput(existing, incoming) {
  const conflicts = duplicateContradictions(existing, incoming);
  if (conflicts.length) {
    throw new Error(
      `ID dupliqué contradictoire ${incoming.id} dans input.comments (${conflicts.join(", ")}).`,
    );
  }
  if (!existing.post && incoming.post) return incoming;
  if (existing.post && !incoming.post) return existing;
  if (!existing.post && !incoming.post) return existing;
  return {
    ...existing,
    identity: {
      targetKey: incoming.identity.targetKey ?? existing.identity.targetKey,
      text: existing.identity.text,
      publishedAt: incoming.identity.publishedAt ?? existing.identity.publishedAt,
    },
    post: mergeComment(existing.post, incoming.post),
    media: incoming.media ?? existing.media,
    quarantine: null,
  };
}

function optionalInventoryManifest(source, inputCount, uniqueCount) {
  if (source.inventory != null && source.completion != null) {
    throw new Error("input.inventory et input.completion ne peuvent pas être fournis ensemble.");
  }
  const raw = source.inventory ?? source.completion;
  if (raw == null) {
    return {
      provided: false,
      inventoryStatus: "partial",
      endReached: null,
      recordCount: null,
      inputCount,
      uniqueCount,
      coherent: false,
      issues: ["manifest-missing"],
    };
  }
  const manifest = requireRecord(raw, source.inventory != null ? "input.inventory" : "input.completion");
  const recordCount = nullableCount(manifest.recordCount, "input.inventory.recordCount");
  const endReached = manifest.endReached === true;
  if (manifest.endReached != null && typeof manifest.endReached !== "boolean") {
    throw new Error("input.inventory.endReached doit être un booléen.");
  }
  const requestedStatus = nullableString(
    manifest.inventoryStatus ?? manifest.status,
    "input.inventory.inventoryStatus",
  );
  if (requestedStatus != null && !["complete", "partial"].includes(requestedStatus)) {
    throw new Error("input.inventory.inventoryStatus doit être complete ou partial.");
  }
  const countMatchesInput = recordCount === inputCount;
  const inputIsUnique = inputCount === uniqueCount;
  const coherent = countMatchesInput && inputIsUnique;
  const canBeComplete = endReached && coherent;
  const inventoryStatus = canBeComplete && requestedStatus !== "partial" ? "complete" : "partial";
  const issues = [];
  if (!endReached) issues.push("end-not-reached");
  if (!countMatchesInput) issues.push("record-count-mismatch");
  if (!inputIsUnique) issues.push("duplicate-record-ids");
  if (requestedStatus === "complete" && !canBeComplete) issues.push("invalid-complete-claim");
  return {
    provided: true,
    inventoryStatus,
    requestedStatus,
    endReached,
    recordCount,
    inputCount,
    uniqueCount,
    coherent,
    issues,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const inputPath = resolve(options.input);
  const [input, snapshot, summary] = await Promise.all([
    readJson(inputPath),
    readJson(HISTORY_PATH),
    readJson(SUMMARY_PATH),
  ]);
  const source = requireRecord(input, "input");
  const platform = requireString(source.platform, "input.platform");
  if (!PLATFORMS.has(platform)) throw new Error("input.platform doit être instagram ou tiktok.");
  const capturedAt = requireIso(source.capturedAt, "input.capturedAt");
  const activitySourceUrl = safeInstagramActivitySourceUrl(
    source.activitySourceUrl,
    platform,
  );
  if (!Array.isArray(source.comments)) throw new Error("input.comments doit être un tableau.");

  const normalized = source.comments.map((entry, index) =>
    normalizedComment(entry, index, platform, capturedAt, activitySourceUrl),
  );
  const unique = new Map();
  for (const item of normalized) {
    const previous = unique.get(item.id);
    unique.set(item.id, previous ? mergeDuplicateInput(previous, item) : item);
  }
  const inventory = optionalInventoryManifest(source, source.comments.length, unique.size);
  const posts = new Map(snapshot.posts.map((post) => [`${post.platform}:${post.externalId}`, post]));
  const legacyIndex = reconciliationIndex(snapshot.posts, platform);
  const consumedLegacyKeys = new Set();
  const details = {
    inserted: [],
    updated: [],
    reconciled: [],
    ambiguous: [],
    skipped: [],
  };
  const appliedMedia = [];
  let inserted = 0;
  let updated = 0;
  let reconciled = 0;
  let ambiguous = 0;
  let skipped = 0;
  for (const item of unique.values()) {
    if (!item.post) {
      skipped += 1;
      details.skipped.push(item.quarantine);
      continue;
    }
    const nativeKey = `${platform}:${item.post.externalId}`;
    const previous = posts.get(nativeKey);
    if (previous) {
      const conflicts = existingNativeIdContradictions(previous, item);
      if (conflicts.length) {
        throw new Error(
          `ID natif ${item.id} contredit l'historique existant (${conflicts.join(", ")}).`,
        );
      }
      const merged = mergeComment(previous, item.post);
      posts.set(nativeKey, merged);
      updated += 1;
      details.updated.push(item.post.externalId);
      if (item.media && merged.thumbnailUrl === item.media.publicUrl) {
        appliedMedia.push(item.media);
      }
      continue;
    }

    const identityKey = item.identity.targetKey
      ? `${item.identity.targetKey}\u0000${item.identity.text}`
      : null;
    const candidates = item.idKind === "native" && identityKey
      ? (legacyIndex.get(identityKey) ?? []).filter(
          (candidate) =>
            !consumedLegacyKeys.has(`${platform}:${candidate.post.externalId}`) &&
            identitiesMatch(candidate.identity, item.identity),
        )
      : [];
    if (candidates.length > 1) {
      ambiguous += 1;
      skipped += 1;
      details.ambiguous.push({
        id: item.id,
        candidateExternalIds: candidates.map((candidate) => candidate.post.externalId),
        reason: "multiple-safe-legacy-matches",
      });
      details.skipped.push({ id: item.id, reason: "ambiguous-legacy-reconciliation" });
      continue;
    }
    if (candidates.length === 1) {
      const [{ post: legacyPost }] = candidates;
      const legacyKey = `${platform}:${legacyPost.externalId}`;
      consumedLegacyKeys.add(legacyKey);
      posts.delete(legacyKey);
      const merged = mergeComment(legacyPost, item.post);
      const lineage = [
        ...(Array.isArray(legacyPost.raw?.reconciledFromExternalIds)
          ? legacyPost.raw.reconciledFromExternalIds
          : []),
        legacyPost.externalId,
      ];
      merged.raw = {
        ...merged.raw,
        reconciledFromExternalIds: [...new Set(lineage)],
      };
      posts.set(nativeKey, merged);
      reconciled += 1;
      details.reconciled.push({
        id: item.id,
        fromExternalId: legacyPost.externalId,
        toExternalId: item.post.externalId,
      });
      if (item.media && merged.thumbnailUrl === item.media.publicUrl) {
        appliedMedia.push(item.media);
      }
      continue;
    }

    posts.set(nativeKey, item.post);
    inserted += 1;
    details.inserted.push(item.post.externalId);
    if (item.media) appliedMedia.push(item.media);
  }

  if (inventory.requestedStatus === "complete" && skipped > 0) {
    throw new Error(
      `Inventaire déclaré complet refusé : ${skipped} ligne(s) normalisée(s) ont été écartées ou mises en quarantaine.`,
    );
  }

  let media = { downloaded: 0, cached: 0, failed: [] };
  if (platform === "instagram" && !options.dryRun && !options.skipMediaCache) {
    media = await cacheInstagramThumbnails(appliedMedia);
    for (const failure of media.failed) {
      const postKey = `${platform}:${failure.externalId}`;
      const post = posts.get(postKey);
      if (!post || post.thumbnailUrl !== failure.publicUrl) continue;
      const target = isRecord(post.raw?.commentTarget) ? post.raw.commentTarget : {};
      posts.set(postKey, {
        ...post,
        thumbnailUrl: null,
        raw: {
          ...post.raw,
          commentTarget: {
            ...target,
            thumbnailUrl: null,
          },
        },
      });
    }
  }

  // Map updates retain their original insertion position. Keeping that stable order avoids
  // rewriting the entire public history whenever an approximate comment date is enriched;
  // every consumer that needs recency already sorts explicitly at display time.
  const nextPosts = [...posts.values()];
  const changedCount = inserted + updated + reconciled;
  const nextGeneratedAt = changedCount > 0
    ? latestIso(snapshot.generatedAt, capturedAt) ?? capturedAt
    : snapshot.generatedAt;
  const nextSnapshot = { ...snapshot, generatedAt: nextGeneratedAt, posts: nextPosts };
  const platformPosts = nextPosts.filter((post) => post.platform === platform);
  const nextSummary = {
    ...summary,
    generatedAt: nextGeneratedAt,
    totalPostCount: nextPosts.length,
    platformCounts: { ...summary.platformCounts, [platform]: platformPosts.length },
    formatCounts: {
      ...summary.formatCounts,
      [platform]: {
        ...(summary.formatCounts?.[platform] ?? {}),
        comment: platformPosts.filter((post) => post.format === "comment").length,
      },
    },
  };

  if (!options.dryRun) {
    await Promise.all([
      writeJsonAtomically(HISTORY_PATH, nextSnapshot),
      writeJsonAtomically(SUMMARY_PATH, nextSummary),
    ]);
  }
  const report = {
    platform,
    capturedAt,
    inputCount: source.comments.length,
    uniqueCount: unique.size,
    inserted,
    updated,
    reconciled,
    ambiguous,
    skipped,
    quarantined: details.skipped.filter((item) => item?.reason === "target-unavailable-without-public-url").length,
    inventory,
    details,
    mediaDownloaded: media.downloaded,
    mediaCached: media.cached,
    mediaFailed: media.failed.length,
    mediaFailures: media.failed,
    dryRun: options.dryRun,
  };
  if (!options.dryRun && options.report) {
    await writeJsonAtomically(resolve(options.report), report);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
