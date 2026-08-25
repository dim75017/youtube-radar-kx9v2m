export type SocialPlatform = "youtube" | "instagram" | "tiktok" | "x";

export type SocialSourceKind =
  | "youtube_atom"
  | "youtube_public_profile"
  | "instagram_profile_embed"
  | "tiktok_creator_embed"
  | "x_server_rendered_profile";

export type NormalizedPost = {
  platform: SocialPlatform;
  externalId: string;
  url: string;
  title: string | null;
  text: string | null;
  format: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  raw: Record<string, unknown> | null;
};

export type ScanResult = {
  platform: SocialPlatform;
  externalAccountId: string;
  followerCount: number | null;
  sourceKind: SocialSourceKind;
  coverage: string;
  status: "ready" | "limited";
  posts: NormalizedPost[];
};

const ACCOUNTS = {
  youtube: {
    channelId: "UCSJ4gkVC6NrvII8umztf0Ow",
    feedUrl:
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCSJ4gkVC6NrvII8umztf0Ow",
    shortsUrl: "https://www.youtube.com/@LofiGirl/shorts",
    communityUrl: "https://www.youtube.com/@LofiGirl/posts",
  },
  instagram: {
    handle: "lofigirl",
    embedUrl: "https://www.instagram.com/lofigirl/embed/",
  },
  tiktok: {
    handle: "lofigirl",
    embedUrl: "https://www.tiktok.com/embed/@lofigirl",
  },
  x: {
    handle: "lofigirl",
    profileUrl: "https://x.com/lofigirl",
  },
} as const;

const FETCH_TIMEOUT_MS = 15_000;
const MAX_SOURCE_BYTES = 2_500_000;
const MAX_POSTS_PER_SOURCE = 24;

export class SocialScanError extends Error {
  readonly platform: SocialPlatform;

  constructor(platform: SocialPlatform, message: string) {
    super(message);
    this.name = "SocialScanError";
    this.platform = platform;
  }
}

export async function scanPlatform(
  platform: SocialPlatform,
): Promise<ScanResult> {
  switch (platform) {
    case "youtube":
      return scanYouTube();
    case "instagram":
      return scanInstagram();
    case "tiktok":
      return scanTikTok();
    case "x":
      return scanX();
  }
}

async function scanYouTube(): Promise<ScanResult> {
  const [feedResult, shortsResult, communityResult] = await Promise.allSettled([
    fetchPublicText(
      "youtube",
      ACCOUNTS.youtube.feedUrl,
      "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
    ),
    fetchPublicText(
      "youtube",
      ACCOUNTS.youtube.shortsUrl,
      "text/html,application/xhtml+xml",
    ),
    fetchPublicText(
      "youtube",
      ACCOUNTS.youtube.communityUrl,
      "text/html,application/xhtml+xml",
    ),
  ]);
  const xml = feedResult.status === "fulfilled" ? feedResult.value : "";
  const shortsPage =
    shortsResult.status === "fulfilled" ? shortsResult.value : "";
  const communityPage =
    communityResult.status === "fulfilled" ? communityResult.value : "";
  if (!xml && !shortsPage && !communityPage) {
    throw new SocialScanError(
      "youtube",
      "Les onglets publics Shorts et Communauté sont momentanément indisponibles.",
    );
  }
  const shortIds = new Set(
    uniqueMatches(shortsPage, /"videoId":"([A-Za-z0-9_-]{6,20})"/g),
  );
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];
  const posts: NormalizedPost[] = [];

  for (const entryMatch of entries.slice(0, MAX_POSTS_PER_SOURCE)) {
    const entry = entryMatch[1];
    const videoId = xmlTag(entry, "yt:videoId");
    if (!videoId || !shortIds.has(videoId)) continue;

    const title = xmlTag(entry, "title") ?? "";
    const description = xmlTag(entry, "media:description") ?? "";
    const thumbnailTag = entry.match(/<media:thumbnail\b[^>]*>/i)?.[0] ?? "";
    const statisticsTag = entry.match(/<media:statistics\b[^>]*>/i)?.[0] ?? "";
    const starRatingTag = entry.match(/<media:starRating\b[^>]*>/i)?.[0] ?? "";
    const publishedAt = normalizeDate(xmlTag(entry, "published"));
    const url = `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`;

    posts.push({
      platform: "youtube",
      externalId: videoId,
      url,
      title,
      text: description,
      format: "short",
      thumbnailUrl: xmlAttribute(thumbnailTag, "url"),
      publishedAt,
      views: countOrNull(xmlAttribute(statisticsTag, "views")),
      // Atom exposes a legacy rating count, not a documented like count.
      // Keeping it in raw prevents us from relabelling it as likes.
      likes: null,
      comments: null,
      shares: null,
      saves: null,
      raw: {
        source: "youtube_atom",
        updatedAt: normalizeDate(xmlTag(entry, "updated")),
        ratingCount: countOrNull(xmlAttribute(starRatingTag, "count")),
      },
    });
  }

  if (communityPage) posts.push(...youtubeCommunityPosts(communityPage));

  const parsedChannelId = xml ? xmlTag(xml, "yt:channelId") : null;
  const channelId =
    parsedChannelId && /^UC[A-Za-z0-9_-]{22}$/.test(parsedChannelId)
      ? parsedChannelId
      : ACCOUNTS.youtube.channelId;
  return {
    platform: "youtube",
    externalAccountId: channelId,
    followerCount: null,
    sourceKind: "youtube_public_profile",
    coverage:
      `Onglets publics Shorts${xml && shortsPage ? " ✓" : " indisponible"} + Communauté${communityPage ? " ✓" : " indisponible"} · ${posts.length} contenus récents dans ce relevé · vidéos longues et lives exclus · commentaires écrits par le compte non énumérables sans accès propriétaire.`,
    status: "limited",
    posts,
  };
}

