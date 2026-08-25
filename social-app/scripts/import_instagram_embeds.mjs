/**
 * Enrich and import Lofi Girl Instagram posts from public captioned embeds.
 *
 * Preferred manifest: work/instagram-current-links.json
 * Legacy fallback: work/instagram-url-progress.json
 * Collection checkpoint: work/instagram-embed-progress.json
 * Certified import target: data/public-history.json
 *
 * Missing public fields remain null. The collector never substitutes zero.
 */
import { createHash } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const CERTIFIED_MANIFEST_PATH = resolve(ROOT, "work", "instagram-current-links.json");
const LEGACY_MANIFEST_PATH = resolve(ROOT, "work", "instagram-url-progress.json");
const EMBED_PROGRESS_PATH = resolve(ROOT, "work", "instagram-embed-progress.json");
const HISTORY_PATH = resolve(ROOT, "data", "public-history.json");
const ACCOUNT = "lofigirl";
const COLLECTOR = "instagram-public-captioned-embed";
const PROGRESS_VERSION = 1;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRIES = 5;
const DEFAULT_BACKOFF_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_HTML_BYTES = 5_000_000;
const INSTAGRAM_EPOCH_MS = 1_314_220_021_721n;
const MIN_INSTAGRAM_DATE_MS = Date.UTC(2010, 0, 1);

class FatalCollectionError extends Error {
  constructor(code, message, shortcode = null) {
    super(message);
    this.name = "FatalCollectionError";
    this.code = code;
    this.shortcode = shortcode;
  }
}

function environmentInteger(name, fallback, minimum = 1) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} doit être un entier supérieur ou égal à ${minimum}.`);
  }
  return value;
}

function optionInteger(raw, label, minimum = 1) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} doit être un entier supérieur ou égal à ${minimum}.`);
  }
  return value;
}

function parseOptions(argv) {
  const options = {
    dryRun: false,
    collectOnly: false,
    importOnly: false,
    refineCompact: false,
    maxItems: Number.POSITIVE_INFINITY,
    concurrency: environmentInteger("INSTAGRAM_EMBED_CONCURRENCY", DEFAULT_CONCURRENCY),
    retries: environmentInteger("INSTAGRAM_EMBED_RETRIES", DEFAULT_RETRIES),
    backoffMs: environmentInteger("INSTAGRAM_EMBED_BACKOFF_MS", DEFAULT_BACKOFF_MS),
    timeoutMs: environmentInteger("INSTAGRAM_EMBED_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--collect-only") options.collectOnly = true;
    else if (argument === "--import-only") options.importOnly = true;
    else if (argument === "--refine-compact") options.refineCompact = true;
    else if (argument.startsWith("--max-items=")) {
      options.maxItems = optionInteger(argument.slice("--max-items=".length), "--max-items");
    } else if (argument === "--max-items") {
      options.maxItems = optionInteger(argv[++index], "--max-items");
    } else if (argument.startsWith("--concurrency=")) {
      options.concurrency = optionInteger(argument.slice("--concurrency=".length), "--concurrency");
    } else if (argument === "--concurrency") {
      options.concurrency = optionInteger(argv[++index], "--concurrency");
    } else {
      throw new Error(`Option inconnue : ${argument}`);
    }
  }
  if (options.collectOnly && options.importOnly) {
    throw new Error("--collect-only et --import-only sont incompatibles.");
  }
  if (options.refineCompact && (options.collectOnly || options.importOnly || options.dryRun)) {
    throw new Error("--refine-compact s'utilise seul.");
  }
  if (options.importOnly && Number.isFinite(options.maxItems)) {
    throw new Error("--max-items n'a pas de sens avec --import-only.");
  }
  return options;
}

async function readJson(path, { optional = false, label = path } = {}) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw new Error(`${label} illisible : ${error?.message ?? error}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} n'est pas un JSON valide : ${error?.message ?? error}`);
  }
}

async function writeJsonAtomically(path, value) {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.next`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    JSON.parse(await readFile(temporaryPath, "utf8"));
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        await rename(temporaryPath, path);
        break;
      } catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt === 8) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 75));
      }
    }
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
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

function requireString(value, label, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && !value.trim())) {
    throw new Error(`${label} doit être une chaîne${empty ? "" : " non vide"}.`);
  }
  return value;
}

function nullableString(value, label) {
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

function nullableCount(value, label) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} doit être un entier positif ou nul, ou null.`);
  }
  return value;
}

function cleanText(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.toWellFormed().replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  return cleaned || null;
}

function shortTitle(value) {
  const cleaned = cleanText(value)?.replace(/\s+/g, " ") ?? null;
  return cleaned ? [...cleaned].slice(0, 180).join("") : null;
}

function canonicalUrls(kind, shortcode) {
  return {
    canonicalUrl: `https://www.instagram.com/${ACCOUNT}/${kind}/${shortcode}/`,
    embedUrl: `https://www.instagram.com/${kind}/${shortcode}/embed/captioned/?_fb_noscript=1`,
    stableThumbnailUrl: `https://www.instagram.com/p/${shortcode}/media/?size=l`,
  };
}

function manifestHash(items) {
  const stable = [...items]
    .sort((left, right) => left.shortcode.localeCompare(right.shortcode))
    .map((item) => `${item.shortcode}\t${item.kind}\t${item.canonicalUrl}`)
    .join("\n");
  return createHash("sha256").update(stable, "utf8").digest("hex");
}

