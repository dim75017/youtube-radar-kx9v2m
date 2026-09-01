export type ScrollingPlatform = "instagram" | "tiktok";
export type ScrollingSurface = "home" | "reels" | "explore" | "following" | "search";
export type ScrollingBrowserContext =
  | "incognito-explicitly-delegated"
  | "agent-tab-explicitly-delegated";
export type ScrollingMetricPrecision = "exact" | "platform-rounded" | "unavailable";
export type ScrollingFormat = "reel" | "carousel" | "image" | "video";
export type ScrollingConfidence = "high" | "medium" | "watch";
export type ScrollingEditorialStatus = "new" | "kept" | "dismissed";
export type ScrollingLensGroup = "storytelling" | "music" | "lifestyle" | "community";

export type ScrollingCast =
  | { character: "lofi-girl"; companion: "cat" }
  | { character: "lofi-boy"; companion: "dog" }
  | { character: "both"; companion: "cat-and-dog" };

export type ScrollingExplorationLens = {
  id: string;
  label: string;
  group: ScrollingLensGroup;
  specialty: string;
  description: string;
  observedInSnapshot: boolean;
  discoverySignals: string[];
  adaptationAngles: string[];
  rejectIf: string[];
};

export type ScrollingThemeCatalog = {
  version: 1;
  explorationLenses: ScrollingExplorationLens[];
};

export type ScrollingRun = {
  id: string;
  platform: ScrollingPlatform;
  surface: ScrollingSurface;
  browserContext: ScrollingBrowserContext;
  capturedAt: string;
  seenCount: number;
  qualifyingCount: number;
  sponsoredCount: number;
  themeIds: string[];
  limitations: string[];
};

export type ScrollingMetrics = {
  likes: number | null;
  views: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  precision: ScrollingMetricPrecision;
};

export type ScrollingSource = {
  platform: ScrollingPlatform;
  url: string;
  postId: string;
  author: string | null;
  sourceLabel: string;
  capturedAt: string;
  publishedAt: string | null;
  format: ScrollingFormat;
  thumbnailUrl: string | null;
  sponsored: boolean | null;
  metrics: ScrollingMetrics;
};

export type ScrollingAnalysis = {
  themeIds: string[];
  hook: string;
  mechanic: string;
  visualCue: string;
  reasonToStop: string;
  whyRelevant: string;
  confidence: ScrollingConfidence;
};

export type ScrollingAdaptation = {
  title: string;
  cast: ScrollingCast;
  concept: string;
  openingText: string;
  sequence: string[];
  caption: string;
  audioDirection: string;
  productionGuardrails: string[];
};

export type ScrollingItem = {
  id: string;
  runId: string;
  source: ScrollingSource;
  analysis: ScrollingAnalysis;
  adaptation: ScrollingAdaptation;
  editorialStatus: ScrollingEditorialStatus;
};

export type ScrollingFeed = {
  version: 1;
  capturedAt: string;
  minimumLikes: 10_000;
  methodology: string;
  limitations: string[];
  explorationLenses: ScrollingExplorationLens[];
  runs: ScrollingRun[];
  items: ScrollingItem[];
};

export const SCROLLING_MINIMUM_LIKES = 10_000;
export const SCROLLING_BROWSER_CONTEXT = "incognito-explicitly-delegated" as const;
export const SCROLLING_AGENT_TAB_CONTEXT = "agent-tab-explicitly-delegated" as const;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const NATIVE_POST_ID = /^[A-Za-z0-9_-]+$/u;
const LOCAL_THUMBNAIL = /^media\/scrolling\/[A-Za-z0-9_-]+\.(?:avif|jpe?g|png|webp)$/u;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|passwd|secret|session(?:id)?|token)/iu;
const PLATFORMS = new Set<ScrollingPlatform>(["instagram", "tiktok"]);
const SURFACES = new Set<ScrollingSurface>(["home", "reels", "explore", "following", "search"]);
const FORMATS = new Set<ScrollingFormat>(["reel", "carousel", "image", "video"]);
const PRECISIONS = new Set<ScrollingMetricPrecision>(["exact", "platform-rounded", "unavailable"]);
const CONFIDENCES = new Set<ScrollingConfidence>(["high", "medium", "watch"]);
const EDITORIAL_STATUSES = new Set<ScrollingEditorialStatus>(["new", "kept", "dismissed"]);
const LENS_GROUPS = new Set<ScrollingLensGroup>(["storytelling", "music", "lifestyle", "community"]);
const BROWSER_CONTEXTS = new Set<ScrollingBrowserContext>([
  SCROLLING_BROWSER_CONTEXT,
  SCROLLING_AGENT_TAB_CONTEXT,
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableMetric(value: unknown): value is number | null {
  return value === null || isCount(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new TypeError(`${label}: clé inconnue ${key}.`);
  }
}

function assertNoSensitiveKeys(value: unknown, path = "feed") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      throw new TypeError(`${path}: donnée d’authentification interdite (${key}).`);
    }
    assertNoSensitiveKeys(child, `${path}.${key}`);
  }
}