async function scanInstagram(): Promise<ScanResult> {
  const handle = ACCOUNTS.instagram.handle;
  const html = await fetchPublicText(
    "instagram",
    ACCOUNTS.instagram.embedUrl,
    "text/html,application/xhtml+xml",
  );
  const decoded = decodeEmbeddedPage(html);
  const structured = instagramStructuredPosts(html, handle);
  const candidates = new Map<string, { kind: "p" | "reel" }>();
  const linkPattern = /(?:https?:\/\/www\.instagram\.com)?\/(p|reel)\/([A-Za-z0-9_-]+)/gi;

  for (const match of decoded.matchAll(linkPattern)) {
    const kind = match[1].toLowerCase() === "reel" ? "reel" : "p";
    candidates.set(match[2], { kind });
    if (candidates.size >= MAX_POSTS_PER_SOURCE) break;
  }

  const posts: NormalizedPost[] =
    structured.posts.length > 0
      ? structured.posts
      : [...candidates.entries()].map(([shortcode, candidate]) => ({
          platform: "instagram" as const,
          externalId: shortcode,
          url: `https://www.instagram.com/${candidate.kind}/${shortcode}/`,
          title: "",
          text: "",
          format: candidate.kind === "reel" ? "reel" : "post",
          thumbnailUrl: null,
          publishedAt: null,
          views: null,
          likes: null,
          comments: null,
          shares: null,
          saves: null,
          raw: {
            source: "instagram_profile_embed",
            shortcode,
            mediaRoute: candidate.kind,
          },
        }));

  return {
    platform: "instagram",
    externalAccountId:
      structured.externalAccountId ?? instagramProfileId(decoded, handle) ?? handle,
    followerCount: structured.followerCount ?? compactFollowerCount(decoded),
    sourceKind: "instagram_profile_embed",
    coverage:
      structured.posts.length > 0
        ? `Embed profil public · ${posts.length} publications récentes · likes, commentaires et dates visibles · portée, partages et sauvegardes absents.`
        : posts.length > 0
          ? `Embed profil public · ${posts.length} liens de publications détectés · dates et métriques non exposées de façon fiable.`
        : "Embed profil public joignable, mais aucune publication ni métrique fiable n’est exposée sans accès Instagram autorisé.",
    status: "limited",
    posts,
  };
}

