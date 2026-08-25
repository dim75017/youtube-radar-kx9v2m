export type SocialInlinePlatform = "youtube" | "instagram" | "tiktok" | "x";

const INSTAGRAM_PLAYBACK_EXPIRY_GUARD_MS = 60_000;

/**
 * Instagram's public reel page exposes a short-lived, signed MP4 URL. Keep the
 * checks fail-closed: stale or rewritten URLs must fall back to the inert
 * Instagram preview instead of being handed to the browser as media.
 */
export function resolveFreshInstagramPlaybackUrl(
  playbackUrl: string | null | undefined,
  playbackExpiresAt: string | null | undefined,
  now = Date.now(),
) {
  if (!playbackUrl || !playbackExpiresAt || !Number.isFinite(now)) return null;

  try {
    const url = new URL(playbackUrl);
    const hostname = url.hostname.toLowerCase();
    const expiresAt = Date.parse(playbackExpiresAt);
    const encodedExpiry = url.searchParams.get("oe");
    const signature = url.searchParams.get("oh");
    const signedExpiresAt = encodedExpiry && /^[0-9a-f]+$/iu.test(encodedExpiry)
      ? Number.parseInt(encodedExpiry, 16) * 1_000
      : Number.NaN;

    if (
      url.protocol !== "https:" ||
      !/^scontent(?:-[a-z0-9-]+)?\.cdninstagram\.com$/u.test(hostname) ||
      !url.pathname.toLowerCase().endsWith(".mp4") ||
      !signature ||
      signature.length < 16 ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(signedExpiresAt) ||
      Math.abs(expiresAt - signedExpiresAt) >= 1_000 ||
      expiresAt <= now + INSTAGRAM_PLAYBACK_EXPIRY_GUARD_MS
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

export function buildSocialInlineEmbedUrl(
  platform: SocialInlinePlatform,
  sourceUrl: string,
  hostOrigin = "",
) {
  try {
    const url = new URL(sourceUrl);
    const hostname = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/u, "");

    if (platform === "tiktok") {
      if (!isPlatformHost(hostname, "tiktok.com")) return null;
      const id = path.match(/^\/@[^/]+\/video\/(\d{12,24})$/iu)?.[1];
      return id
        ? `https://www.tiktok.com/player/v1/${id}?autoplay=0&muted=0&controls=1&volume_control=1&play_button=1&description=0&music_info=0&rel=0`
        : null;
    }

    if (platform === "youtube") {
      if (!isPlatformHost(hostname, "youtube.com")) return null;
      const id = path.match(/^\/shorts\/([A-Za-z0-9_-]{11})$/u)?.[1] ?? url.searchParams.get("v");
      if (!id || !/^[A-Za-z0-9_-]{11}$/u.test(id) || !hostOrigin) return null;
      return `https://www.youtube-nocookie.com/embed/${id}?autoplay=0&playsinline=1&rel=0&enablejsapi=1&origin=${encodeURIComponent(hostOrigin)}`;
    }

    if (platform === "instagram") {
      if (!isPlatformHost(hostname, "instagram.com")) return null;
      const match = path.match(/^\/(p|reel|reels)\/([^/]+)$/iu);
      if (!match) return null;
      const kind = match[1].toLowerCase() === "reels" ? "reel" : match[1].toLowerCase();
      return `https://www.instagram.com/${kind}/${match[2]}/embed/`;
    }

    if (!isPlatformHost(hostname, "x.com") && !isPlatformHost(hostname, "twitter.com")) return null;
    const id = path.match(/^\/[^/]+\/status\/(\d+)$/iu)?.[1];
    return id
      ? `https://platform.twitter.com/embed/Tweet.html?id=${id}&theme=dark&dnt=true`
      : null;
  } catch {
    return null;
  }
}

function isPlatformHost(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}
