export type SocialVideoPost = {
  platform: string;
  format: string;
  external_post_id: string;
  url: string;
  thumbnail_url: string | null;
};

export type SocialVideoEmbed = {
  platform: "youtube" | "tiktok";
  externalId: string;
  playerUrl: string;
  posterUrl: string | null;
};

export type TikTokThumbnail = {
  url: string;
  expiresAt: number;
};

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const TIKTOK_ID = /^\d{12,24}$/;

export function getSocialVideoEmbed(
  post: SocialVideoPost,
): SocialVideoEmbed | null {
  const externalId = post.external_post_id.trim();
  const format = post.format.trim().toLowerCase();

  if (
    post.platform === "youtube" &&
    format === "short" &&
    YOUTUBE_ID.test(externalId) &&
    isExactVideoPath(post.url, "youtube", externalId)
  ) {
    return {
      platform: "youtube",
      externalId,
      playerUrl: `https://www.youtube-nocookie.com/embed/${externalId}?autoplay=0&playsinline=1&rel=0`,
      posterUrl:
        post.thumbnail_url ??
        `https://i.ytimg.com/vi/${externalId}/hqdefault.jpg`,
    };
  }

  if (
    post.platform === "tiktok" &&
    format === "video" &&
    TIKTOK_ID.test(externalId) &&
    isExactVideoPath(post.url, "tiktok", externalId)
  ) {
    return {
      platform: "tiktok",
      externalId,
      playerUrl: `https://www.tiktok.com/player/v1/${externalId}?autoplay=0&controls=1&description=0&music_info=0&rel=0`,
      posterUrl: post.thumbnail_url,
    };
  }

  return null;
}

export function getTikTokOEmbedUrl(post: SocialVideoPost): string | null {
  const embed = getSocialVideoEmbed(post);
  if (!embed || embed.platform !== "tiktok") return null;
  return `https://www.tiktok.com/oembed?url=${encodeURIComponent(post.url)}`;
}

export function parseTikTokThumbnailUrl(
  value: unknown,
  now = Date.now(),
): TikTokThumbnail | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !isTikTokImageHost(url.hostname)) return null;
    const declaredExpiry = Number(url.searchParams.get("x-expires"));
    const expiresAt = Number.isFinite(declaredExpiry) && declaredExpiry > 0
      ? declaredExpiry * 1_000 - 60_000
      : now + 30 * 60_000;
    if (expiresAt <= now) return null;
    return { url: url.toString(), expiresAt };
  } catch {
    return null;
  }
}

function isExactVideoPath(
  value: string,
  platform: "youtube" | "tiktok",
  externalId: string,
): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (platform === "youtube") {
      return (
        (hostname === "youtube.com" || hostname.endsWith(".youtube.com")) &&
        url.pathname === `/shorts/${externalId}`
      );
    }
    const normalizedPath = url.pathname.replace(/\/+$/, "").toLowerCase();
    return (
      (hostname === "tiktok.com" || hostname.endsWith(".tiktok.com")) &&
      normalizedPath === `/@lofigirl/video/${externalId}`
    );
  } catch {
    return false;
  }
}

function isTikTokImageHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return [
    "tiktokcdn.com",
    "tiktokcdn-eu.com",
    "tiktokcdn-us.com",
    "muscdn.com",
  ].some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}