async function scanTikTok(): Promise<ScanResult> {
  const handle = ACCOUNTS.tiktok.handle;
  const html = await fetchPublicText(
    "tiktok",
    ACCOUNTS.tiktok.embedUrl,
    "text/html,application/xhtml+xml",
  );
  const stateText = htmlScriptById(html, "__FRONTITY_CONNECT_STATE__");
  if (!stateText) {
    return {
      platform: "tiktok",
      externalAccountId: handle,
      followerCount: null,
      sourceKind: "tiktok_creator_embed",
      coverage:
        "Embed créateur public joignable, mais son bloc de données n’est pas exposé dans cette réponse.",
      status: "limited",
      posts: [],
    };
  }

  let state: unknown;
  try {
    state = JSON.parse(decodeHtmlEntities(stateText));
  } catch {
    throw new SocialScanError(
      "tiktok",
      "Le bloc public TikTok est présent mais son format n’est pas lisible.",
    );
  }

  const root = asRecord(state);
  const source = asRecord(root?.source);
  const data = asRecord(source?.data);
  const route = data
    ? Object.values(data).find((value) => {
        const record = asRecord(value);
        const userInfo = asRecord(record?.userInfo);
        return stringOrNull(userInfo?.uniqueId)?.toLowerCase() === handle;
      })
    : undefined;
  const routeRecord = asRecord(route);
  const userInfo = asRecord(routeRecord?.userInfo);
  const videoList = Array.isArray(routeRecord?.videoList)
    ? routeRecord.videoList
    : [];

  const posts: NormalizedPost[] = [];
  for (const item of videoList.slice(0, MAX_POSTS_PER_SOURCE)) {
    const video = asRecord(item);
    const id = stringOrNull(video?.id);
    if (!video || !id) continue;
    const text = stringOrNull(video.desc) ?? "";

    posts.push({
      platform: "tiktok",
      externalId: id,
      url: `https://www.tiktok.com/@${handle}/video/${id}`,
      title: shortTitle(text),
      text,
      format: "video",
      thumbnailUrl:
        stringOrNull(video.coverUrl) ?? stringOrNull(video.originCoverUrl),
      // The creator embed does not expose creation time. We intentionally do
      // not infer it from undocumented bits of the video id.
      publishedAt: null,
      views: countOrNull(video.playCount),
      likes: null,
      comments: null,
      shares: null,
      saves: null,
      raw: {
        source: "tiktok_creator_embed",
        authorUniqueId: stringOrNull(video.authorUniqueId),
        width: countOrNull(video.width),
        height: countOrNull(video.height),
        privateItem:
          typeof video.privateItem === "boolean" ? video.privateItem : null,
      },
    });
  }

  return {
    platform: "tiktok",
    externalAccountId: stringOrNull(userInfo?.id) ?? handle,
    followerCount: countOrNull(userInfo?.followerCount),
    sourceKind: "tiktok_creator_embed",
    coverage:
      "Embed créateur public · sélection affichée, sans chronologie récente garantie · vues actuelles uniquement · date, likes, commentaires, partages et sauvegardes absents.",
    status: "limited",
    posts,
  };
}