function assertTextArray(value: unknown, label: string, minimum = 1): asserts value is string[] {
  if (!Array.isArray(value) || value.length < minimum || value.some((item) => !isText(item))) {
    throw new TypeError(`${label}: liste de textes invalide.`);
  }
}

function canonicalUrl(value: string) {
  const parsed = new URL(value);
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/u, "")}`;
}

function nativePostId(value: string, platform: ScrollingPlatform): string | null {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/\/+$/u, "");
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    if (platform === "instagram") {
      if (!(host === "instagram.com" || host.endsWith(".instagram.com"))) return null;
      return path.match(/^\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)$/u)?.[1] ?? null;
    }
    if (!(host === "tiktok.com" || host.endsWith(".tiktok.com"))) return null;
    return path.match(/^\/@[^/]+\/video\/(\d{12,24})$/u)?.[1] ?? null;
  } catch {
    return null;
  }
}

function assertLens(value: unknown, label: string): asserts value is ScrollingExplorationLens {
  if (!isObject(value)) throw new TypeError(`${label}: objet attendu.`);
  assertOnlyKeys(
    value,
    [
      "id",
      "label",
      "group",
      "specialty",
      "description",
      "observedInSnapshot",
      "discoverySignals",
      "adaptationAngles",
      "rejectIf",
    ],
    label,
  );
  if (!isText(value.id) || !SLUG.test(value.id)) throw new TypeError(`${label}: id invalide.`);
  if (!isText(value.label) || !isText(value.specialty) || !isText(value.description)) {
    throw new TypeError(`${label}: libellés incomplets.`);
  }
  if (!LENS_GROUPS.has(value.group as ScrollingLensGroup)) throw new TypeError(`${label}: groupe invalide.`);
  if (typeof value.observedInSnapshot !== "boolean") throw new TypeError(`${label}: observedInSnapshot invalide.`);
  assertTextArray(value.discoverySignals, `${label}.discoverySignals`, 2);
  assertTextArray(value.adaptationAngles, `${label}.adaptationAngles`, 2);
  assertTextArray(value.rejectIf, `${label}.rejectIf`, 1);
}

function assertLensCollection(value: unknown, label: string): asserts value is ScrollingExplorationLens[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label}: catalogue vide.`);
  const ids = new Set<string>();
  value.forEach((lens, index) => {
    assertLens(lens, `${label}[${index}]`);
    if (ids.has(lens.id)) throw new TypeError(`${label}: id dupliqué ${lens.id}.`);
    ids.add(lens.id);
  });
}

export function assertScrollingThemeCatalog(value: unknown): ScrollingThemeCatalog {
  assertNoSensitiveKeys(value, "themes");
  if (!isObject(value)) throw new TypeError("Catalogue Scrolling invalide.");
  assertOnlyKeys(value, ["version", "explorationLenses"], "themes");
  if (value.version !== 1) throw new TypeError("Version du catalogue Scrolling invalide.");
  assertLensCollection(value.explorationLenses, "themes.explorationLenses");
  return value as ScrollingThemeCatalog;
}

function assertThemeIds(value: unknown, knownIds: Set<string>, label: string) {
  assertTextArray(value, label);
  if (new Set(value).size !== value.length) throw new TypeError(`${label}: thèmes dupliqués.`);
  for (const themeId of value) {
    if (!knownIds.has(themeId)) throw new TypeError(`${label}: thème inconnu ${themeId}.`);
  }
}

