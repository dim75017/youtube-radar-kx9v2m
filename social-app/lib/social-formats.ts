import type { SocialPlatform } from "./social-scanner.ts";

/**
 * Minimal shape shared by scanner posts, public-history posts and UI posts.
 * Keeping the contract small lets future collectors use the same taxonomy
 * without first converting their complete payload.
 */
export type SocialFormatPost<P extends SocialPlatform = SocialPlatform> = {
  platform: P;
  format: string | null;
  url?: string | null;
  title?: string | null;
  text?: string | null;
  raw?: Record<string, unknown> | null;
};

export type SocialFormatFilterDefinition<Key extends string = string> = {
  key: Key;
  label: string;
  emoji: string;
};

export const SOCIAL_FORMAT_FILTERS = {
  youtube: [
    { key: "all", label: "Tous", emoji: "✨" },
    { key: "short", label: "Shorts", emoji: "🎬" },
    { key: "community", label: "Communauté · image", emoji: "🖼️" },
    { key: "poll", label: "Sondages", emoji: "🗳️" },
    { key: "text", label: "Texte", emoji: "✍️" },
    { key: "comment", label: "Commentaires", emoji: "💭" },
  ],
  instagram: [
    { key: "all", label: "Tous", emoji: "✨" },
    { key: "reel", label: "Reels", emoji: "🎞️" },
    { key: "static", label: "Posts statiques", emoji: "🖼️" },
    { key: "comment", label: "Commentaires", emoji: "💭" },
  ],
  tiktok: [
    { key: "all", label: "Tous", emoji: "✨" },
    { key: "video", label: "Vidéos", emoji: "🎵" },
    { key: "comment", label: "Commentaires", emoji: "💭" },
  ],
  x: [
    { key: "all", label: "Tous", emoji: "✨" },
    { key: "static", label: "Statique", emoji: "🖼️" },
    { key: "video", label: "Vidéo", emoji: "🎥" },
    { key: "text", label: "Texte", emoji: "✍️" },
  ],
} as const satisfies Record<
  SocialPlatform,
  readonly SocialFormatFilterDefinition[]
>;

type Filters = typeof SOCIAL_FORMAT_FILTERS;

export type SocialFormatFilter<P extends SocialPlatform = SocialPlatform> =
  Filters[P][number]["key"];

export type SocialFormatCategoryByPlatform = {
  youtube:
    | "short"
    | "community"
    | "poll"
    | "text"
    | "comment"
    | "out-of-scope";
  instagram: "reel" | "static" | "comment";
  tiktok: "video" | "comment";
  x: "static" | "video" | "text";
};

export type SocialFormatCategory<
  P extends SocialPlatform = SocialPlatform,
> = SocialFormatCategoryByPlatform[P];

export type SocialFormatPresentation = {
  label: string;
  emoji: string;
};

const SOCIAL_FORMAT_CATEGORY_PRESENTATION: Record<
  SocialPlatform,
  Record<string, SocialFormatPresentation>
> = {
  youtube: {
    short: { label: "Short", emoji: "🎬" },
    community: { label: "Post communauté avec image", emoji: "🖼️" },
    poll: { label: "Sondage", emoji: "🗳️" },
    text: { label: "Post texte", emoji: "✍️" },
    comment: { label: "Commentaire", emoji: "💭" },
    "out-of-scope": { label: "Hors périmètre", emoji: "⛔" },
  },
  instagram: {
    reel: { label: "Reel", emoji: "🎞️" },
    static: { label: "Post statique", emoji: "🖼️" },
    comment: { label: "Commentaire", emoji: "💭" },
  },
  tiktok: {
    video: { label: "Vidéo", emoji: "🎵" },
    comment: { label: "Commentaire", emoji: "💭" },
  },
  x: {
    static: { label: "Post statique", emoji: "🖼️" },
    video: { label: "Post vidéo", emoji: "🎥" },
    text: { label: "Post texte", emoji: "✍️" },
  },
};

const COMMENT_ALIASES = new Set([
  "comment",
  "comments",
  "creator-comment",
  "channel-comment",
  "community-comment",
  "comment-reply",
  "reply",
  "replies",
]);

const YOUTUBE_SHORT_ALIASES = new Set([
  "short",
  "shorts",
  "youtube-short",
  "vertical-short",
]);
const YOUTUBE_POLL_ALIASES = new Set([
  "poll",
  "polls",
  "community-poll",
  "youtube-poll",
  "quiz",
]);
const YOUTUBE_TEXT_ALIASES = new Set([
  "text",
  "text-post",
  "community-text",
  "youtube-text",
]);
const YOUTUBE_COMMUNITY_ALIASES = new Set([
  "community-image",
  "youtube-community-image",
  "image",
  "photo",
  "carousel",
  "gif",
]);
const YOUTUBE_LONG_VIDEO_ALIASES = new Set([
  "video",
  "long-video",
  "longform-video",
  "long-form-video",
  "full-video",
  "upload",
]);
const YOUTUBE_LIVE_ALIASES = new Set([
  "live",
  "livestream",
  "live-stream",
  "stream",
  "premiere",
  "upcoming-live",
]);