async function scanX(): Promise<ScanResult> {
  const handle = ACCOUNTS.x.handle;
  const html = await fetchPublicText(
    "x",
    ACCOUNTS.x.profileUrl,
    "text/html,application/xhtml+xml",
  );
  const source = decodeEmbeddedPage(html);
  const externalAccountId =
    source.match(/__typename:"User",rest_id:"(\d+)"/)?.[1] ?? handle;
  const userReference =
    externalAccountId === handle
      ? null
      : asciiBase64(`UserResults:${externalAccountId}`);
  const tweetIds = uniqueMatches(source, /TweetResults:(\d+)/g).slice(
    0,
    MAX_POSTS_PER_SOURCE,
  );
  const posts: NormalizedPost[] = [];

  for (const id of tweetIds) {
    const key = asciiBase64(`Tweet:${id}`);
    const core = sourceBlock(source, `"client:${key}:core"`, 1_500);
    if (userReference && core && !core.includes(userReference)) continue;

    const counts = sourceBlock(source, `"client:${key}:counts"`, 2_000);
    const details = sourceBlock(source, `"client:${key}:details"`, 5_000);
    const viewsBlock = sourceBlock(source, `"client:${key}:views"`, 1_000);
    const media = sourceBlock(
      source,
      `"client:${key}:media_entities2:0"`,
      5_000,
    );
    const text = quotedField(details, "full_text") ?? "";
    if (!text && !details) continue;

    const retweets = namedCount(counts, "retweet_count");
    const quotes = namedCount(counts, "quote_count");
    const createdAtMs = namedCount(details, "created_at_ms");
    const mediaType = quotedField(media, "type");

    posts.push({
      platform: "x",
      externalId: id,
      url: `https://x.com/${handle}/status/${id}`,
      title: shortTitle(text),
      text,
      format:
        mediaType === "video"
          ? "video"
          : mediaType === "photo"
            ? "image"
            : "text",
      thumbnailUrl: quotedField(media, "media_url_https"),
      publishedAt:
        createdAtMs === null
          ? null
          : normalizeDate(new Date(createdAtMs).toISOString()),
      views: namedCount(viewsBlock, "count"),
      likes: namedCount(counts, "favorite_count"),
      comments: namedCount(counts, "reply_count"),
      shares: sumKnownCounts(retweets, quotes),
      saves: namedCount(counts, "bookmark_count"),
      raw: {
        source: "x_server_rendered_profile",
        retweets,
        quotes,
        mediaType,
      },
    });
  }

  return {
    platform: "x",
    externalAccountId,
    followerCount: compactFollowerCount(source),
    sourceKind: "x_server_rendered_profile",
    coverage:
      "Rendu serveur public du profil · publications et métriques visibles au moment du scan · historique, portée détaillée et métriques privées absents.",
    status: "limited",
    posts,
  };
}

function youtubeCommunityPosts(source: string): NormalizedPost[] {
  const initialData = youtubeInitialData(source);
  if (!initialData) return [];

  const renderers: unknown[] = [];
  collectValuesByKey(initialData, "backstagePostRenderer", renderers);
  const seen = new Set<string>();
  const posts: NormalizedPost[] = [];

  for (const value of renderers) {
    const renderer = asRecord(value);
    const postId = stringOrNull(renderer?.postId);
    const authorId = nestedString(renderer, [
      "authorEndpoint",
      "browseEndpoint",
      "browseId",
    ]);
    if (
      !renderer ||
      !postId ||
      seen.has(postId) ||
      (authorId && authorId !== ACCOUNTS.youtube.channelId)
    ) {
      continue;
    }
    seen.add(postId);

    const text = rendererText(renderer.contentText);
    const attachment = asRecord(renderer.backstageAttachment);
    const format = youtubeCommunityAttachmentFormat(attachment);
    // Community shares that embed a long video, a live, a playlist or another
    // unsupported attachment are outside this Radar's editorial-post scope.
    if (!format) continue;
    const isPoll = format === "community_poll";
    const pollVotes = isPoll ? firstCountForKeys(attachment, ["totalVotes", "totalVotesText"]) : null;

    posts.push({
      platform: "youtube",
      externalId: postId,
      url: `https://www.youtube.com/post/${encodeURIComponent(postId)}`,
      title: shortTitle(text || (isPoll ? "Sondage Communauté" : "Post Communauté")),
      text,
      format,
      thumbnailUrl: firstThumbnailUrl(attachment),
      publishedAt: null,
      views: null,
      likes: compactCountOrNull(rendererText(renderer.voteCount)),
      comments: communityReplyCount(renderer.actionButtons),
      shares: null,
      saves: null,
      raw: {
        source: "youtube_public_community",
        publishedLabel: rendererText(renderer.publishedTimeText) || null,
        pollVotes,
        attachmentType: format,
        metricSources: {
          likes: "compteur public du post Communauté",
          comments: "compteur public du post Communauté",
          pollVotes: isPoll ? "total public du sondage" : null,
        },
      },
    });
    if (posts.length >= MAX_POSTS_PER_SOURCE) break;
  }

  return posts;
}

export function youtubeCommunityAttachmentFormat(
  value: unknown,
): "community_poll" | "community_image" | "community_text" | null {
  const attachment = asRecord(value);
  if (!attachment || Object.keys(attachment).length === 0) {
    return "community_text";
  }

  const attachmentJson = JSON.stringify(attachment);
  if (/"(?:pollRenderer|backstagePollRenderer)"/.test(attachmentJson)) {
    return "community_poll";
  }
  if (/"(?:backstageImageRenderer|postMultiImageRenderer)"/.test(attachmentJson)) {
    return "community_image";
  }
  return null;
}