function assertRun(value: unknown, knownLensIds: Set<string>, label: string): asserts value is ScrollingRun {
  if (!isObject(value)) throw new TypeError(`${label}: objet attendu.`);
  assertOnlyKeys(
    value,
    ["id", "platform", "surface", "browserContext", "capturedAt", "seenCount", "qualifyingCount", "sponsoredCount", "themeIds", "limitations"],
    label,
  );
  if (!isText(value.id) || !SLUG.test(value.id)) throw new TypeError(`${label}: id invalide.`);
  if (!PLATFORMS.has(value.platform as ScrollingPlatform)) throw new TypeError(`${label}: plateforme invalide.`);
  if (!SURFACES.has(value.surface as ScrollingSurface)) throw new TypeError(`${label}: surface invalide.`);
  if (!BROWSER_CONTEXTS.has(value.browserContext as ScrollingBrowserContext)) {
    throw new TypeError(`${label}: contexte de navigation explicitement confié obligatoire.`);
  }
  if (!isTimestamp(value.capturedAt)) throw new TypeError(`${label}: capturedAt invalide.`);
  if (!isCount(value.seenCount) || value.seenCount === 0) throw new TypeError(`${label}: seenCount invalide.`);
  if (!isCount(value.qualifyingCount) || value.qualifyingCount > value.seenCount) {
    throw new TypeError(`${label}: qualifyingCount invalide.`);
  }
  if (!isCount(value.sponsoredCount) || value.sponsoredCount > value.seenCount) {
    throw new TypeError(`${label}: sponsoredCount invalide.`);
  }
  assertThemeIds(value.themeIds, knownLensIds, `${label}.themeIds`);
  assertTextArray(value.limitations, `${label}.limitations`);
}

function assertMetrics(value: unknown, label: string): asserts value is ScrollingMetrics {
  if (!isObject(value)) throw new TypeError(`${label}: objet attendu.`);
  assertOnlyKeys(value, ["likes", "views", "comments", "shares", "saves", "precision"], label);
  for (const metric of ["likes", "views", "comments", "shares", "saves"] as const) {
    if (!isNullableMetric(value[metric])) throw new TypeError(`${label}.${metric}: métrique invalide.`);
  }
  if (!PRECISIONS.has(value.precision as ScrollingMetricPrecision)) throw new TypeError(`${label}: précision invalide.`);
  const hasMetric = [value.likes, value.views, value.comments, value.shares, value.saves]
    .some((metric) => metric !== null);
  if (hasMetric === (value.precision === "unavailable")) {
    throw new TypeError(`${label}: précision incohérente avec les métriques disponibles.`);
  }
}

function assertSource(value: unknown, label: string): asserts value is ScrollingSource {
  if (!isObject(value)) throw new TypeError(`${label}: objet attendu.`);
  assertOnlyKeys(
    value,
    ["platform", "url", "postId", "author", "sourceLabel", "capturedAt", "publishedAt", "format", "thumbnailUrl", "sponsored", "metrics"],
    label,
  );
  if (!PLATFORMS.has(value.platform as ScrollingPlatform)) throw new TypeError(`${label}: plateforme invalide.`);
  if (!isText(value.url)) throw new TypeError(`${label}: URL manquante.`);
  const postId = nativePostId(value.url, value.platform as ScrollingPlatform);
  if (!postId) throw new TypeError(`${label}: URL native invalide.`);
  if (!isText(value.postId) || !NATIVE_POST_ID.test(value.postId) || value.postId !== postId) {
    throw new TypeError(`${label}: postId incohérent avec l’URL.`);
  }
  if (!(value.author === null || isText(value.author))) throw new TypeError(`${label}: auteur invalide.`);
  if (!isText(value.sourceLabel)) throw new TypeError(`${label}: sourceLabel manquant.`);
  if (!isTimestamp(value.capturedAt) || !isNullableTimestamp(value.publishedAt)) {
    throw new TypeError(`${label}: dates invalides.`);
  }
  if (!FORMATS.has(value.format as ScrollingFormat)) throw new TypeError(`${label}: format invalide.`);
  if (!(value.thumbnailUrl === null || (isText(value.thumbnailUrl) && LOCAL_THUMBNAIL.test(value.thumbnailUrl)))) {
    throw new TypeError(`${label}: miniature externe ou éphémère refusée.`);
  }
  if (!(value.sponsored === null || typeof value.sponsored === "boolean")) {
    throw new TypeError(`${label}: sponsored invalide.`);
  }
  assertMetrics(value.metrics, `${label}.metrics`);
}