export function normalizeInstagramManifest(value) {
  const source = requireRecord(value, "manifeste Instagram");
  const certified = Array.isArray(source.links);
  const sourceUpdatedAt = requireIso(source.updatedAt, "manifeste Instagram.updatedAt");
  const completedAt = source.completedAt == null ? null : requireIso(source.completedAt, "manifeste Instagram.completedAt");
  const entries = certified
    ? requireArray(source.links, "instagram-current-links.links")
    : requireArray(source.urls, "instagram-url-progress.urls");
  const byShortcode = new Map();
  let duplicateUrlCount = 0;
  for (const [index, entry] of entries.entries()) {
    const declaredKind = certified
      ? requireString(requireRecord(entry, `instagram-current-links.links[${index}]`).kind, `instagram-current-links.links[${index}].kind`).toLowerCase()
      : null;
    const input = requireString(certified ? entry.url : entry, `manifeste Instagram[${index}].url`);
    let parsed;
    try {
      parsed = new URL(input);
    } catch {
      throw new Error(`URL Instagram invalide à l'index ${index}.`);
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "instagram.com") throw new Error(`Domaine Instagram inattendu à l'index ${index}.`);
    const match = parsed.pathname.match(/^\/+((?:lofigirl\/)?)(p|reel)\/([A-Za-z0-9_-]+)\/?$/i);
    if (!match) throw new Error(`Chemin Instagram inattendu à l'index ${index} : ${parsed.pathname}`);
    const kind = match[2].toLowerCase();
    const shortcode = match[3];
    if (declaredKind != null && declaredKind !== kind) {
      throw new Error(`Type déclaré incohérent pour ${shortcode} (${declaredKind} au lieu de ${kind}).`);
    }
    const existing = byShortcode.get(shortcode);
    if (existing) {
      if (existing.kind !== kind) throw new Error(`Le shortcode ${shortcode} apparaît comme /p/ et /reel/.`);
      duplicateUrlCount += 1;
      continue;
    }
    byShortcode.set(shortcode, { shortcode, kind, ...canonicalUrls(kind, shortcode) });
  }
  const items = [...byShortcode.values()];
  if (!items.length) throw new Error("Le manifeste Instagram ne contient aucune publication exploitable.");
  const expectedCount = certified
    ? optionInteger(source.expectedCount, "instagram-current-links.expectedCount")
    : null;
  const endReached = certified && source.endReached === true;
  if (certified && (!endReached || !completedAt)) {
    throw new Error("Le manifeste courant Instagram n'est pas certifié : endReached=true et completedAt sont requis.");
  }
  if (certified && (expectedCount !== items.length || entries.length !== expectedCount)) {
    throw new Error(`Manifeste certifié incohérent : expectedCount=${expectedCount}, liens=${entries.length}, shortcodes uniques=${items.length}.`);
  }
  return {
    source: certified ? "work/instagram-current-links.json" : "work/instagram-url-progress.json",
    sourceUpdatedAt,
    completedAt,
    endReached,
    expectedCount,
    certified,
    rawUrlCount: entries.length,
    uniqueShortcodeCount: items.length,
    duplicateUrlCount,
    hash: manifestHash(items),
    items,
  };
}

function decodeHtmlEntities(value) {
  const named = new Map([
    ["amp", "&"], ["quot", '"'], ["apos", "'"], ["lt", "<"], ["gt", ">"], ["nbsp", " "],
  ]);
  return String(value ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const number = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : whole;
    }
    return named.get(entity.toLowerCase()) ?? whole;
  });
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of source.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function classTokens(attributes) {
  return String(attributes.class ?? "").split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
}

function stripHtml(fragment) {
  return cleanText(
    decodeHtmlEntities(
      String(fragment ?? "")
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    ).replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n"),
  );
}

function visibleBodyText(html) {
  const body = String(html).match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return stripHtml(body) ?? "";
}

function elementHtmlByClass(html, desiredTokens) {
  const desired = new Set(desiredTokens.map((token) => token.toLowerCase()));
  const opening = /<([a-z][\w:-]*)\b([^>]*)>/gi;
  for (const match of String(html).matchAll(opening)) {
    const attributes = parseAttributes(match[2]);
    if (!classTokens(attributes).some((token) => desired.has(token))) continue;
    const close = new RegExp(`</${match[1]}\\s*>`, "i");
    const rest = String(html).slice((match.index ?? 0) + match[0].length);
    const closing = close.exec(rest);
    if (closing) return rest.slice(0, closing.index);
  }
  return null;
}

function embeddedImageUrl(html) {
  for (const match of String(html).matchAll(/<img\b([^>]*)>/gi)) {
    const attributes = parseAttributes(match[1]);
    if (!classTokens(attributes).includes("embeddedmediaimage")) continue;
    const candidate = attributes.src || attributes["data-src"] || null;
    if (!candidate) return null;
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("L'image EmbeddedMediaImage n'a pas une URL valide.");
    }
    const host = parsed.hostname.toLowerCase();
    const allowed = host === "instagram.com" || host.endsWith(".instagram.com")
      || host === "fbcdn.net" || host.endsWith(".fbcdn.net")
      || host === "cdninstagram.com" || host.endsWith(".cdninstagram.com");
    if (parsed.protocol !== "https:" || !allowed) {
      throw new Error(`Hôte EmbeddedMediaImage inattendu : ${host}`);
    }
    return parsed.href;
  }
  return null;
}

function parseCompactCount(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[\u00a0\u202f\s]/g, "");
  const match = normalized.match(/^(\d+(?:[.,]\d+)*)([KMB])?$/i);
  if (!match) return null;
  const suffix = (match[2] ?? "").toLowerCase();
  let numeric;
  if (suffix) {
    numeric = Number(match[1].replace(/,/g, "."));
  } else {
    const separators = [...match[1].matchAll(/[.,]/g)];
    if (separators.length && !/[.,]\d{3}(?:[.,]\d{3})*$/.test(match[1])) return null;
    numeric = Number(match[1].replace(/[.,]/g, ""));
  }
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const multiplier = { "": 1, k: 1_000, m: 1_000_000, b: 1_000_000_000 }[suffix];
  return Math.round(numeric * multiplier);
}

function serializedSource(html) {
  return decodeHtmlEntities(html)
    .replace(/\\u0022/gi, '"')
    .replace(/\\u0027/gi, "'")
    .replace(/\\"/g, '"');
}

function structuredCount(html, names) {
  const source = serializedSource(html);
  for (const name of names) {
    const match = new RegExp(`["']${name}["']\\s*:\\s*["']?(\\d+)`, "i").exec(source);
    if (match) return Number(match[1]);
  }
  return null;
}

function visibleCount(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const count = parseCompactCount(match?.[1] ?? null);
    if (count != null) return count;
  }
  return null;
}

function unescapeJsonString(value) {
  try {
    return JSON.parse(`"${String(value).replace(/"/g, '\\"')}"`);
  } catch {
    return String(value).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\//g, "/");
  }
}