function youtubeInitialData(source: string): unknown | null {
  for (const marker of [
    "var ytInitialData = ",
    'window["ytInitialData"] = ',
  ]) {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) continue;
    const start = skipWhitespace(source, markerIndex + marker.length);
    const payload = balancedJsonValue(source, start);
    if (!payload) continue;
    try {
      return JSON.parse(payload);
    } catch {
      // Try the other supported assignment form before giving up.
    }
  }
  return null;
}

function rendererText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return typeof value === "string" ? value.trim() : "";
  const simpleText = stringOrNull(record.simpleText);
  if (simpleText) return simpleText;
  const runs = Array.isArray(record.runs) ? record.runs : [];
  return runs
    .map((run) => stringOrNull(asRecord(run)?.text) ?? "")
    .join("")
    .trim();
}

function collectValuesByKey(
  value: unknown,
  key: string,
  output: unknown[],
  depth = 0,
): void {
  if (depth > 30 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectValuesByKey(item, key, output, depth + 1);
    return;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key) output.push(entryValue);
    else collectValuesByKey(entryValue, key, output, depth + 1);
  }
}

function firstThumbnailUrl(value: unknown): string | null {
  const thumbnailArrays: unknown[] = [];
  collectValuesByKey(value, "thumbnails", thumbnailArrays);
  for (const candidate of thumbnailArrays) {
    if (!Array.isArray(candidate)) continue;
    for (const thumbnail of [...candidate].reverse()) {
      const url = stringOrNull(asRecord(thumbnail)?.url);
      if (url) return url.startsWith("//") ? `https:${url}` : url;
    }
  }
  return null;
}

function firstCountForKeys(value: unknown, keys: string[]): number | null {
  for (const key of keys) {
    const candidates: unknown[] = [];
    collectValuesByKey(value, key, candidates);
    for (const candidate of candidates) {
      const count = compactCountOrNull(rendererText(candidate));
      if (count !== null) return count;
    }
  }
  return null;
}

function communityReplyCount(value: unknown): number | null {
  const labels: unknown[] = [];
  collectValuesByKey(value, "label", labels);
  for (const label of labels) {
    if (typeof label !== "string" || !/(?:comments?|replies?)/i.test(label)) continue;
    const count = compactCountOrNull(label);
    if (count !== null) return count;
  }
  return null;
}

function compactCountOrNull(value: string): number | null {
  const match = value.match(/([\d.,]+)\s*([KMB])?/i);
  if (!match) return null;
  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  const numeric = Number.parseFloat(
    match[1].replace(/,(?=\d{3}\b)/g, "").replace(",", "."),
  );
  return Number.isFinite(numeric) ? Math.round(numeric * multiplier) : null;
}

async function fetchPublicText(
  platform: SocialPlatform,
  url: string,
  accept: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
      headers: {
        accept,
        "accept-language": "en-US,en;q=0.9",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) {
      throw new SocialScanError(
        platform,
        `La source publique ${platform} répond ${response.status}.`,
      );
    }

    const declaredSize = countOrNull(response.headers.get("content-length"));
    if (declaredSize !== null && declaredSize > MAX_SOURCE_BYTES) {
      throw new SocialScanError(
        platform,
        `La réponse publique ${platform} dépasse la taille autorisée.`,
      );
    }

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_SOURCE_BYTES) {
      throw new SocialScanError(
        platform,
        `La réponse publique ${platform} dépasse la taille autorisée.`,
      );
    }
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof SocialScanError) throw error;
    if (controller.signal.aborted) {
      throw new SocialScanError(
        platform,
        `La source publique ${platform} n’a pas répondu en ${FETCH_TIMEOUT_MS / 1000} secondes.`,
      );
    }
    throw new SocialScanError(
      platform,
      `Lecture de la source publique ${platform} impossible : ${error instanceof Error ? error.message : "erreur inconnue"}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function xmlTag(source: string, tag: string): string | null {
  const escapedTag = escapeRegExp(tag);
  const match = source.match(
    new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, "i"),
  );
  return match ? decodeHtmlEntities(stripTags(match[1])).trim() : null;
}

function xmlAttribute(source: string, attribute: string): string | null {
  const escapedAttribute = escapeRegExp(attribute);
  const match = source.match(
    new RegExp(`\\b${escapedAttribute}=["']([^"']*)["']`, "i"),
  );
  return match ? decodeHtmlEntities(match[1]).trim() : null;
}

function htmlScriptById(source: string, id: string): string | null {
  const escapedId = escapeRegExp(id);
  const match = source.match(
    new RegExp(
      `<script\\b(?=[^>]*\\bid=["']${escapedId}["'])[^>]*>([\\s\\S]*?)<\\/script>`,
      "i",
    ),
  );
  return match?.[1] ?? null;
}