function assertAnalysis(value: unknown, knownLensIds: Set<string>, label: string): asserts value is ScrollingAnalysis {
  if (!isObject(value)) throw new TypeError(`${label}: objet attendu.`);
  assertOnlyKeys(value, ["themeIds", "hook", "mechanic", "visualCue", "reasonToStop", "whyRelevant", "confidence"], label);
  assertThemeIds(value.themeIds, knownLensIds, `${label}.themeIds`);
  for (const field of ["hook", "mechanic", "visualCue", "reasonToStop", "whyRelevant"] as const) {
    if (!isText(value[field])) throw new TypeError(`${label}.${field}: texte manquant.`);
  }
  if (!CONFIDENCES.has(value.confidence as ScrollingConfidence)) throw new TypeError(`${label}: confiance invalide.`);
}

function assertCast(value: unknown, label: string): asserts value is ScrollingCast {
  if (!isObject(value)) throw new TypeError(`${label}: objet attendu.`);
  assertOnlyKeys(value, ["character", "companion"], label);
  const valid =
    (value.character === "lofi-girl" && value.companion === "cat") ||
    (value.character === "lofi-boy" && value.companion === "dog") ||
    (value.character === "both" && value.companion === "cat-and-dog");
  if (!valid) throw new TypeError(`${label}: personnage et animal incohérents.`);
}

function assertAdaptation(value: unknown, label: string): asserts value is ScrollingAdaptation {
  if (!isObject(value)) throw new TypeError(`${label}: objet attendu.`);
  assertOnlyKeys(
    value,
    ["title", "cast", "concept", "openingText", "sequence", "caption", "audioDirection", "productionGuardrails"],
    label,
  );
  for (const field of ["title", "concept", "openingText", "caption", "audioDirection"] as const) {
    if (!isText(value[field])) throw new TypeError(`${label}.${field}: texte manquant.`);
  }
  assertCast(value.cast, `${label}.cast`);
  assertTextArray(value.sequence, `${label}.sequence`, 3);
  assertTextArray(value.productionGuardrails, `${label}.productionGuardrails`, 2);
  const guardrails = value.productionGuardrails.join(" ");
  const forbidsAiMedia = /\b(?:aucune|aucun|sans)\b[^.]{0,180}\bIA\b/iu.test(guardrails) &&
    ["image", "vidéo", "voix", "musique"].every((medium) => guardrails.toLocaleLowerCase("fr").includes(medium));
  if (!/100\s*%\s*humain/iu.test(guardrails) || !forbidsAiMedia) {
    throw new TypeError(`${label}: garde-fous de production humaine incomplets.`);
  }
}

function assertItem(value: unknown, knownLensIds: Set<string>, label: string): asserts value is ScrollingItem {
  if (!isObject(value)) throw new TypeError(`${label}: objet attendu.`);
  assertOnlyKeys(value, ["id", "runId", "source", "analysis", "adaptation", "editorialStatus"], label);
  if (!isText(value.id) || !SLUG.test(value.id)) throw new TypeError(`${label}: id invalide.`);
  if (!isText(value.runId) || !SLUG.test(value.runId)) throw new TypeError(`${label}: runId invalide.`);
  assertSource(value.source, `${label}.source`);
  assertAnalysis(value.analysis, knownLensIds, `${label}.analysis`);
  assertAdaptation(value.adaptation, `${label}.adaptation`);
  if (!EDITORIAL_STATUSES.has(value.editorialStatus as ScrollingEditorialStatus)) {
    throw new TypeError(`${label}: statut éditorial invalide.`);
  }
}