const INSTAGRAM_REEL_ALIASES = new Set([
  "reel",
  "reels",
  "video",
  "graphvideo",
  "clips",
]);
const INSTAGRAM_STATIC_ALIASES = new Set([
  "post",
  "static",
  "static-post",
  "image",
  "photo",
  "carousel",
  "sidecar",
  "graphimage",
  "graphsidecar",
]);

const TIKTOK_VIDEO_ALIASES = new Set([
  "video",
  "videos",
  "tiktok-video",
  "post",
  "slideshow",
  "photo-mode",
]);

const X_VIDEO_ALIASES = new Set([
  "video",
  "animated-gif",
  "gif",
  "clip",
]);
const X_STATIC_ALIASES = new Set([
  "static",
  "static-post",
  "image",
  "photo",
  "photos",
  "carousel",
  "graphic",
]);
const X_TEXT_ALIASES = new Set([
  "text",
  "text-post",
  "tweet",
  "status",
  "post",
  "reply",
  "reply-post",
]);

const RAW_FORMAT_KEYS = new Set([
  "kind",
  "type",
  "format",
  "mediatype",
  "mediaroute",
  "contenttype",
  "posttype",
  "producttype",
  "typename",
]);

export function getFormatFilters<P extends SocialPlatform>(
  platform: P,
): Filters[P] {
  return SOCIAL_FORMAT_FILTERS[platform];
}

/** Return a canonical category, or null when a new payload cannot be inferred safely. */
export function classifySocialFormat<P extends SocialPlatform>(
  post: SocialFormatPost<P>,
): SocialFormatCategory<P> | null {
  const descriptor = formatDescriptor(post);
  const url = (post.url ?? "").toLowerCase();

  if (post.platform !== "x" && hasAlias(descriptor, COMMENT_ALIASES)) {
    return "comment" as SocialFormatCategory<P>;
  }

  switch (post.platform) {
    case "youtube":
      // A canonical long-form/live URL or flag always wins over a stale format
      // label. This prevents contradictory legacy rows from re-entering scope.
      if (
        isYouTubeVideoUrl(url) ||
        hasAlias(descriptor, YOUTUBE_LONG_VIDEO_ALIASES) ||
        hasAlias(descriptor, YOUTUBE_LIVE_ALIASES) ||
        rawFlag(post.raw, "isLive")
      ) {
        return "out-of-scope" as SocialFormatCategory<P>;
      }
      if (
        url.includes("youtube.com/shorts/") ||
        url.includes("youtu.be/shorts/") ||
        hasAlias(descriptor, YOUTUBE_SHORT_ALIASES) ||
        rawFlag(post.raw, "isShort")
      ) {
        return "short" as SocialFormatCategory<P>;
      }
      if (
        hasAlias(descriptor, YOUTUBE_POLL_ALIASES) ||
        rawFlag(post.raw, "isPoll")
      ) {
        return "poll" as SocialFormatCategory<P>;
      }
      if (hasAlias(descriptor, YOUTUBE_TEXT_ALIASES)) {
        return "text" as SocialFormatCategory<P>;
      }
      if (hasAlias(descriptor, YOUTUBE_COMMUNITY_ALIASES)) {
        return "community" as SocialFormatCategory<P>;
      }
      return null;

    case "instagram":
      if (
        url.includes("instagram.com/reel/") ||
        url.includes("instagram.com/reels/") ||
        hasAlias(descriptor, INSTAGRAM_REEL_ALIASES)
      ) {
        return "reel" as SocialFormatCategory<P>;
      }
      if (
        url.includes("instagram.com/p/") ||
        hasAlias(descriptor, INSTAGRAM_STATIC_ALIASES)
      ) {
        return "static" as SocialFormatCategory<P>;
      }
      return null;

    case "tiktok":
      if (
        url.includes("tiktok.com/") && url.includes("/video/") ||
        hasAlias(descriptor, TIKTOK_VIDEO_ALIASES)
      ) {
        return "video" as SocialFormatCategory<P>;
      }
      return null;

    case "x":
      if (hasAlias(descriptor, X_VIDEO_ALIASES)) {
        return "video" as SocialFormatCategory<P>;
      }
      if (hasAlias(descriptor, X_STATIC_ALIASES)) {
        return "static" as SocialFormatCategory<P>;
      }
      if (
        hasAlias(descriptor, X_TEXT_ALIASES) ||
        (isXStatusUrl(url) && !hasKnownMedia(post.raw))
      ) {
        return "text" as SocialFormatCategory<P>;
      }
      return null;
  }
}