function instagramProfileId(source: string, handle: string): string | null {
  const handleIndex = source.toLowerCase().indexOf(`"username":"${handle}"`);
  if (handleIndex < 0) return null;
  const nearby = source.slice(Math.max(0, handleIndex - 1_000), handleIndex + 200);
  const ids = [...nearby.matchAll(/"id":"(\d+)"/g)];
  return ids.at(-1)?.[1] ?? null;
}

function instagramStructuredPosts(
  source: string,
  handle: string,
): {
  posts: NormalizedPost[];
  externalAccountId: string | null;
  followerCount: number | null;
} {
  const contextStrings: string[] = [];
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const handleIndex = source.indexOf("s.handle(", searchFrom);
    if (handleIndex < 0) break;
    const payloadStart = skipWhitespace(source, handleIndex + "s.handle(".length);
    const payload = balancedJsonValue(source, payloadStart);
    if (payload) {
      try {
        collectNamedStrings(JSON.parse(payload), "contextJSON", contextStrings);
      } catch {
        // Some Instagram script blocks are JavaScript rather than JSON. They
        // are ignored instead of guessing their content.
      }
      searchFrom = payloadStart + payload.length;
    } else {
      searchFrom = handleIndex + "s.handle(".length;
    }
  }

  const mediaItems: unknown[] = [];
  for (const contextString of contextStrings) {
    if (!contextString.includes("graphql_media")) continue;
    try {
      const context = JSON.parse(decodeHtmlEntities(contextString));
      collectArraysByKey(context, "graphql_media", mediaItems);
    } catch {
      // A malformed context is skipped; missing data remains missing.
    }
  }

  const posts: NormalizedPost[] = [];
  const seen = new Set<string>();
  let followerCount: number | null = null;
  let externalAccountId: string | null = null;

  for (const item of mediaItems) {
    const itemRecord = asRecord(item);
    const media = asRecord(itemRecord?.shortcode_media) ?? itemRecord;
    const shortcode = stringOrNull(media?.shortcode);
    if (!media || !shortcode || seen.has(shortcode)) continue;
    seen.add(shortcode);

    const owner = asRecord(media.owner);
    externalAccountId ??= stringOrNull(owner?.id);
    followerCount ??= nestedCount(owner, ["edge_followed_by", "count"]);
    const caption =
      stringOrNull(media.caption) ??
      nestedString(media, ["edge_media_to_caption", "edges", 0, "node", "text"]) ??
      "";
    const typeName = stringOrNull(media.__typename);
    const timestamp = countOrNull(media.taken_at_timestamp);
    const videoViews = countOrNull(media.video_view_count);

    posts.push({
      platform: "instagram",
      externalId: shortcode,
      url: `https://www.instagram.com/${typeName === "GraphVideo" ? "reel" : "p"}/${shortcode}/`,
      title: shortTitle(caption),
      text: caption,
      format:
        typeName === "GraphVideo"
          ? "video"
          : typeName === "GraphSidecar"
            ? "carousel"
            : "image",
      thumbnailUrl: stringOrNull(media.display_url),
      publishedAt:
        timestamp === null
          ? null
          : normalizeDate(new Date(timestamp * 1_000).toISOString()),
      views: videoViews,
      likes:
        nestedCount(media, ["edge_liked_by", "count"]) ??
        nestedCount(media, ["edge_media_preview_like", "count"]),
      comments: nestedCount(media, ["edge_media_to_comment", "count"]),
      shares: null,
      saves: null,
      raw: {
        source: "instagram_profile_embed",
        shortcode,
        typeName,
        ownerUsername: stringOrNull(owner?.username) ?? handle,
      },
    });
    if (posts.length >= MAX_POSTS_PER_SOURCE) break;
  }

  return { posts, externalAccountId, followerCount };
}