function visibleCaption(html) {
  const fragment = elementHtmlByClass(html, ["Caption", "CaptionText", "CaptionContent"]);
  let caption = stripHtml(fragment);
  if (caption) {
    caption = caption.replace(/^@?lofigirl\b[\s:·-]*/i, "").trim();
    caption = caption.replace(/\s+(?:view|see)\s+all\s+[\d.,kmb\s]+\s+comments?.*$/i, "").trim();
    return cleanText(caption);
  }
  const source = serializedSource(html);
  const structured = source.match(/["']caption["']\s*:\s*\{[^{}]{0,5000}?["']text["']\s*:\s*["']((?:\\.|[^"'])*)["']/i)
    ?? source.match(/["']caption["']\s*:\s*["']((?:\\.|[^"'])*)["']/i);
  return structured ? cleanText(unescapeJsonString(structured[1])) : null;
}

function metaContent(html, property) {
  for (const match of String(html).matchAll(/<meta\b([^>]*)>/gi)) {
    const attributes = parseAttributes(match[1]);
    const key = String(attributes.property ?? attributes.name ?? "").toLowerCase();
    if (key === property.toLowerCase()) {
      // parseAttributes already decodes once; public OG captions sometimes
      // contain a second entity-encoded layer.
      return decodeHtmlEntities(attributes.content ?? "");
    }
  }
  return null;
}

function publishedDayAtNoon(dateLabel) {
  const match = String(dateLabel).trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (!match) throw new Error(`Date Instagram OG invalide : ${dateLabel}`);
  const milliseconds = Date.parse(`${match[1]} ${match[2]}, ${match[3]} 12:00:00 UTC`);
  if (!Number.isFinite(milliseconds)) throw new Error(`Date Instagram OG invalide : ${dateLabel}`);
  return new Date(milliseconds).toISOString();
}

export function parseInstagramOgHead(html, { shortcode } = {}) {
  const description = metaContent(html, "og:description");
  if (!description) throw new Error(`og:description absent${shortcode ? ` pour ${shortcode}` : ""}.`);
  const match = description.match(
    /^\s*([\d.,\s]+[KMB]?)\s+likes?\s*,\s*([\d.,\s]+[KMB]?)\s+comments?\s*-\s*([A-Za-z0-9._]+)\s+on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})(?:\s*:\s*["“]([\s\S]*?)["”])?\.?\s*$/i,
  );
  if (!match) throw new Error(`og:description Instagram inattendu${shortcode ? ` pour ${shortcode}` : ""}.`);
  const likes = parseCompactCount(match[1]);
  const comments = parseCompactCount(match[2]);
  if (likes == null || comments == null) throw new Error("Compteurs Instagram OG invalides.");
  const mediaId = mediaIdFromInstagramShortcode(shortcode);
  return {
    mediaId,
    authorUsername: match[3].toLowerCase(),
    caption: cleanText(match[5] ?? null),
    imageUrl: metaContent(html, "og:image"),
    imageSource: "instagram-og-image",
    publishedAt: publishedDayAtNoon(match[4]),
    likes,
    comments,
    publishedAtPrecision: "approximate",
    publishedAtSource: "instagram-og-description",
    publishedDatePrecision: "day",
    derivedPublishedAt: deriveInstagramPublishedAt(mediaId),
    publishedAtFormula: null,
    ogDescription: description,
  };
}

function mediaIdCandidates(html) {
  const source = serializedSource(html);
  const patterns = [
    /\bdata-media-id\s*=\s*["'](\d{10,30})(?:_\d+)?["']/gi,
    /["']media_id["']\s*:\s*["']?(\d{10,30})(?:_\d+)?/gi,
    /["']mediaId["']\s*:\s*["']?(\d{10,30})(?:_\d+)?/gi,
    /["']shortcode_media["'][\s\S]{0,500}?["']id["']\s*:\s*["']?(\d{10,30})/gi,
    /\bmedia\?id=(\d{10,30})/gi,
    /instagram:\/\/media\?id=(\d{10,30})/gi,
  ];
  const found = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return [...new Set(found)];
}

export function mediaIdFromInstagramShortcode(shortcode) {
  const value = requireString(shortcode, "shortcode Instagram");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let decoded = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error(`Caractère invalide dans le shortcode Instagram : ${character}`);
    decoded = decoded * 64n + BigInt(digit);
  }
  if (decoded <= 0n) throw new Error("Le shortcode Instagram ne produit aucun identifiant média valide.");
  return String(decoded);
}

export function deriveInstagramPublishedAt(mediaId) {
  const id = String(mediaId ?? "").trim();
  if (!/^\d{10,30}$/.test(id)) throw new Error("Identifiant média Instagram invalide.");
  const milliseconds = (BigInt(id) >> 23n) + INSTAGRAM_EPOCH_MS;
  if (milliseconds < BigInt(MIN_INSTAGRAM_DATE_MS) || milliseconds > BigInt(Date.now() + 7 * 86_400_000)) {
    throw new Error("L'identifiant média Instagram produit une date impossible.");
  }
  return new Date(Number(milliseconds)).toISOString();
}

export function detectInstagramAccessBlock({ status = 200, url = "", html = "" } = {}) {
  const source = String(html);
  if (status === 429) {
    return "rate-limited";
  }
  if (status === 401 || status === 403
    || /\/(?:accounts\/login|challenge|checkpoint)(?:\/|\?|$)/i.test(url)) {
    return "login-required";
  }
  // Valid embeds/direct pages can mention login or challenge strings inside
  // bundled scripts. A concrete post marker takes precedence over those words.
  const successMarker = /<meta\b[^>]*(?:property|name)=["']og:description["']/i.test(source)
    || /\bmedia\?id=\d{10,30}/i.test(source)
    || /class=["'][^"']*\bEmbeddedMediaImage\b/i.test(source);
  if (successMarker) return null;
  if (/please wait a few minutes before you try again|try again later|too many requests|rate[_ -]?limit(?:ed|_error)?|feedback_required|we restrict certain activity/i.test(source)) {
    return "rate-limited";
  }
  if (/<title[^>]*>\s*(?:login|log in)\s*[•|·-]\s*instagram\s*<\/title>/i.test(source)
    || /id=["']loginForm["']|login_required|checkpoint_required|challenge_required|log in to see photos and videos from friends|confirm it['’]s you|suspicious login attempt/i.test(source)) {
    return "login-required";
  }
  return null;
}

export function parseInstagramEmbedHtml(html, { shortcode = null } = {}) {
  const source = requireString(html, "HTML embed Instagram");
  const bodyText = visibleBodyText(source);
  const candidates = mediaIdCandidates(source);
  let mediaId = null;
  let publishedAt = null;
  for (const candidate of candidates) {
    try {
      publishedAt = deriveInstagramPublishedAt(candidate);
      mediaId = candidate;
      break;
    } catch {
      // A page can contain account IDs alongside the media ID. Keep looking.
    }
  }
  if (!mediaId && shortcode) {
    try {
      const candidate = mediaIdFromInstagramShortcode(shortcode);
      publishedAt = deriveInstagramPublishedAt(candidate);
      mediaId = candidate;
    } catch {
      // Keep the explicit missing-ID error below when the shortcode is unusable.
    }
  }
  if (!mediaId) throw new Error(`Identifiant média Instagram absent${shortcode ? ` pour ${shortcode}` : ""}.`);

  const likes = structuredCount(source, ["like_count", "likes_count"])
    ?? visibleCount(bodyText, [/(\d[\d.,\s]*[KMB]?)\s+(?:likes?|j[’']aime)\b/i]);
  const comments = structuredCount(source, ["comments_count", "comment_count"])
    ?? structuredCount(source.match(/["']edge_media_to_(?:parent_)?comment["']\s*:\s*\{[^{}]{0,500}\}/i)?.[0] ?? "", ["count"])
    ?? visibleCount(bodyText, [
      /(?:view|see)\s+all\s+(\d[\d.,\s]*[KMB]?)\s+comments?\b/i,
      /(\d[\d.,\s]*[KMB]?)\s+comments?\b/i,
    ]);

  return {
    mediaId,
    caption: visibleCaption(source),
    imageUrl: embeddedImageUrl(source),
    imageSource: "instagram-embedded-media-image",
    publishedAt,
    likes,
    comments,
    publishedAtPrecision: "approximate",
    publishedAtSource: "derived-media-id",
    publishedAtFormula: "(mediaId >> 23) + 1314220021721",
  };
}

function sanitizedError(error) {
  return String(error?.message ?? error ?? "Erreur inconnue").replace(/\s+/g, " ").slice(0, 500);
}

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function fetchEmbed(item, options, globalSignal) {
  let lastError = null;
  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    try {
      const response = await fetch(item.embedUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.8",
          "User-Agent": "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://lofigirl.com)",
        },
        redirect: "follow",
        signal: AbortSignal.any([globalSignal, AbortSignal.timeout(options.timeoutMs)]),
      });
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES) {
        throw new Error(`Embed trop volumineux (${contentLength} octets).`);
      }
      const html = await response.text();
      if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) throw new Error("Embed trop volumineux après téléchargement.");
      const block = detectInstagramAccessBlock({ status: response.status, url: response.url, html });
      if (block) {
        throw new FatalCollectionError(
          block,
          block === "rate-limited"
            ? "Instagram a limité les requêtes publiques. Arrêt immédiat, sans contourner la limite."
            : "Instagram demande une connexion ou un challenge. Arrêt immédiat du collecteur public.",
          item.shortcode,
        );
      }
      if (response.status === 404 || response.status === 410) {
        return { status: "unavailable", attempts: attempt, httpStatus: response.status, observedAt: new Date().toISOString(), post: null };
      }
      if (!response.ok) throw new Error(`Instagram embed HTTP ${response.status}.`);
      const observedAt = new Date().toISOString();
      const post = parseInstagramEmbedHtml(html, { shortcode: item.shortcode });
      return { status: "ok", attempts: attempt, httpStatus: response.status, observedAt, post };
    } catch (error) {
      if (error instanceof FatalCollectionError) throw error;
      if (globalSignal.aborted) throw error;
      lastError = error;
      if (attempt < options.retries) {
        const delay = Math.min(60_000, options.backoffMs * (2 ** (attempt - 1))) + Math.floor(Math.random() * 300);
        await sleep(delay);
      }
    }
  }
  return {
    status: "error",
    attempts: options.retries,
    httpStatus: null,
    observedAt: new Date().toISOString(),
    post: null,
    error: sanitizedError(lastError),
  };
}

async function readResponseHead(response, maximumBytes = 200_000) {
  if (!response.body) return (await response.text()).slice(0, maximumBytes);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  try {
    while (bytes < maximumBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (/<\/head\s*>/i.test(html)) break;
    }
    html += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return html.slice(0, maximumBytes);
}

async function fetchDirectOg(item, options, globalSignal) {
  let lastError = null;
  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    try {
      const response = await fetch(item.canonicalUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.8",
          "User-Agent": "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://lofigirl.com)",
        },
        redirect: "follow",
        signal: AbortSignal.any([globalSignal, AbortSignal.timeout(options.timeoutMs)]),
      });
      const html = await readResponseHead(response);
      const block = detectInstagramAccessBlock({ status: response.status, url: response.url, html });
      if (block) {
        throw new FatalCollectionError(
          block,
          block === "rate-limited"
            ? "Instagram a limité les requêtes publiques. Arrêt immédiat, sans contourner la limite."
            : "Instagram demande une connexion ou un challenge. Arrêt immédiat du collecteur public.",
          item.shortcode,
        );
      }
      if (response.status === 404 || response.status === 410) {
        return { status: "unavailable", attempts: attempt, httpStatus: response.status, observedAt: new Date().toISOString(), post: null };
      }
      if (!response.ok) throw new Error(`Instagram direct HTTP ${response.status}.`);
      return {
        status: "ok",
        attempts: attempt,
        httpStatus: response.status,
        observedAt: new Date().toISOString(),
        post: parseInstagramOgHead(html, { shortcode: item.shortcode }),
      };
    } catch (error) {
      if (error instanceof FatalCollectionError) throw error;
      if (globalSignal.aborted) throw error;
      lastError = error;
      if (attempt < options.retries) {
        const delay = Math.min(30_000, options.backoffMs * (2 ** (attempt - 1))) + Math.floor(Math.random() * 300);
        await sleep(delay);
      }
    }
  }
  return { status: "fallback", error: sanitizedError(lastError) };
}

async function fetchInstagramItem(item, options, globalSignal) {
  const direct = await fetchDirectOg(item, options, globalSignal);
  if (direct.status !== "fallback") return direct;
  const embed = await fetchEmbed(item, options, globalSignal);
  if (embed.status === "error") {
    embed.error = `Direct OG: ${direct.error}; embed: ${embed.error}`.slice(0, 500);
  }
  return embed;
}

function collectionStats(progress, manifest) {
  let okCount = 0;
  let unavailableCount = 0;
  let errorCount = 0;
  let pendingCount = 0;
  for (const item of manifest.items) {
    const status = progress.items?.[item.shortcode]?.status;
    if (status === "ok") okCount += 1;
    else if (status === "unavailable") unavailableCount += 1;
    else if (status === "error") errorCount += 1;
    else pendingCount += 1;
  }
  return { okCount, unavailableCount, errorCount, pendingCount };
}

function reconcileProgress(existingValue, manifest, now) {
  const existing = existingValue == null ? null : requireRecord(existingValue, "instagram-embed-progress.json");
  if (existing && existing.version !== PROGRESS_VERSION) {
    throw new Error(`Version de progression Instagram inconnue : ${String(existing.version)}.`);
  }
  const allowed = new Map(manifest.items.map((item) => [item.shortcode, item]));
  const existingItems = isRecord(existing?.items) ? existing.items : {};
  for (const [shortcode, record] of Object.entries(existingItems)) {
    const manifestItem = allowed.get(shortcode);
    if (!manifestItem) throw new Error(`Le nouveau manifeste réduirait la progression en supprimant ${shortcode}.`);
    if (record?.kind && record.kind !== manifestItem.kind) throw new Error(`Type de permalink modifié pour ${shortcode}.`);
  }
  const progress = {
    version: PROGRESS_VERSION,
    account: ACCOUNT,
    manifest: {
      source: manifest.source,
      sourceUpdatedAt: manifest.sourceUpdatedAt,
      sourceCompletedAt: manifest.completedAt,
      endReached: manifest.endReached,
      expectedCount: manifest.expectedCount,
      rawUrlCount: manifest.rawUrlCount,
      duplicateUrlCount: manifest.duplicateUrlCount,
      uniqueShortcodeCount: manifest.uniqueShortcodeCount,
      hash: manifest.hash,
    },
    collection: {
      provider: COLLECTOR,
      endpointTemplate: "direct OG head, fallback https://www.instagram.com/{p|reel}/{shortcode}/embed/captioned/?_fb_noscript=1",
      startedAt: existing?.collection?.startedAt ?? now,
      updatedAt: existing?.collection?.updatedAt ?? now,
      completedAt: existing?.collection?.completedAt ?? null,
      certified: existing?.collection?.certified === true,
      okCount: 0,
      unavailableCount: 0,
      errorCount: 0,
      pendingCount: manifest.uniqueShortcodeCount,
      lastFatal: existing?.collection?.lastFatal ?? null,
    },
    items: { ...existingItems },
  };
  refreshCertification(progress, manifest, now, false);
  return progress;
}

function refreshCertification(progress, manifest, now, updateTimestamp = true) {
  const stats = collectionStats(progress, manifest);
  const certified = stats.pendingCount === 0 && stats.errorCount === 0;
  progress.collection = {
    ...progress.collection,
    ...(updateTimestamp ? { updatedAt: now } : {}),
    ...stats,
    certified,
    completedAt: certified ? (progress.collection.completedAt ?? now) : null,
  };
  return stats;
}

async function collectManifest(manifest, existingProgress, options) {
  const progress = reconcileProgress(existingProgress, manifest, new Date().toISOString());
  const candidates = manifest.items
    .filter((item) => !["ok", "unavailable"].includes(progress.items[item.shortcode]?.status))
    .slice(0, options.maxItems);
  await writeJsonAtomically(EMBED_PROGRESS_PATH, progress);
  if (!candidates.length) {
    refreshCertification(progress, manifest, new Date().toISOString());
    await writeJsonAtomically(EMBED_PROGRESS_PATH, progress);
    return { progress, attempted: 0 };
  }

  const abortController = new AbortController();
  let cursor = 0;
  let processed = 0;
  let fatal = null;
  let saveChain = Promise.resolve();
  const checkpoint = () => {
    refreshCertification(progress, manifest, new Date().toISOString());
    saveChain = saveChain.then(() => writeJsonAtomically(EMBED_PROGRESS_PATH, progress));
    return saveChain;
  };
  const worker = async () => {
    while (!fatal && cursor < candidates.length) {
      const item = candidates[cursor++];
      try {
        const result = await fetchInstagramItem(item, options, abortController.signal);
        progress.items[item.shortcode] = {
          shortcode: item.shortcode,
          kind: item.kind,
          canonicalUrl: item.canonicalUrl,
          embedUrl: item.embedUrl,
          stableThumbnailUrl: item.stableThumbnailUrl,
          ...result,
        };
        processed += 1;
        if (processed % 20 === 0) await checkpoint();
      } catch (error) {
        if (!fatal) {
          fatal = error instanceof FatalCollectionError
            ? error
            : new FatalCollectionError("collector-aborted", sanitizedError(error), item.shortcode);
          progress.collection.lastFatal = {
            code: fatal.code,
            shortcode: fatal.shortcode,
            at: new Date().toISOString(),
            message: sanitizedError(fatal),
          };
          abortController.abort();
          await checkpoint();
        }
      }
    }
  };
  const workerCount = Math.min(options.concurrency, candidates.length);
  await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  await saveChain;
  if (fatal) throw fatal;
  refreshCertification(progress, manifest, new Date().toISOString());
  await writeJsonAtomically(EMBED_PROGRESS_PATH, progress);
  return { progress, attempted: candidates.length };
}

export function hasCompactPublicCounter(post) {
  if (!isRecord(post)) return false;
  const prefix = String(post.ogDescription ?? "").match(
    /^\s*[\d.,\s]+([KMB]?)\s+likes?\s*,\s*[\d.,\s]+([KMB]?)\s+comments?\b/i,
  );
  const likesCompact = prefix ? Boolean(prefix[1]) : post.likesPrecision === "compact";
  const commentsCompact = prefix ? Boolean(prefix[2]) : post.commentsPrecision === "compact";
  const terminalPrecisions = new Set(["exact-embed", "exact-page-json", "compact-public-only"]);
  return (likesCompact && !terminalPrecisions.has(post.likesPrecision))
    || (commentsCompact && !terminalPrecisions.has(post.commentsPrecision));
}

async function refineCompactCounters(manifest, progressValue, options) {
  const progress = validateCertifiedProgress(progressValue, manifest);
  const candidates = manifest.items.filter((item) => {
    const record = progress.items[item.shortcode];
    return record?.status === "ok" && hasCompactPublicCounter(record.post);
  });
  if (!candidates.length) {
    return { progress, attempted: 0, refined: 0, unresolved: 0 };
  }

  const abortController = new AbortController();
  let cursor = 0;
  let processed = 0;
  let refined = 0;
  let unresolved = 0;
  let fatal = null;
  let saveChain = Promise.resolve();
  const checkpoint = () => {
    progress.collection.updatedAt = new Date().toISOString();
    saveChain = saveChain.then(() => writeJsonAtomically(EMBED_PROGRESS_PATH, progress));
    return saveChain;
  };
  const worker = async () => {
    while (!fatal && cursor < candidates.length) {
      const item = candidates[cursor++];
      try {
        const exact = await fetchEmbed(item, options, abortController.signal);
        if (exact.status !== "ok") {
          unresolved += 1;
          progress.items[item.shortcode].post.metricRefinement = {
            status: exact.status,
            observedAt: exact.observedAt,
            error: exact.error ?? `HTTP ${exact.httpStatus ?? "inconnu"}`,
          };
        } else {
          const current = progress.items[item.shortcode];
          const likes = exact.post.likes;
          const comments = exact.post.comments;
          if (likes == null && comments == null) {
            unresolved += 1;
            current.post.metricRefinement = {
              status: "metrics-hidden",
              observedAt: exact.observedAt,
            };
          } else {
            current.post = {
              ...current.post,
              likes: likes ?? current.post.likes,
              comments: comments ?? current.post.comments,
              likesPrecision: likes == null ? current.post.likesPrecision ?? "compact" : "exact-embed",
              commentsPrecision: comments == null ? current.post.commentsPrecision ?? "compact" : "exact-embed",
              metricRefinement: {
                status: "exact-embed",
                observedAt: exact.observedAt,
                source: item.embedUrl,
              },
            };
            refined += 1;
          }
        }
        processed += 1;
        if (processed % 20 === 0) await checkpoint();
      } catch (error) {
        if (!fatal) {
          fatal = error instanceof FatalCollectionError
            ? error
            : new FatalCollectionError("refinement-aborted", sanitizedError(error), item.shortcode);
          abortController.abort();
          await checkpoint();
        }
      }
    }
  };
  await Promise.allSettled(
    Array.from({ length: Math.min(options.concurrency, candidates.length) }, () => worker()),
  );
  await saveChain;
  if (fatal) throw fatal;
  await checkpoint();
  validateCertifiedProgress(progress, manifest);
  return { progress, attempted: candidates.length, refined, unresolved };
}

function mergeMetricHistories(...histories) {
  const byCapturedAt = new Map();
  for (const history of histories) {
    if (!Array.isArray(history)) continue;
    for (const point of history) {
      if (!isRecord(point) || typeof point.capturedAt !== "string" || !Number.isFinite(Date.parse(point.capturedAt))) continue;
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

function validateCertifiedProgress(value, manifest) {
  const progress = requireRecord(value, "instagram-embed-progress.json");
  if (progress.version !== PROGRESS_VERSION || progress.account !== ACCOUNT) {
    throw new Error("Progression Instagram incompatible avec cet importeur.");
  }
  const progressManifest = requireRecord(progress.manifest, "progress.manifest");
  if (!manifest.certified || manifest.endReached !== true
    || manifest.expectedCount !== manifest.uniqueShortcodeCount
    || !manifest.completedAt) {
    throw new Error("Import Instagram refusé : le manifeste du profil n'est pas certifié complet.");
  }
  if (progressManifest.source !== manifest.source
    || progressManifest.hash !== manifest.hash
    || progressManifest.uniqueShortcodeCount !== manifest.uniqueShortcodeCount
    || progressManifest.rawUrlCount !== manifest.rawUrlCount
    || progressManifest.endReached !== true
    || progressManifest.expectedCount !== manifest.expectedCount) {
    throw new Error("Import Instagram refusé : la progression ne correspond pas au manifeste URL courant.");
  }
  const collection = requireRecord(progress.collection, "progress.collection");
  if (collection.provider !== COLLECTOR || collection.certified !== true || collection.pendingCount !== 0 || collection.errorCount !== 0) {
    throw new Error("Import Instagram refusé : la collecte embed n'est pas certifiée complète.");
  }
  requireIso(collection.startedAt, "progress.collection.startedAt");
  requireIso(collection.completedAt, "progress.collection.completedAt");
  const items = requireRecord(progress.items, "progress.items");
  const mediaIds = new Set();
  for (const manifestItem of manifest.items) {
    const record = requireRecord(items[manifestItem.shortcode], `progress.items.${manifestItem.shortcode}`);
    if (record.shortcode !== manifestItem.shortcode || record.kind !== manifestItem.kind
      || record.canonicalUrl !== manifestItem.canonicalUrl || record.embedUrl !== manifestItem.embedUrl
      || record.stableThumbnailUrl !== manifestItem.stableThumbnailUrl) {
      throw new Error(`Progression incohérente pour ${manifestItem.shortcode}.`);
    }
    if (record.status !== "ok" && record.status !== "unavailable") {
      throw new Error(`Statut non terminal pour ${manifestItem.shortcode}.`);
    }
    requireIso(record.observedAt, `progress.items.${manifestItem.shortcode}.observedAt`);
    if (record.status === "ok") {
      const post = requireRecord(record.post, `progress.items.${manifestItem.shortcode}.post`);
      const mediaId = requireString(post.mediaId, `${manifestItem.shortcode}.mediaId`);
      if (mediaIds.has(mediaId)) throw new Error(`Identifiant média Instagram dupliqué : ${mediaId}.`);
      mediaIds.add(mediaId);
      const derived = deriveInstagramPublishedAt(mediaId);
      if (post.publishedAtSource === "instagram-og-description") {
        requireIso(post.publishedAt, `${manifestItem.shortcode}.publishedAt`);
        if (post.publishedAtPrecision !== "approximate" || post.publishedDatePrecision !== "day") {
          throw new Error(`Précision OG incohérente pour ${manifestItem.shortcode}.`);
        }
      } else if (post.publishedAt !== derived || post.publishedAtPrecision !== "approximate" || post.publishedAtSource !== "derived-media-id") {
        throw new Error(`Date dérivée incohérente pour ${manifestItem.shortcode}.`);
      }
      nullableString(post.caption, `${manifestItem.shortcode}.caption`);
      nullableString(post.authorUsername ?? null, `${manifestItem.shortcode}.authorUsername`);
      nullableString(post.imageUrl, `${manifestItem.shortcode}.imageUrl`);
      nullableCount(post.likes, `${manifestItem.shortcode}.likes`);
      nullableCount(post.comments, `${manifestItem.shortcode}.comments`);
    } else if (record.post !== null) {
      throw new Error(`Une fiche indisponible doit avoir post=null (${manifestItem.shortcode}).`);
    }
  }
  return progress;
}

function normalizedCounterPrecision(detail, metric) {
  if (!detail) return null;
  const stored = detail[`${metric}Precision`];
  if (stored && stored !== "compact") return stored;
  const prefix = String(detail.ogDescription ?? "").match(
    /^\s*[\d.,\s]+([KMB]?)\s+likes?\s*,\s*[\d.,\s]+([KMB]?)\s+comments?\b/i,
  );
  if (prefix) {
    const suffix = metric === "likes" ? prefix[1] : prefix[2];
    return suffix ? "compact-public-only" : "exact-og";
  }
  if (detail[metric] != null) return "exact-embed";
  return stored ?? null;
}

function normalizedInstagramPost(manifestItem, record) {
  const available = record.status === "ok";
  const detail = available ? record.post : null;
  const likes = detail?.likes ?? null;
  const comments = detail?.comments ?? null;
  const metricsObservedAt = detail?.metricRefinement?.observedAt ?? record.observedAt;
  const metricHistory = likes != null || comments != null
    ? [{
        capturedAt: metricsObservedAt,
        views: null,
        likes,
        comments,
        shares: null,
        saves: null,
        pollVotes: null,
        source: COLLECTOR,
      }]
    : [];
  return {
    platform: "instagram",
    externalId: manifestItem.shortcode,
    url: manifestItem.canonicalUrl,
    title: shortTitle(detail?.caption),
    text: cleanText(detail?.caption),
    format: manifestItem.kind === "reel" ? "reel" : "static",
    thumbnailUrl: manifestItem.stableThumbnailUrl,
    publishedAt: detail?.publishedAt ?? null,
    views: null,
    likes,
    comments,
    shares: null,
    saves: null,
    raw: {
      collector: COLLECTOR,
      collectorVersion: "embed-v1",
      source: "instagram-public-embed",
      permalinkKind: manifestItem.kind,
      authorUsername: detail?.authorUsername ?? null,
      availability: available ? "public-embed" : "unavailable-at-collection",
      mediaId: detail?.mediaId ?? null,
      publishedAtPrecision: detail?.publishedAtPrecision ?? "unknown",
      publishedAtSource: detail?.publishedAtSource ?? null,
      publishedDatePrecision: detail?.publishedDatePrecision ?? null,
      likesPrecision: normalizedCounterPrecision(detail, "likes"),
      commentsPrecision: normalizedCounterPrecision(detail, "comments"),
      firstObservedAt: record.observedAt,
      lastObservedAt: metricsObservedAt,
      metricHistory,
    },
  };
}

function mergeInstagramPost(existing, incoming) {
  if (!existing) return incoming;
  const existingRaw = isRecord(existing.raw) ? existing.raw : {};
  const incomingRaw = incoming.raw;
  return {
    ...existing,
    ...incoming,
    title: incoming.title ?? existing.title ?? null,
    text: incoming.text ?? existing.text ?? null,
    thumbnailUrl: incoming.thumbnailUrl ?? existing.thumbnailUrl ?? null,
    publishedAt: incoming.publishedAt ?? existing.publishedAt ?? null,
    views: incoming.views ?? existing.views ?? null,
    likes: incoming.likes ?? existing.likes ?? null,
    comments: incoming.comments ?? existing.comments ?? null,
    shares: incoming.shares ?? existing.shares ?? null,
    saves: incoming.saves ?? existing.saves ?? null,
    raw: {
      ...existingRaw,
      ...incomingRaw,
      firstObservedAt: existingRaw.firstObservedAt ?? incomingRaw.firstObservedAt,
      lastObservedAt: incomingRaw.lastObservedAt ?? existingRaw.lastObservedAt,
      metricHistory: mergeMetricHistories(existingRaw.metricHistory, incomingRaw.metricHistory),
    },
  };
}

function sortPosts(posts) {
  return [...posts].sort((left, right) => {
    const dateOrder = String(right.publishedAt ?? "").localeCompare(String(left.publishedAt ?? ""));
    return dateOrder || `${left.platform}:${left.externalId}`.localeCompare(`${right.platform}:${right.externalId}`);
  });
}

function coverageBounds(posts) {
  const dates = posts.map((post) => post.publishedAt).filter(Boolean).sort();
  return { oldestPublishedAt: dates[0] ?? null, newestPublishedAt: dates.at(-1) ?? null };
}

function replaceInstagramCoverage(coverage, incoming) {
  const current = Array.isArray(coverage) ? coverage : [];
  const index = current.findIndex((item) => isRecord(item) && item.platform === "instagram");
  if (index < 0) return [...current, incoming];
  return current.map((item, itemIndex) => itemIndex === index ? incoming : item);
}

export function buildCertifiedInstagramImport({ snapshot: snapshotValue, progress: progressValue, manifest }) {
  const snapshot = requireRecord(snapshotValue, "public-history.json");
  requireIso(snapshot.generatedAt, "public-history.generatedAt");
  requireArray(snapshot.posts, "public-history.posts");
  requireArray(snapshot.coverage, "public-history.coverage");
  const progress = validateCertifiedProgress(progressValue, manifest);
  const existingInstagram = snapshot.posts.filter((post) => post?.platform === "instagram");
  const existingById = new Map();
  for (const post of existingInstagram) {
    const id = requireString(post.externalId, "post Instagram externalId");
    if (existingById.has(id)) throw new Error(`Doublon Instagram existant : ${id}.`);
    existingById.set(id, post);
  }
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const manifestItem of manifest.items) {
    const incoming = normalizedInstagramPost(manifestItem, progress.items[manifestItem.shortcode]);
    const existing = existingById.get(manifestItem.shortcode);
    const merged = mergeInstagramPost(existing, incoming);
    existingById.set(manifestItem.shortcode, merged);
    if (!existing) inserted += 1;
    else if (JSON.stringify(existing) === JSON.stringify(merged)) unchanged += 1;
    else updated += 1;
  }
  const finalInstagram = [...existingById.values()];
  if (finalInstagram.length < existingInstagram.length) {
    throw new Error(`Import Instagram refusé : réduction de ${existingInstagram.length} à ${finalInstagram.length}.`);
  }
  const completedAt = progress.collection.completedAt;
  const coverage = {
    platform: "instagram",
    accountUrl: `https://www.instagram.com/${ACCOUNT}/`,
    scope: "historique public exhaustif du profil Instagram Lofi Girl",
    status: "complete-public-profile",
    itemCount: finalInstagram.length,
    ...coverageBounds(finalInstagram),
    limitations: [
      `Le manifeste certifié contient ${manifest.uniqueShortcodeCount} shortcodes uniques et porte endReached=true après arrivée au bas du profil connecté.`,
      "La certification couvre le profil visible lors du scroll et le traitement complet du manifeste, pas les contenus supprimés, privés ou archivés.",
      "La date publique au jour est utilisée lorsqu'Instagram l'expose ; seuls les rares fallbacks utilisent la date approximative dérivée de l'identifiant média.",
      "Likes et commentaires masqués restent null ; vues, partages et sauvegardes ne sont pas exposés publiquement et restent null.",
      "La miniature affichée utilise l'endpoint stable /p/{shortcode}/media/?size=l.",
    ],
    provenance: {
      provider: COLLECTOR,
      manifestSource: manifest.source,
      manifestSourceUpdatedAt: manifest.sourceUpdatedAt,
      manifestSourceCompletedAt: manifest.completedAt,
      manifestEndReached: manifest.endReached,
      manifestExpectedCount: manifest.expectedCount,
      manifestHash: manifest.hash,
      rawUrlCount: manifest.rawUrlCount,
      duplicateUrlCount: manifest.duplicateUrlCount,
      uniqueShortcodeCount: manifest.uniqueShortcodeCount,
      collectionStartedAt: progress.collection.startedAt,
      collectionCompletedAt: completedAt,
      okCount: progress.collection.okCount,
      unavailableCount: progress.collection.unavailableCount,
      importedAt: completedAt,
    },
  };
  const nextSnapshot = {
    ...snapshot,
    generatedAt: Date.parse(snapshot.generatedAt) >= Date.parse(completedAt) ? snapshot.generatedAt : completedAt,
    coverage: replaceInstagramCoverage(snapshot.coverage, coverage),
    posts: sortPosts([
      ...snapshot.posts.filter((post) => post?.platform !== "instagram"),
      ...finalInstagram,
    ]),
  };
  if (nextSnapshot.posts.length < snapshot.posts.length) {
    throw new Error(`Import Instagram refusé : snapshot réduit de ${snapshot.posts.length} à ${nextSnapshot.posts.length}.`);
  }
  return {
    snapshot: nextSnapshot,
    summary: {
      previousInstagramPosts: existingInstagram.length,
      manifestPosts: manifest.uniqueShortcodeCount,
      finalInstagramPosts: finalInstagram.length,
      inserted,
      updated,
      unchanged,
      unavailable: progress.collection.unavailableCount,
      coverageStatus: coverage.status,
      changed: JSON.stringify(snapshot) !== JSON.stringify(nextSnapshot),
    },
  };
}

async function importCertified(manifest, progress, dryRun) {
  const snapshot = await readJson(HISTORY_PATH, { label: "data/public-history.json" });
  const result = buildCertifiedInstagramImport({ snapshot, progress, manifest });
  if (result.summary.changed && !dryRun) await writeJsonAtomically(HISTORY_PATH, result.snapshot);
  return { ...result.summary, dryRun, willWrite: result.summary.changed && !dryRun };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const certifiedSource = await readJson(CERTIFIED_MANIFEST_PATH, { optional: true, label: "work/instagram-current-links.json" });
  const source = certifiedSource ?? await readJson(LEGACY_MANIFEST_PATH, { label: "work/instagram-url-progress.json" });
  const manifest = normalizeInstagramManifest(source);
  let progress = await readJson(EMBED_PROGRESS_PATH, { optional: true, label: "work/instagram-embed-progress.json" });

  if (options.dryRun) {
    const reconciled = reconcileProgress(progress, manifest, new Date().toISOString());
    const stats = collectionStats(reconciled, manifest);
    process.stdout.write(`${JSON.stringify({
      dryRun: true,
      rawUrlCount: manifest.rawUrlCount,
      uniqueShortcodeCount: manifest.uniqueShortcodeCount,
      duplicateUrlCount: manifest.duplicateUrlCount,
      manifestSource: manifest.source,
      manifestCertified: manifest.certified,
      endReached: manifest.endReached,
      expectedCount: manifest.expectedCount,
      manifestHash: manifest.hash,
      current: stats,
      wouldCollect: options.importOnly ? 0 : Math.min(
        stats.pendingCount + stats.errorCount,
        Number.isFinite(options.maxItems) ? options.maxItems : Number.MAX_SAFE_INTEGER,
      ),
      wouldImport: !options.collectOnly && reconciled.collection.certified,
      willCallNetwork: false,
      willWrite: false,
    }, null, 2)}\n`);
    return;
  }

  if (options.refineCompact) {
    if (!progress) throw new Error("Raffinement impossible : aucune progression Instagram certifiée.");
    const result = await refineCompactCounters(manifest, progress, options);
    process.stdout.write(`${JSON.stringify({
      phase: "refine-compact",
      attempted: result.attempted,
      refined: result.refined,
      unresolved: result.unresolved,
      remainingCompact: manifest.items.filter((item) =>
        hasCompactPublicCounter(result.progress.items[item.shortcode]?.post),
      ).length,
    })}\n`);
    return;
  }

  let attempted = 0;
  if (!options.importOnly) {
    const collected = await collectManifest(manifest, progress, options);
    progress = collected.progress;
    attempted = collected.attempted;
    const stats = collectionStats(progress, manifest);
    process.stdout.write(`${JSON.stringify({ phase: "collect", attempted, ...stats, certified: progress.collection.certified })}\n`);
  }
  if (options.collectOnly) return;
  if (!progress) throw new Error("Import impossible : aucune progression embed Instagram.");
  if (progress.collection?.certified !== true) {
    process.stdout.write("Collecte Instagram encore partielle : import différé jusqu'à certification complète.\n");
    return;
  }
  const summary = await importCertified(manifest, progress, false);
  process.stdout.write(`${JSON.stringify({ phase: "import", ...summary }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