export function matchesSocialFormatFilter<P extends SocialPlatform>(
  post: SocialFormatPost<P>,
  filter: SocialFormatFilter<P>,
): boolean {
  const category = classifySocialFormat(post);
  if (category === null || category === "out-of-scope") return false;
  if (filter === "all") return true;

  return category === filter;
}

export function getSocialFormatPresentation(
  post: SocialFormatPost,
): SocialFormatPresentation | null {
  const category = classifySocialFormat(post);
  if (category === null) return null;
  return SOCIAL_FORMAT_CATEGORY_PRESENTATION[post.platform][category] ?? null;
}

/** Ready-to-render label for cards, including the Radar-style emoji. */
export function getSocialFormatLabel(post: SocialFormatPost): string {
  const presentation = getSocialFormatPresentation(post);
  return presentation
    ? `${presentation.emoji} ${presentation.label}`
    : "❔ Format inconnu";
}

export const formatLabelForPost = getSocialFormatLabel;

/**
 * Type guard for untrusted collector payloads. It also enforces product scope:
 * YouTube long-form videos and livestreams deliberately return false.
 */
export function isInScopeSocialPost(value: unknown): value is SocialFormatPost {
  if (!isSocialFormatPost(value)) return false;
  const category = classifySocialFormat(value);
  return category !== null && category !== "out-of-scope";
}

export function isSocialFormatPost(value: unknown): value is SocialFormatPost {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!isSocialPlatform(record.platform)) return false;
  if (record.format !== null && typeof record.format !== "string") return false;
  if (!("format" in record)) return false;
  for (const key of ["url", "title", "text"] as const) {
    if (
      key in record &&
      record[key] !== null &&
      typeof record[key] !== "string"
    ) {
      return false;
    }
  }
  return !(
    "raw" in record &&
    record.raw !== null &&
    (typeof record.raw !== "object" || Array.isArray(record.raw))
  );
}

export function isYouTubeOutOfScope(
  post: SocialFormatPost,
): post is SocialFormatPost<"youtube"> {
  return (
    post.platform === "youtube" &&
    classifySocialFormat(post) === "out-of-scope"
  );
}

function formatDescriptor(post: SocialFormatPost): Set<string> {
  const values: string[] = [];
  if (post.format) values.push(post.format);
  collectRawFormatValues(post.raw, values);
  return new Set(values.flatMap(formatTokens));
}

function collectRawFormatValues(
  value: unknown,
  output: string[],
  depth = 0,
): void {
  if (depth > 3 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectRawFormatValues(item, output, depth + 1);
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = normalizeToken(key).replaceAll("-", "");
    if (RAW_FORMAT_KEYS.has(normalizedKey) && typeof entry === "string") {
      output.push(entry);
    } else if (entry !== null && typeof entry === "object") {
      collectRawFormatValues(entry, output, depth + 1);
    }
  }
}

function formatTokens(value: string): string[] {
  const normalized = normalizeToken(value);
  if (!normalized) return [];
  const tokens = normalized.split("-").filter(Boolean);
  return [normalized, ...tokens];
}

function normalizeToken(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^graph-?/, "graph")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function hasAlias(descriptor: Set<string>, aliases: Set<string>): boolean {
  for (const alias of aliases) {
    if (descriptor.has(alias)) return true;
  }
  return false;
}

function rawFlag(
  raw: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  if (!raw) return false;
  const wanted = key.toLowerCase();
  return findRawFlag(raw, wanted);
}

function findRawFlag(value: unknown, wanted: string, depth = 0): boolean {
  if (depth > 3 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => findRawFlag(item, wanted, depth + 1));
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key.toLowerCase() === wanted && entry === true) return true;
    if (findRawFlag(entry, wanted, depth + 1)) return true;
  }
  return false;
}

function isYouTubeVideoUrl(url: string): boolean {
  return (
    url.includes("youtube.com/watch") ||
    url.includes("youtube.com/live/") ||
    /^https?:\/\/youtu\.be\//.test(url)
  );
}

function isXStatusUrl(url: string): boolean {
  return /(?:x|twitter)\.com\/[^/]+\/status\//.test(url);
}

function hasKnownMedia(raw: Record<string, unknown> | null | undefined): boolean {
  if (!raw) return false;
  const descriptor = new Set<string>();
  const values: string[] = [];
  collectRawFormatValues(raw, values);
  for (const value of values.flatMap(formatTokens)) descriptor.add(value);
  return (
    hasAlias(descriptor, X_VIDEO_ALIASES) ||
    hasAlias(descriptor, X_STATIC_ALIASES)
  );
}

function isSocialPlatform(value: unknown): value is SocialPlatform {
  return (
    value === "youtube" ||
    value === "instagram" ||
    value === "tiktok" ||
    value === "x"
  );
}
