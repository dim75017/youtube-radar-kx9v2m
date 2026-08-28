export type CommentPlatform = "youtube" | "instagram" | "tiktok" | "x";

export type AuthoredCommentLike = {
  platform: CommentPlatform;
  format?: unknown;
  url?: unknown;
  title?: unknown;
  text?: unknown;
  thumbnail_url?: unknown;
  thumbnailUrl?: unknown;
  raw_json?: unknown;
  raw?: unknown;
};

export type CommentAudiencePrecision =
  | "exact"
  | "platform-rounded"
  | "unknown";

export type CommentTarget = {
  contentId: string | null;
  url: string;
  title: string;
  thumbnailUrl: string | null;
  authorHandle: string | null;
  authorName: string | null;
  authorProfileUrl: string | null;
  audienceValue: number | null;
  audienceLabel: string | null;
  audiencePrecision: CommentAudiencePrecision;
  audienceObservedAt: string | null;
  source: string;
  confidence: "verified" | "derived" | "legacy-heuristic";
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rawRecord(post: AuthoredCommentLike): Record<string, unknown> {
  const direct = asRecord(post.raw);
  if (direct) return direct;
  if (typeof post.raw_json !== "string" || !post.raw_json.trim()) return {};
  try {
    return asRecord(JSON.parse(post.raw_json)) ?? {};
  } catch {
    return {};
  }
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numberValue(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.round(value);
    }
  }
  return null;
}

function canonicalFormat(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function firstMention(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().match(/^@([A-Za-z0-9_]{1,30})\b/)?.[1] ?? null;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function youtubeTarget(post: AuthoredCommentLike): Partial<CommentTarget> {
  const commentUrl = safeUrl(post.url);
  if (!commentUrl) return {};
  const url = new URL(commentUrl);
  url.searchParams.delete("lc");
  const videoId = url.searchParams.get("v");
  const contentId = videoId ?? url.pathname.match(/^\/post\/([^/?#]+)/)?.[1] ?? null;
  return {
    contentId,
    url: url.toString(),
    thumbnailUrl: videoId
      ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`
      : null,
    title: stringValue(post.title) ?? "Contenu YouTube commenté",
    source: "youtube-comment-permalink",
    confidence: "derived",
  };
}

export function isAuthoredComment(post: AuthoredCommentLike): boolean {
  const format = canonicalFormat(post.format);
  if (
    post.platform !== "x" &&
    (format === "comment" ||
      format === "channel_comment" ||
      format === "creator_reply" ||
      format === "reply")
  ) {
    return true;
  }

  const raw = rawRecord(post);
  if (asRecord(raw.commentTarget) || asRecord(raw.comment_target)) return true;
  if (post.platform !== "x") return false;
  if (format === "comment" || format === "reply") return true;
  return firstMention(post.text) !== null;
}

export function commentTarget(post: AuthoredCommentLike): CommentTarget {
  const raw = rawRecord(post);
  const stored = asRecord(raw.commentTarget) ?? asRecord(raw.comment_target) ?? {};
  const youtube = post.platform === "youtube" ? youtubeTarget(post) : {};
  const fallbackHandle = post.platform === "x" ? firstMention(post.text) : null;
  const contentUrl =
    safeUrl(stored.url) ??
    safeUrl(stored.contentUrl) ??
    safeUrl(stored.content_url) ??
    youtube.url ??
    safeUrl(post.url) ??
    "#";
  const authorHandle = stringValue(
    stored.authorHandle,
    stored.author_handle,
    fallbackHandle,
  );
  const storedPrecision = stringValue(
    stored.audiencePrecision,
    stored.audience_precision,
  );
  const audiencePrecision: CommentAudiencePrecision =
    storedPrecision === "exact" || storedPrecision === "platform-rounded"
      ? storedPrecision
      : "unknown";
  const verified = Object.keys(stored).length > 0;

  return {
    contentId: stringValue(
      stored.contentId,
      stored.content_id,
      youtube.contentId,
    ),
    url: contentUrl,
    title:
      stringValue(stored.title, youtube.title, post.title) ??
      "Contenu commenté",
    thumbnailUrl:
      safeUrl(stored.thumbnailUrl) ??
      safeUrl(stored.thumbnail_url) ??
      youtube.thumbnailUrl ??
      null,
    authorHandle,
    authorName: stringValue(stored.authorName, stored.author_name),
    authorProfileUrl:
      safeUrl(stored.authorProfileUrl) ??
      safeUrl(stored.author_profile_url),
    audienceValue: numberValue(
      stored.audienceValue,
      stored.audience_value,
      stored.followerCount,
      stored.follower_count,
    ),
    audienceLabel: stringValue(
      stored.audienceLabel,
      stored.audience_label,
    ),
    audiencePrecision,
    audienceObservedAt: stringValue(
      stored.audienceObservedAt,
      stored.audience_observed_at,
    ),
    source:
      stringValue(stored.source, youtube.source) ??
      "legacy-comment-history",
    confidence: verified
      ? "verified"
      : post.platform === "x"
        ? "legacy-heuristic"
        : "derived",
  };
}