function balancedJsonValue(source: string, start: number): string | null {
  const opening = source[start];
  if (opening !== "{" && opening !== "[") return null;
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

function collectNamedStrings(
  value: unknown,
  key: string,
  output: string[],
  depth = 0,
): void {
  if (depth > 20 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectNamedStrings(item, key, output, depth + 1);
    return;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key && typeof entryValue === "string") output.push(entryValue);
    else collectNamedStrings(entryValue, key, output, depth + 1);
  }
}

function collectArraysByKey(
  value: unknown,
  key: string,
  output: unknown[],
  depth = 0,
): void {
  if (depth > 20 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectArraysByKey(item, key, output, depth + 1);
    return;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key && Array.isArray(entryValue)) output.push(...entryValue);
    else collectArraysByKey(entryValue, key, output, depth + 1);
  }
}

function nestedValue(
  value: unknown,
  path: Array<string | number>,
): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      const record = asRecord(current);
      if (!record) return undefined;
      current = record[segment];
    }
  }
  return current;
}

function nestedCount(
  value: unknown,
  path: Array<string | number>,
): number | null {
  return countOrNull(nestedValue(value, path));
}

function nestedString(
  value: unknown,
  path: Array<string | number>,
): string | null {
  return stringOrNull(nestedValue(value, path));
}

function sourceBlock(source: string, marker: string, maxLength: number): string {
  const definitionIndex = source.indexOf(`${marker}:`);
  const index = definitionIndex >= 0 ? definitionIndex : source.indexOf(marker);
  return index < 0 ? "" : source.slice(index, index + maxLength);
}

function quotedField(source: string, field: string): string | null {
  const marker = `${field}:`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  let index = markerIndex + marker.length;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (source[index] !== '"') return null;
  index += 1;

  let output = "";
  while (index < source.length) {
    const character = source[index];
    if (character === '"') return output;
    if (character !== "\\") {
      output += character;
      index += 1;
      continue;
    }

    const escaped = source[index + 1];
    if (escaped === undefined) break;
    if (escaped === "n") output += "\n";
    else if (escaped === "r") output += "\r";
    else if (escaped === "t") output += "\t";
    else if (escaped === "u") {
      const hex = source.slice(index + 2, index + 6);
      if (/^[0-9a-f]{4}$/i.test(hex)) {
        output += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      output += "u";
    } else output += escaped;
    index += 2;
  }
  return null;
}

function namedCount(source: string, field: string): number | null {
  if (!source) return null;
  const escapedField = escapeRegExp(field);
  const match = source.match(
    new RegExp(`\\b${escapedField}:(?:"(\\d+)"|(\\d+))`),
  );
  return countOrNull(match?.[1] ?? match?.[2]);
}

function uniqueMatches(source: string, pattern: RegExp): string[] {
  const values = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    if (match[1]) values.add(match[1]);
  }
  return [...values];
}

function compactFollowerCount(source: string): number | null {
  const match = source.match(
    />([\d.,]+\s*[KMB]?)<\/div><div[^>]*>Followers</i,
  );
  if (!match) return null;
  const normalized = match[1].replace(/\s+/g, "").toUpperCase();
  const suffix = normalized.at(-1);
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  const numericPart = multiplier === 1 ? normalized : normalized.slice(0, -1);
  const number = Number.parseFloat(numericPart.replace(/,/g, ""));
  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

function decodeEmbeddedPage(source: string): string {
  return source
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/\\\\/g, "\\");
}

function decodeHtmlEntities(source: string): string {
  return source
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function stripTags(source: string): string {
  return source.replace(/<[^>]+>/g, "");
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function shortTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 100) return normalized;
  return `${normalized.slice(0, 97).trimEnd()}…`;
}

function countOrNull(value: unknown): number | null {
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function sumKnownCounts(...values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((total, value) => total + value, 0) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asciiBase64(value: string): string {
  return btoa(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