export function assertScrollingFeed(value: unknown, catalog?: unknown): ScrollingFeed {
  assertNoSensitiveKeys(value);
  if (!isObject(value)) throw new TypeError("Feed Scrolling invalide.");
  assertOnlyKeys(
    value,
    ["version", "capturedAt", "minimumLikes", "methodology", "limitations", "explorationLenses", "runs", "items"],
    "feed",
  );
  if (value.version !== 1) throw new TypeError("Version du feed Scrolling invalide.");
  if (!isTimestamp(value.capturedAt)) throw new TypeError("capturedAt du feed Scrolling invalide.");
  if (value.minimumLikes !== SCROLLING_MINIMUM_LIKES) throw new TypeError("Seuil Scrolling invalide.");
  const minimumLikes = value.minimumLikes;
  if (!isText(value.methodology)) throw new TypeError("Méthodologie Scrolling manquante.");
  assertTextArray(value.limitations, "feed.limitations");
  assertLensCollection(value.explorationLenses, "feed.explorationLenses");

  if (catalog !== undefined) {
    const checkedCatalog = assertScrollingThemeCatalog(catalog);
    if (JSON.stringify(checkedCatalog.explorationLenses) !== JSON.stringify(value.explorationLenses)) {
      throw new TypeError("Le catalogue themes.json diverge du snapshot Scrolling.");
    }
  }

  const lensById = new Map(value.explorationLenses.map((lens) => [lens.id, lens]));
  const knownLensIds = new Set(lensById.keys());
  if (!Array.isArray(value.runs) || value.runs.length === 0) throw new TypeError("Aucun run Scrolling.");
  const runById = new Map<string, ScrollingRun>();
  value.runs.forEach((run, index) => {
    assertRun(run, knownLensIds, `feed.runs[${index}]`);
    if (runById.has(run.id)) throw new TypeError(`Run Scrolling dupliqué ${run.id}.`);
    runById.set(run.id, run);
  });

  if (!Array.isArray(value.items) || value.items.length === 0) throw new TypeError("Aucun item Scrolling.");
  const itemIds = new Set<string>();
  const sourceUrls = new Set<string>();
  const itemCountByRun = new Map<string, number>();
  const sponsoredItemCountByRun = new Map<string, number>();
  const observedLensIds = new Set<string>();
  for (const run of runById.values()) {
    for (const themeId of run.themeIds) observedLensIds.add(themeId);
  }
  value.items.forEach((item, index) => {
    assertItem(item, knownLensIds, `feed.items[${index}]`);
    if (itemIds.has(item.id)) throw new TypeError(`Item Scrolling dupliqué ${item.id}.`);
    itemIds.add(item.id);
    const sourceIdentity = `${item.source.platform}:${canonicalUrl(item.source.url)}`;
    if (sourceUrls.has(sourceIdentity)) throw new TypeError(`Source Scrolling dupliquée ${item.source.url}.`);
    sourceUrls.add(sourceIdentity);
    const run = runById.get(item.runId);
    if (!run) throw new TypeError(`Run Scrolling inconnu ${item.runId}.`);
    if (item.source.platform !== run.platform) throw new TypeError(`Plateforme incohérente pour ${item.id}.`);
    if (Date.parse(item.source.capturedAt) !== Date.parse(run.capturedAt)) {
      throw new TypeError(`Date de capture incohérente pour ${item.id}.`);
    }
    if (item.source.metrics.likes === null || item.source.metrics.likes < minimumLikes) {
      throw new TypeError(`Seuil de likes non atteint pour ${item.id}.`);
    }
    for (const themeId of item.analysis.themeIds) {
      if (!run.themeIds.includes(themeId)) throw new TypeError(`Thème ${themeId} absent du run ${run.id}.`);
      observedLensIds.add(themeId);
    }
    itemCountByRun.set(run.id, (itemCountByRun.get(run.id) ?? 0) + 1);
    if (item.source.sponsored === true) {
      sponsoredItemCountByRun.set(run.id, (sponsoredItemCountByRun.get(run.id) ?? 0) + 1);
    }
  });

  for (const run of runById.values()) {
    if ((itemCountByRun.get(run.id) ?? 0) > run.qualifyingCount) {
      throw new TypeError(`Plus d’idées retenues que de sources qualifiées pour ${run.id}.`);
    }
    if ((sponsoredItemCountByRun.get(run.id) ?? 0) > run.sponsoredCount) {
      throw new TypeError(`Plus de sources sponsorisées retenues qu’observées pour ${run.id}.`);
    }
  }
  for (const lens of lensById.values()) {
    if (lens.observedInSnapshot !== observedLensIds.has(lens.id)) {
      throw new TypeError(`observedInSnapshot incohérent pour ${lens.id}.`);
    }
  }

  return value as ScrollingFeed;
}
