"use client";

/* eslint-disable @next/next/no-img-element -- thumbnails come from live social sources with dynamic hosts. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  calculatePlatformEngagementWindow,
  latestAudienceObservation,
  preferredAudienceHeadlineObservation,
  type AudienceHistory,
  type AudienceObservation,
} from "../lib/audience-metrics";
import {
  type AudienceAnalytics,
  type AudienceAnalyticsDailyPoint,
  type AudienceAnalyticsMetricKey,
  type AudienceAnalyticsPeriodKey,
  type AudienceAnalyticsPeriodSnapshot,
} from "../lib/audience-analytics";
import {
  type AudienceDemographicDimension,
  type AudienceDemographics,
} from "../lib/audience-demographics";
import { buildAudienceChartAxis } from "../lib/audience-chart-axis.mjs";
import { audienceDemographicDisplayEntries } from "../lib/audience-demographic-display.mjs";

import {
  generateSocialIdeas,
  type SocialIdea,
} from "../lib/social-ideas";
import {
  applyPreferenceLearning,
  EMPTY_EDITORIAL_WORKFLOW,
  feedbackForIdea,
  mergeWorkflowStates,
  normalizeWorkflowState,
  scheduleAcceptedIdea,
  type EditorialWorkflowState,
  type IdeaDecision,
  type LearnedIdea,
  type ScheduledIdea,
} from "../lib/editorial-workflow";
import {
  getFormatFilters,
  getSocialFormatLabel,
  matchesSocialFormatFilter,
  type SocialFormatFilter,
} from "../lib/social-formats";
import {
  SOCIAL_DURATION_FILTERS,
  hasKnownSocialPublishedDate,
  matchesSocialDuration,
  type SocialDurationFilter,
} from "../lib/social-duration";
import {
  getSocialVideoEmbed,
  getTikTokOEmbedUrl,
  parseTikTokThumbnailUrl,
} from "../lib/social-media";
import {
  rankPostsByPublicMetric,
} from "../lib/social-ranking";
import {
  buildEditorialAnalysisMapForTargets,
  editorialPostKey,
  type EditorialWhy,
} from "../lib/social-editorial-analysis";
import {
  assertSocialTrendFeed,
  filterSocialTrends,
  isActionableSocialTrend,
  selectGirlFirstSocialTrends,
  type SocialTrend,
  type SocialTrendFeed,
  type TrendCharacter,
  type TrendLifecycle,
  type TrendPlatform,
  type TrendReferencePost,
  type TrendTone,
} from "../lib/social-trends";
import {
  assertCommentOpportunityFeed,
  type CommentOpportunityFeed,
} from "../lib/comment-opportunities";
import {
  assertAudioTrendFeed,
  type AudioTrendFeed,
} from "../lib/audio-trends";
import {
  assertPlaylistPromoFeed,
  type PlaylistPromoFeed,
} from "../lib/playlist-promos";
import {
  assertScrollingFeed,
  type ScrollingFeed,
} from "../lib/scrolling";
import { dailyRotationIndex } from "../lib/daily-rotation";
import {
  type AudioTrendScanStatus,
  type VideoTrendScanStatus,
} from "../lib/trend-scan-status";
import { isAuthoredComment } from "../lib/authored-comments";
import { AudioTrendFeedView } from "./AudioTrendFeedView";
import { AuthoredCommentsView } from "./AuthoredCommentsView";
import { CommentOpportunitiesView } from "./CommentOpportunitiesView";
import {
  FilterDropdown,
  type FilterDropdownOption,
} from "./FilterDropdown";
import { PlaylistPromoFeedView } from "./PlaylistPromoFeedView";
import {
  PublicationComposer,
  type LocalPublicationScheduleEntry,
} from "./PublicationComposer";
import {
  PUBLICATION_STORAGE_KEY,
  normalizePublicationQueue,
  sortedPublicationPlans,
} from "../lib/social-publication";
import { ScrollingFeedView } from "./ScrollingFeedView";
import { SocialInlinePlayer } from "./SocialInlinePlayer";

type Platform = "youtube" | "instagram" | "tiktok" | "x";
type View = "overview" | "top" | "all-comments" | "comments" | "trends" | "audio-trends" | "scrolling" | "playlist-promos" | "ideas" | "planning" | "publication" | "all" | "sources";
type ExpandableNavView = Extract<View, "overview" | "top" | "all-comments" | "ideas">;
type IdeaStatusFilter = "all" | "pending" | IdeaDecision;
type PostSort = "popular" | "recent";
type TrendPlatformFilter = TrendPlatform | "all";

type MetricSnapshot = {
  captured_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  poll_votes: number | null;
  source: "live-scanner" | "public-history-collector" | string;
};

type SocialAccount = {
  id: string;
  platform: Platform;
  handle: string;
  display_name: string;
  profile_url: string;
  external_account_id: string | null;
  source_kind: string;
  coverage_label: string;
  status: "ready" | "limited" | "error" | "idle";
  follower_count: number | null;
  last_scan_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  post_count: number;
};

type SocialPost = {
  id: string;
  account_id: string;
  platform: Platform;
  external_post_id: string;
  url: string;
  title: string;
  text: string;
  format: string;
  thumbnail_url: string | null;
  published_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  poll_votes: number | null;
  raw_json?: string | null;
  performance_score: number | null;
  score_confidence: "high" | "medium" | "low" | "insufficient";
  score_explanation: string;
  analysis_label: string | null;
  source_kind: string;
  first_seen_at: string;
  last_seen_at: string;
  last_metric_at: string;
  published_at_precision?: "exact" | "approximate" | "unknown";
  metric_history?: MetricSnapshot[];
  editorial_analysis?: EditorialWhy;
};

type Insight = {
  emoji: string;
  title: string;
  summary: string;
  evidence?: string;
};

export type WorkspacePayload = {
  mode: "live" | "public-snapshot";
  notice: string;
  generatedAt: string;
  accounts: SocialAccount[];
  posts: SocialPost[];
  scans: unknown[];
  historyCoverage?: Array<{
    platform: Platform;
    scope: string;
    status: string;
    itemCount: number;
    oldestPublishedAt: string | null;
    newestPublishedAt: string | null;
    limitations: string[];
  }>;
  analysis?: {
    insights?: Array<
      Partial<Insight> & {
        title: string;
        detail?: string;
        platform?: Platform | "all";
      }
    >;
    crossPlatform?: Array<{
      label: string;
      platforms: Platform[];
      averageScore: number;
      postIds: string[];
    }>;
  } | null;
};

const PLATFORM_META: Record<
  Platform,
  { emoji: string; label: string; short: string; tone: string }
> = {
  youtube: { emoji: "▶️", label: "YouTube", short: "YT", tone: "red" },
  instagram: { emoji: "📸", label: "Instagram", short: "IG", tone: "pink" },
  tiktok: { emoji: "🎵", label: "TikTok", short: "TT", tone: "cyan" },
  x: { emoji: "𝕏", label: "X", short: "X", tone: "blue" },
};

const NAV: Array<{
  id: View;
  emoji: string;
  label: string;
  group: "Pilotage";
}> = [
  { id: "overview", emoji: "📊", label: "Analytics", group: "Pilotage" },
  { id: "top", emoji: "🏆", label: "Contenu", group: "Pilotage" },
  { id: "all-comments", emoji: "💬", label: "Commentaires", group: "Pilotage" },
  { id: "ideas", emoji: "💡", label: "Extraction", group: "Pilotage" },
  { id: "planning", emoji: "🗓️", label: "Planning", group: "Pilotage" },
  { id: "publication", emoji: "🚀", label: "Publication", group: "Pilotage" },
];

const NAV_SUBMENU_IDS: Record<ExpandableNavView, string> = {
  overview: "analytics-platform-subnav",
  top: "posts-platform-subnav",
  "all-comments": "comments-platform-subnav",
  ideas: "recommendations-subnav",
};

function isExpandableNavView(view: View): view is ExpandableNavView {
  return view === "overview" || view === "top" || view === "all-comments" || view === "ideas";
}

const RECOMMENDATION_NAV: Array<{
  id: Extract<View, "ideas" | "comments" | "trends" | "audio-trends" | "scrolling" | "playlist-promos">;
  emoji: string;
  label: string;
}> = [
  { id: "trends", emoji: "🔥", label: "Trends vidéos" },
  { id: "audio-trends", emoji: "🎧", label: "Trends audio" },
  { id: "scrolling", emoji: "🧭", label: "Scrolling" },
  { id: "playlist-promos", emoji: "🎯", label: "Pubs playlists" },
  { id: "ideas", emoji: "📝", label: "Posts recommandés" },
  { id: "comments", emoji: "💬", label: "Commentaires" },
];

const EDITORIAL_WORKFLOW_STORAGE_KEY = "lofi-social-radar:editorial-workflow:v2";
const EDITORIAL_WORKFLOW_MUTATION_LOCK = `${EDITORIAL_WORKFLOW_STORAGE_KEY}:mutation`;
const POSTS_PAGE_SIZE = 48;
const PLATFORM_ORDER: Platform[] = ["youtube", "instagram", "tiktok", "x"];
const DEFAULT_FORMAT_FILTER: Record<Platform, SocialFormatFilter> = {
  youtube: "short",
  instagram: "reel",
  tiktok: "video",
  x: "static",
};

const TOP_SORT_OPTIONS: readonly FilterDropdownOption<PostSort>[] = [
  { key: "popular", emoji: "🏆", label: "Plus populaire" },
  { key: "recent", emoji: "🗓️", label: "Plus récent" },
];

const TREND_PLATFORM_FILTERS: Array<{
  key: TrendPlatformFilter;
  emoji: string;
  label: string;
}> = [
  { key: "all", emoji: "🌐", label: "Tous" },
  { key: "instagram", emoji: "📸", label: "Instagram" },
  { key: "tiktok", emoji: "🎵", label: "TikTok" },
  { key: "youtube", emoji: "▶️", label: "YouTube Shorts" },
  { key: "x", emoji: "𝕏", label: "X" },
];

const TREND_CHARACTER_META: Record<
  TrendCharacter,
  { emoji: string; label: string; detailLabel: string }
> = {
  "lofi-girl": { emoji: "🎧", label: "Lofi Girl", detailLabel: "Lofi Girl" },
  "lofi-boy": { emoji: "🎮", label: "Lofi Boy", detailLabel: "Lofi Boy / Synthwave Boy" },
};

const TREND_LIFECYCLE_META: Record<
  TrendLifecycle,
  { emoji: string; label: string; tone: string }
> = {
  new: { emoji: "🌱", label: "Émergente", tone: "green" },
  rising: { emoji: "📈", label: "En hausse", tone: "green" },
  peaking: { emoji: "🔥", label: "Très active", tone: "amber" },
  steady: { emoji: "🌊", label: "Installée", tone: "indigo" },
  watch: { emoji: "👀", label: "À surveiller", tone: "amber" },
};

const TREND_TONE_META: Record<TrendTone, { emoji: string; label: string }> = {
  complice: { emoji: "🤝", label: "Complice" },
  cozy: { emoji: "☕", label: "Cozy" },
  absurde: { emoji: "🌀", label: "Absurde" },
};

function categoryFilters(platform: Platform) {
  return getFormatFilters(platform).filter(
    (filter) => filter.key !== "all" && filter.key !== "comment",
  );
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("fr-FR", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDate(value: string | null, withTime = false) {
  if (!value) return "Jamais";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

function formatDetailedDate(value: string | null | undefined) {
  if (!value) return "Non disponible";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatEmptyCopy(platform: Platform, filter: SocialFormatFilter) {
  if (filter === "comment") {
    if (platform === "youtube") {
      return "Aucun commentaire YouTube correspondant n’est disponible pour cette période.";
    }
    if (platform === "instagram") {
      return "Les commentaires écrits par @lofigirl nécessitent la connexion du compte professionnel Meta ou un export propriétaire.";
    }
    return "Les commentaires écrits par @lofigirl nécessitent la connexion du compte Business TikTok ou un export propriétaire.";
  }
  if (platform === "instagram") {
    return "La connexion du compte professionnel Meta est nécessaire pour récupérer cet historique sans inventer de données.";
  }
  return "Aucun contenu public classable n’a été trouvé pour ce format dans le relevé actuel.";
}

function postLabel(post: SocialPost, editorialAnalysis?: EditorialWhy | null) {
  if (post.analysis_label) return post.analysis_label;
  const signal = (editorialAnalysis ?? post.editorial_analysis)?.primarySignal;
  if (signal === "student_meme" || signal === "micro_progress") {
    return "Études & petites victoires";
  }
  if (signal === "collective_ritual" || signal === "care_ritual") {
    return "Care & communauté";
  }
  if (signal === "co_creation" || signal === "identity_choice" || signal === "absurd_poll") {
    return "Participation";
  }
  if (signal === "immersive_activation" || signal === "cultural_bridge") {
    return "Activation incarnée";
  }
  if (signal === "fourth_wall" || signal === "narrative_open_loop") {
    return "Personnage & micro-histoire";
  }
  if (signal === "commercial_copy") return "Information & activation";
  if (signal === "insufficient") return "Lecture à compléter";
  return "Relatable & humour";
}

function metricEmoji(metric: MetricKey, platform?: Platform) {
  if (metric === "views") return "📊";
  if (metric === "likes") return platform === "youtube" ? "👍" : "❤️";
  if (metric === "comments") return "💬";
  if (metric === "shares") return "↗️";
  if (metric === "saves") return "🔖";
  return "🗳️";
}

function metrics(post: SocialPost) {
  return [
    post.views !== null ? { icon: metricEmoji("views", post.platform), label: "vues", value: post.views } : null,
    post.likes !== null ? { icon: metricEmoji("likes", post.platform), label: "likes", value: post.likes } : null,
    post.comments !== null
      ? { icon: "💬", label: "commentaires", value: post.comments }
      : null,
    post.platform !== "tiktok" && post.shares !== null
      ? { icon: "↗", label: "partages", value: post.shares }
      : null,
    post.platform !== "tiktok" && post.saves !== null
      ? { icon: "🔖", label: "sauvegardes", value: post.saves }
      : null,
    post.poll_votes !== null
      ? { icon: "🗳️", label: "votes", value: post.poll_votes }
      : null,
  ].filter(Boolean) as Array<{ icon: string; label: string; value: number }>;
}

function sortPosts(posts: readonly SocialPost[], sort: PostSort) {
  if (sort === "popular") return rankPostsByPublicMetric(posts).posts;
  return [...posts].sort((left, right) => {
    const leftDate = left.published_at ? new Date(left.published_at).getTime() : Number.NaN;
    const rightDate = right.published_at ? new Date(right.published_at).getTime() : Number.NaN;
    const leftKnown = Number.isFinite(leftDate);
    const rightKnown = Number.isFinite(rightDate);
    if (leftKnown && rightKnown && rightDate !== leftDate) return rightDate - leftDate;
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    return rankPostsByPublicMetric([left, right]).posts[0] === left ? -1 : 1;
  });
}

type MetricKey = "views" | "likes" | "comments" | "shares" | "saves" | "poll_votes";

const METRIC_META: Record<MetricKey, { icon: string; label: string }> = {
  views: { icon: "📊", label: "vues" },
  likes: { icon: "❤️", label: "likes" },
  comments: { icon: "💬", label: "commentaires" },
  shares: { icon: "↗", label: "partages" },
  saves: { icon: "🔖", label: "sauvegardes" },
  poll_votes: { icon: "🗳️", label: "votes" },
};

function normalizedMetricHistory(post: SocialPost): MetricSnapshot[] {
  const fallback: MetricSnapshot = {
    captured_at: post.last_metric_at,
    views: post.views,
    likes: post.likes,
    comments: post.comments,
    shares: post.shares,
    saves: post.saves,
    poll_votes: post.poll_votes,
    source: post.source_kind || "public-history-collector",
  };
  const source = post.metric_history?.length ? post.metric_history : [fallback];
  const byPoint = new Map<string, MetricSnapshot>();
  for (const point of source) {
    if (!point?.captured_at || Number.isNaN(new Date(point.captured_at).getTime())) continue;
    const cleaned = {
      captured_at: point.captured_at,
      views: numberOrNull(point.views),
      likes: numberOrNull(point.likes),
      comments: numberOrNull(point.comments),
      shares: numberOrNull(point.shares),
      saves: numberOrNull(point.saves),
      poll_votes: numberOrNull(point.poll_votes),
      source: point.source || "public-history-collector",
    } satisfies MetricSnapshot;
    byPoint.set(`${cleaned.source}:${cleaned.captured_at}`, cleaned);
  }
  return [...byPoint.values()].sort((left, right) =>
    left.captured_at.localeCompare(right.captured_at),
  );
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function primaryTimelineMetric(post: SocialPost, history: MetricSnapshot[]): MetricKey | null {
  const preferred: MetricKey[] = ["views", "likes", "poll_votes", "comments", "shares", "saves"];
  return preferred.find((key) => post[key] !== null || history.some((point) => point[key] !== null)) ?? null;
}

function observationDelay(post: SocialPost, capturedAt: string | undefined) {
  if (!post.published_at || !capturedAt) {
    return "Impossible de relier ce relevé au lancement : la date publique exacte manque.";
  }
  if (post.published_at_precision && post.published_at_precision !== "exact") {
    return "La date de publication est approximative : ce relevé n’est pas présenté comme une mesure de lancement.";
  }
  const delayMs = new Date(capturedAt).getTime() - new Date(post.published_at).getTime();
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    return "Ce relevé n’est pas présenté comme une mesure de lancement.";
  }
  const hours = Math.round(delayMs / 3_600_000);
  if (hours <= 24) {
    return `Premier relevé ${Math.max(0, hours)} h après publication : proche du lancement, mais pas le compteur exact à H0.`;
  }
  const days = Math.max(1, Math.round(hours / 24));
  return `Premier relevé ${days} j après publication : ce n’est pas une mesure de lancement.`;
}

function isNearLaunchObservation(post: SocialPost, capturedAt: string | undefined) {
  if (!post.published_at || !capturedAt) return false;
  if (post.published_at_precision && post.published_at_precision !== "exact") return false;
  const delayMs = new Date(capturedAt).getTime() - new Date(post.published_at).getTime();
  return Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= 86_400_000;
}

function normalizedIdeaPost(post: SocialPost) {
  const raw = parsePostRaw(post.raw_json);
  if (post.poll_votes !== null) raw.pollVotes = post.poll_votes;
  return {
    platform: post.platform,
    externalId: post.external_post_id,
    url: post.url,
    title: post.title || null,
    text: post.text || null,
    format: post.format || null,
    thumbnailUrl: post.thumbnail_url,
    publishedAt: post.published_at,
    views: post.views,
    likes: post.likes,
    comments: post.comments,
    shares: post.shares,
    saves: post.saves,
    raw,
  };
}

function parsePostRaw(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  } catch {
    return {};
  }
}

function pollChoices(post: SocialPost): string[] {
  const choices = parsePostRaw(post.raw_json).pollChoices;
  return Array.isArray(choices)
    ? choices.filter((choice): choice is string => typeof choice === "string" && choice.trim().length > 0)
    : [];
}

function formatCardPublishedDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

export function SocialOS({
  initialWorkspace = null,
  initialTrendFeed = null,
  initialAudioTrendFeed = null,
  initialScrollingFeed = null,
  initialPlaylistPromoFeed = null,
  initialVideoTrendScanStatus = null,
  initialAudioTrendScanStatus = null,
  initialCommentOpportunityFeed = null,
  initialAudienceHistory = null,
  audienceAnalytics = null,
  audienceDemographics = null,
  previewMode = false,
  publicCounts,
  publicFormatCounts,
  pendingPlatforms = [],
  historyError = "",
}: {
  initialWorkspace?: WorkspacePayload | null;
  initialTrendFeed?: SocialTrendFeed | null;
  initialAudioTrendFeed?: AudioTrendFeed | null;
  initialScrollingFeed?: ScrollingFeed | null;
  initialPlaylistPromoFeed?: PlaylistPromoFeed | null;
  initialVideoTrendScanStatus?: VideoTrendScanStatus | null;
  initialAudioTrendScanStatus?: AudioTrendScanStatus | null;
  initialCommentOpportunityFeed?: CommentOpportunityFeed | null;
  initialAudienceHistory?: AudienceHistory | null;
  audienceAnalytics?: AudienceAnalytics | null;
  audienceDemographics?: AudienceDemographics | null;
  previewMode?: boolean;
  publicCounts?: Partial<Record<Platform, number>>;
  publicFormatCounts?: Partial<Record<Platform, Record<string, number>>>;
  pendingPlatforms?: Platform[];
  historyError?: string;
}) {
  const [loadedWorkspace, setLoadedWorkspace] = useState<WorkspacePayload | null>(initialWorkspace);
  const workspace = previewMode ? initialWorkspace : loadedWorkspace;
  const [trendFeed, setTrendFeed] = useState<SocialTrendFeed | null>(initialTrendFeed);
  const [trendsLoading, setTrendsLoading] = useState(!previewMode && !initialTrendFeed);
  const [trendsError, setTrendsError] = useState("");
  const [audioTrendFeed, setAudioTrendFeed] = useState<AudioTrendFeed | null>(initialAudioTrendFeed);
  const [audioTrendsLoading, setAudioTrendsLoading] = useState(!previewMode && !initialAudioTrendFeed);
  const [audioTrendsError, setAudioTrendsError] = useState("");
  const [scrollingFeed, setScrollingFeed] = useState<ScrollingFeed | null>(initialScrollingFeed);
  const [scrollingLoading, setScrollingLoading] = useState(!previewMode && !initialScrollingFeed);
  const [scrollingError, setScrollingError] = useState("");
  const [playlistPromoFeed, setPlaylistPromoFeed] = useState<PlaylistPromoFeed | null>(initialPlaylistPromoFeed);
  const [playlistPromosLoading, setPlaylistPromosLoading] = useState(!previewMode && !initialPlaylistPromoFeed);
  const [playlistPromosError, setPlaylistPromosError] = useState("");
  const [commentOpportunityFeed, setCommentOpportunityFeed] = useState<CommentOpportunityFeed | null>(initialCommentOpportunityFeed);
  const [commentsLoading, setCommentsLoading] = useState(!previewMode && !initialCommentOpportunityFeed);
  const [commentsError, setCommentsError] = useState("");
  const [view, setView] = useState<View>("overview");
  const [audiencePlatform, setAudiencePlatform] = useState<Platform>("youtube");
  const [topPlatform, setTopPlatform] = useState<Platform>("youtube");
  const [commentPlatform, setCommentPlatform] = useState<Platform | "all">("all");
  const [expandedNavSection, setExpandedNavSection] = useState<ExpandableNavView | null>(null);
  const [topFormatFilter, setTopFormatFilter] = useState<SocialFormatFilter>("short");
  const [topDuration, setTopDuration] = useState<SocialDurationFilter>("all");
  const [topSort, setTopSort] = useState<PostSort>("popular");
  const [librarySort, setLibrarySort] = useState<PostSort>("popular");
  const [loading, setLoading] = useState(!initialWorkspace);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [postPagination, setPostPagination] = useState({ key: "", count: POSTS_PAGE_SIZE });
  const [editorialWorkflow, setEditorialWorkflow] = useState<EditorialWorkflowState>(EMPTY_EDITORIAL_WORKFLOW);
  const [editorialWorkflowReady, setEditorialWorkflowReady] = useState(false);
  const [editorialWorkflowAvailable, setEditorialWorkflowAvailable] = useState(previewMode);
  const [editorialWorkflowReloadToken, setEditorialWorkflowReloadToken] = useState(0);
  const [editorialWorkflowSyncing, setEditorialWorkflowSyncing] = useState(false);
  const editorialWorkflowMutationRef = useRef(false);
  const editorialWorkflowRef = useRef<EditorialWorkflowState>(EMPTY_EDITORIAL_WORKFLOW);
  const [ideaStatusFilter, setIdeaStatusFilter] = useState<IdeaStatusFilter>("pending");
  const [activeRecommendation, setActiveRecommendation] = useState<LearnedIdea | null>(null);
  const [activeDetailsPost, setActiveDetailsPost] = useState<SocialPost | null>(null);
  const [activeInlineVideoId, setActiveInlineVideoId] = useState<string | null>(null);
  const closeActiveDetails = useCallback(() => setActiveDetailsPost(null), []);
  const closeActiveRecommendation = useCallback(() => setActiveRecommendation(null), []);
  const toggleInlineVideo = useCallback((post: SocialPost) => {
    const postId = `${post.platform}:${post.external_post_id}`;
    setActiveInlineVideoId((current) => current === postId ? null : postId);
  }, []);

  const loadWorkspace = useCallback(async () => {
    if (previewMode) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/workspace", { cache: "no-store" });
      const payload = (await response.json()) as WorkspacePayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Le radar ne répond pas.");
      setLoadedWorkspace(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Chargement impossible.");
    } finally {
      setLoading(false);
    }
  }, [previewMode]);

  useEffect(() => {
    if (previewMode || initialWorkspace) return;
    const timeout = window.setTimeout(() => {
      void loadWorkspace();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [initialWorkspace, loadWorkspace, previewMode]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setTrendFeed(initialTrendFeed);
      if (initialTrendFeed || previewMode) {
        setTrendsLoading(false);
        setTrendsError("");
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [initialTrendFeed, previewMode]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setAudioTrendFeed(initialAudioTrendFeed);
      if (initialAudioTrendFeed || previewMode) {
        setAudioTrendsLoading(false);
        setAudioTrendsError("");
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [initialAudioTrendFeed, previewMode]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setScrollingFeed(initialScrollingFeed);
      if (initialScrollingFeed || previewMode) {
        setScrollingLoading(false);
        setScrollingError("");
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [initialScrollingFeed, previewMode]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPlaylistPromoFeed(initialPlaylistPromoFeed);
      if (initialPlaylistPromoFeed || previewMode) {
        setPlaylistPromosLoading(false);
        setPlaylistPromosError("");
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [initialPlaylistPromoFeed, previewMode]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setCommentOpportunityFeed(initialCommentOpportunityFeed);
      if (initialCommentOpportunityFeed || previewMode) {
        setCommentsLoading(false);
        setCommentsError("");
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [initialCommentOpportunityFeed, previewMode]);

  useEffect(() => {
    if (previewMode) return;
    const controller = new AbortController();
    let active = true;

    const loadTrendFeed = async () => {
      setTrendsLoading(true);
      setTrendsError("");
      try {
        const response = await fetch("/api/trends", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json()) as SocialTrendFeed & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || "Les tendances ne sont pas disponibles pour le moment.");
        }
        if (active) setTrendFeed(assertSocialTrendFeed(payload));
      } catch (loadError) {
        if (!active || controller.signal.aborted) return;
        setTrendsError(
          loadError instanceof Error
            ? loadError.message
            : "Les tendances ne sont pas disponibles pour le moment.",
        );
      } finally {
        if (active) setTrendsLoading(false);
      }
    };

    void loadTrendFeed();
    return () => {
      active = false;
      controller.abort();
    };
  }, [previewMode]);

  useEffect(() => {
    if (previewMode) return;
    const controller = new AbortController();
    let active = true;

    const loadScrollingFeed = async () => {
      setScrollingLoading(true);
      setScrollingError("");
      try {
        const response = await fetch("/api/scrolling", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json()) as ScrollingFeed & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || "Les inspirations Scrolling ne sont pas disponibles pour le moment.");
        }
        if (active) setScrollingFeed(assertScrollingFeed(payload));
      } catch (loadError) {
        if (!active || controller.signal.aborted) return;
        setScrollingError(
          loadError instanceof Error
            ? loadError.message
            : "Les inspirations Scrolling ne sont pas disponibles pour le moment.",
        );
      } finally {
        if (active) setScrollingLoading(false);
      }
    };

    void loadScrollingFeed();
    return () => {
      active = false;
      controller.abort();
    };
  }, [previewMode]);

  useEffect(() => {
    if (previewMode) return;
    const controller = new AbortController();
    let active = true;

    const loadPlaylistPromoFeed = async () => {
      setPlaylistPromosLoading(true);
      setPlaylistPromosError("");
      try {
        const response = await fetch("/api/playlist-promos", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json()) as PlaylistPromoFeed & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || "Le benchmark Pubs playlists n’est pas disponible pour le moment.");
        }
        if (active) setPlaylistPromoFeed(assertPlaylistPromoFeed(payload));
      } catch (loadError) {
        if (!active || controller.signal.aborted) return;
        setPlaylistPromosError(
          loadError instanceof Error
            ? loadError.message
            : "Le benchmark Pubs playlists n’est pas disponible pour le moment.",
        );
      } finally {
        if (active) setPlaylistPromosLoading(false);
      }
    };

    void loadPlaylistPromoFeed();
    return () => {
      active = false;
      controller.abort();
    };
  }, [previewMode]);

  useEffect(() => {
    if (previewMode) return;
    const controller = new AbortController();
    let active = true;

    const loadAudioTrendFeed = async () => {
      setAudioTrendsLoading(true);
      setAudioTrendsError("");
      try {
        const response = await fetch("/api/audio-trends", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json()) as AudioTrendFeed & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || "Les trends audio ne sont pas disponibles pour le moment.");
        }
        if (active) setAudioTrendFeed(assertAudioTrendFeed(payload));
      } catch (loadError) {
        if (!active || controller.signal.aborted) return;
        setAudioTrendsError(
          loadError instanceof Error
            ? loadError.message
            : "Les trends audio ne sont pas disponibles pour le moment.",
        );
      } finally {
        if (active) setAudioTrendsLoading(false);
      }
    };

    void loadAudioTrendFeed();
    return () => {
      active = false;
      controller.abort();
    };
  }, [previewMode]);

  useEffect(() => {
    if (previewMode) return;
    const controller = new AbortController();
    let active = true;

    const loadCommentOpportunities = async () => {
      setCommentsLoading(true);
      setCommentsError("");
      try {
        const response = await fetch("/api/comment-opportunities", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json()) as CommentOpportunityFeed & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || "Les opportunités de commentaires ne sont pas disponibles pour le moment.");
        }
        if (active) setCommentOpportunityFeed(assertCommentOpportunityFeed(payload));
      } catch (loadError) {
        if (!active || controller.signal.aborted) return;
        setCommentsError(
          loadError instanceof Error
            ? loadError.message
            : "Les opportunités de commentaires ne sont pas disponibles pour le moment.",
        );
      } finally {
        if (active) setCommentsLoading(false);
      }
    };

    void loadCommentOpportunities();
    return () => {
      active = false;
      controller.abort();
    };
  }, [previewMode]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    editorialWorkflowRef.current = editorialWorkflow;
  }, [editorialWorkflow]);

  useEffect(() => {
    let cancelled = false;
    const loadEditorialWorkflow = async () => {
      if (previewMode) {
        let next = EMPTY_EDITORIAL_WORKFLOW;
        try {
          const saved = window.localStorage.getItem(EDITORIAL_WORKFLOW_STORAGE_KEY);
          if (saved) next = normalizeWorkflowState(JSON.parse(saved));
        } catch {
          // The public preview remains usable when browser storage is blocked.
        }
        if (!cancelled) {
          const merged = mergeWorkflowStates(editorialWorkflowRef.current, next);
          editorialWorkflowRef.current = merged;
          setEditorialWorkflow(merged);
          setEditorialWorkflowAvailable(true);
          setEditorialWorkflowReady(true);
        }
        return;
      }
      try {
        const response = await fetch("/api/editorial-workflow", { cache: "no-store" });
        const payload = await response.json() as EditorialWorkflowState & { error?: string };
        if (!response.ok) throw new Error(payload.error || "Le workflow éditorial ne répond pas.");
        if (!cancelled) {
          const normalized = normalizeWorkflowState(payload);
          const merged = mergeWorkflowStates(editorialWorkflowRef.current, normalized);
          editorialWorkflowRef.current = merged;
          setEditorialWorkflow(merged);
          setEditorialWorkflowAvailable(true);
          setError("");
        }
      } catch (workflowError) {
        if (!cancelled) {
          setEditorialWorkflowAvailable(false);
          setError(
            workflowError instanceof Error
              ? workflowError.message
              : "Le workflow éditorial ne répond pas.",
          );
        }
      } finally {
        if (!cancelled) setEditorialWorkflowReady(true);
      }
    };
    void loadEditorialWorkflow();
    return () => {
      cancelled = true;
    };
  }, [editorialWorkflowReloadToken, previewMode]);

  useEffect(() => {
    const handleEditorialWorkflowStorage = (event: StorageEvent) => {
      if (event.key !== EDITORIAL_WORKFLOW_STORAGE_KEY || !event.newValue) return;
      try {
        const incoming = normalizeWorkflowState(JSON.parse(event.newValue));
        const merged = mergeWorkflowStates(editorialWorkflowRef.current, incoming);
        editorialWorkflowRef.current = merged;
        setEditorialWorkflow(merged);
        setEditorialWorkflowAvailable(true);
        setEditorialWorkflowReady(true);
        setError("");
        if (JSON.stringify(merged) !== JSON.stringify(incoming)) {
          void mergeAndPersistEditorialWorkflow(merged).catch(() => {
            // The verified in-memory merge remains fail-closed if persistence fails.
          });
        }
      } catch {
        // Ignore malformed cross-tab state and keep the last verified workflow.
      }
    };
    window.addEventListener("storage", handleEditorialWorkflowStorage);
    return () => window.removeEventListener("storage", handleEditorialWorkflowStorage);
  }, []);

  const runScan = async (target?: Platform) => {
      if (previewMode) {
        if (target) {
          setTopPlatform(target);
          setTopFormatFilter(DEFAULT_FORMAT_FILTER[target]);
          setTopDuration("all");
          setView("top");
          setToast(
            `${PLATFORM_META[target].label} · ${workspace?.accounts.find((account) => account.platform === target)?.post_count ?? 0} contenus du snapshot`,
          );
        } else {
          setView("ideas");
          setToast(`Extraction recalculée sur ${workspace?.posts.length ?? 0} contenus publics`);
        }
        setMobileOpen(false);
        return;
      }
      setScanning(true);
      setError("");
      try {
        const response = await fetch("/api/scan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(target ? { platform: target } : {}),
        });
        const result = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(result.error || "Le scan a échoué.");
        await loadWorkspace();
        setToast(target ? `${PLATFORM_META[target].label} actualisé` : "Les 4 réseaux ont été rescannés");
      } catch (scanError) {
        setError(scanError instanceof Error ? scanError.message : "Le scan a échoué.");
      } finally {
        setScanning(false);
      }
  };

  const posts = useMemo(() => workspace?.posts ?? [], [workspace?.posts]);
  const authoredComments = useMemo(
    () => posts.filter((post) => isAuthoredComment(post)),
    [posts],
  );
  const publishedPosts = useMemo(
    () => posts.filter((post) => !isAuthoredComment(post)),
    [posts],
  );
  const accounts = workspace?.accounts ?? [];
  const normalizedPosts = useMemo(
    () => publishedPosts.map(normalizedIdeaPost),
    [publishedPosts],
  );
  const resolvedPlatformCounts = useMemo(() => {
    const counts = { youtube: 0, instagram: 0, tiktok: 0, x: 0 } satisfies Record<Platform, number>;
    for (const post of publishedPosts) counts[post.platform] += 1;
    for (const key of PLATFORM_ORDER) {
      const publishedCount = publicCounts?.[key];
      if (publishedCount !== undefined && pendingPlatforms.includes(key)) {
        const commentCount = publicFormatCounts?.[key]?.comment ?? 0;
        counts[key] = Math.max(0, publishedCount - commentCount);
      }
    }
    return counts;
  }, [pendingPlatforms, publishedPosts, publicCounts, publicFormatCounts]);
  const historyLoading = pendingPlatforms.length > 0;
  const loadedPlatformCount = PLATFORM_ORDER.length - pendingPlatforms.length;
  const topPlatformPending = pendingPlatforms.includes(topPlatform);
  const topPosts = useMemo(
    () => rankPostsByPublicMetric(publishedPosts).posts,
    [publishedPosts],
  );
  const topDurationReference = workspace?.generatedAt ?? "";
  const durationTopPosts = useMemo(
    () =>
      topPosts.filter((post) =>
        matchesSocialDuration(post, topDuration, topDurationReference),
      ),
    [topDuration, topDurationReference, topPosts],
  );
  const topPlatformPosts = useMemo(
    () => durationTopPosts.filter((post) => post.platform === topPlatform),
    [durationTopPosts, topPlatform],
  );
  const topCategoryPosts = useMemo(
    () =>
      topPlatformPosts.filter((post) =>
        matchesSocialFormatFilter(post, topFormatFilter),
      ),
    [topFormatFilter, topPlatformPosts],
  );
  const topFilteredPosts = useMemo(
    () => sortPosts(topCategoryPosts, topSort),
    [topCategoryPosts, topSort],
  );
  const topLifetimeFilteredPosts = useMemo(() => {
    const platformPosts = topPosts.filter(
      (post) => post.platform === topPlatform,
    );
    return platformPosts.filter((post) =>
      matchesSocialFormatFilter(post, topFormatFilter),
    );
  }, [topFormatFilter, topPlatform, topPosts]);
  const topEmptyIsDuration =
    topDuration !== "all" && topLifetimeFilteredPosts.length > 0;
  const topUndatedCount = useMemo(
    () =>
      topDuration === "all"
        ? 0
        : topPosts.filter((post) => {
            if (post.platform !== topPlatform) return false;
            if (!matchesSocialFormatFilter(post, topFormatFilter)) {
              return false;
            }
            return !hasKnownSocialPublishedDate(post);
          }).length,
    [topDuration, topFormatFilter, topPlatform, topPosts],
  );
  const allPlatformPosts = useMemo(
    () => sortPosts(durationTopPosts, librarySort),
    [durationTopPosts, librarySort],
  );
  const activeTopFormat =
    categoryFilters(topPlatform).find((filter) => filter.key === topFormatFilter) ??
    categoryFilters(topPlatform)[0];
  const ideaPlan = useMemo(
    () =>
      generateSocialIdeas(historyLoading ? [] : normalizedPosts, {
        now: workspace?.generatedAt,
        maxIdeas: 50,
        winnersPerPlatform: 8,
      }),
    [historyLoading, normalizedPosts, workspace?.generatedAt],
  );
  const learnedIdeas = useMemo(
    () => applyPreferenceLearning(ideaPlan.ideas, editorialWorkflow.feedback),
    [editorialWorkflow.feedback, ideaPlan.ideas],
  );
  const ideaRankById = useMemo(
    () => new Map(learnedIdeas.map((idea, index) => [idea.id, index + 1])),
    [learnedIdeas],
  );
  const filteredIdeas = useMemo(
    () => learnedIdeas.filter((idea) => {
      const decision = editorialWorkflow.feedback[idea.id]?.decision;
      if (ideaStatusFilter === "pending") return !decision || decision === "rework";
      if (ideaStatusFilter !== "all") return decision === ideaStatusFilter;
      return true;
    }),
    [editorialWorkflow.feedback, ideaStatusFilter, learnedIdeas],
  );
  const ideaDecisionCounts = useMemo(() => {
    const counts = { pending: 0, produce: 0, rework: 0, discard: 0 };
    for (const idea of learnedIdeas) {
      const decision = editorialWorkflow.feedback[idea.id]?.decision;
      if (decision) counts[decision] += 1;
      else counts.pending += 1;
    }
    return counts;
  }, [editorialWorkflow.feedback, learnedIdeas]);
  const visibleIdeas = filteredIdeas;
  const activeDetailsAnalysis = useMemo(() => {
    if (!activeDetailsPost) return null;
    if (activeDetailsPost.editorial_analysis) {
      return activeDetailsPost.editorial_analysis;
    }
    const key = editorialPostKey({
      platform: activeDetailsPost.platform,
      externalId: activeDetailsPost.external_post_id,
    });
    return buildEditorialAnalysisMapForTargets(normalizedPosts, [key]).get(key) ?? null;
  }, [activeDetailsPost, normalizedPosts]);
  const paginationKey = `${view}:${topDuration}:${librarySort}`;
  const visiblePostCount =
    postPagination.key === paginationKey ? postPagination.count : POSTS_PAGE_SIZE;
  const visiblePosts = allPlatformPosts.slice(0, visiblePostCount);

  const chooseTopPlatform = (target: Platform) => {
    setView("top");
    setTopPlatform(target);
    setTopFormatFilter(DEFAULT_FORMAT_FILTER[target]);
    setMobileOpen(false);
  };

  const chooseAudiencePlatform = (target: Platform) => {
    setView("overview");
    setAudiencePlatform(target);
    setMobileOpen(false);
  };

  const chooseCommentPlatform = (target: Platform | "all") => {
    setView("all-comments");
    setCommentPlatform(target);
    setMobileOpen(false);
  };

  const toggleNavSection = (section: ExpandableNavView) => {
    setExpandedNavSection((current) => current === section ? null : section);
  };

  const setIdeaDecision = useCallback(async (idea: SocialIdea, decision: IdeaDecision) => {
    if (!previewMode && editorialWorkflowMutationRef.current) {
      setToast("Une décision est déjà en cours d’enregistrement.");
      return;
    }
    if (!previewMode) {
      editorialWorkflowMutationRef.current = true;
      setEditorialWorkflowSyncing(true);
    }
    const previous = editorialWorkflow;
    const now = new Date().toISOString();
    const feedback = feedbackForIdea(idea, decision, now);
    const schedule = decision === "produce"
      ? [
          ...editorialWorkflow.schedule.filter((item) => item.ideaId !== idea.id),
          scheduleAcceptedIdea(idea, editorialWorkflow.schedule, now),
        ]
      : editorialWorkflow.schedule.filter((item) => item.ideaId !== idea.id);
    const optimistic = {
      feedback: { ...editorialWorkflow.feedback, [idea.id]: feedback },
      schedule,
    };
    editorialWorkflowRef.current = optimistic;
    setEditorialWorkflow(optimistic);
    const scheduled = schedule.find((item) => item.ideaId === idea.id);
    setToast(
      decision === "produce" && scheduled
        ? "✅ Acceptée · ajoutée à Publication comme brouillon à finaliser"
        : decision === "rework"
          ? "🛠️ Marquée à retravailler · préférence mémorisée"
          : "✕ Écartée · préférence mémorisée",
    );
    if (previewMode) {
      void mergeAndPersistEditorialWorkflow(optimistic).then((persisted) => {
        const stable = mergeWorkflowStates(editorialWorkflowRef.current, persisted);
        editorialWorkflowRef.current = stable;
        setEditorialWorkflow(stable);
      }).catch(() => {
        setToast("Décision conservée pour cette session, mais le stockage local est indisponible.");
      });
      return;
    }

    try {
      const response = await fetch("/api/editorial-workflow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "decide", idea, decision }),
      });
      const payload = await response.json() as EditorialWorkflowState & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Décision non enregistrée.");
      const normalizedPayload = normalizeWorkflowState(payload);
      const mergedPayload = mergeWorkflowStates(editorialWorkflowRef.current, normalizedPayload);
      editorialWorkflowRef.current = mergedPayload;
      setEditorialWorkflow(mergedPayload);
      setEditorialWorkflowAvailable(true);
      setError("");
      void mergeAndPersistEditorialWorkflow(mergedPayload).catch(() => {
        // The server result remains authoritative when local cross-tab sync is unavailable.
      });
    } catch (decisionError) {
      const current = editorialWorkflowRef.current;
      const currentFeedback = current.feedback[idea.id];
      const optimisticDecisionIsStillCurrent = currentFeedback?.updatedAt === feedback.updatedAt &&
        currentFeedback.decision === feedback.decision;
      const rollbackFeedback = { ...current.feedback };
      if (optimisticDecisionIsStillCurrent) {
        if (previous.feedback[idea.id]) {
          rollbackFeedback[idea.id] = previous.feedback[idea.id];
        } else {
          delete rollbackFeedback[idea.id];
        }
      }
      const rollback = optimisticDecisionIsStillCurrent
        ? normalizeWorkflowState({
            feedback: rollbackFeedback,
            schedule: [
              ...current.schedule.filter((item) => item.ideaId !== idea.id),
              ...previous.schedule.filter((item) => item.ideaId === idea.id),
            ],
          })
        : current;
      editorialWorkflowRef.current = rollback;
      setEditorialWorkflow(rollback);
      setToast(
        decisionError instanceof Error ? decisionError.message : "Décision non enregistrée.",
      );
    } finally {
      editorialWorkflowMutationRef.current = false;
      setEditorialWorkflowSyncing(false);
    }
  }, [editorialWorkflow, previewMode]);

  const activeSources = PLATFORM_ORDER.filter(
    (key) => resolvedPlatformCounts[key] > 0,
  ).length;
  const lastSuccess = accounts
    .map((account) => account.last_success_at)
    .filter(Boolean)
    .sort()
    .at(-1) as string | undefined;

  return (
    <div className="app-shell">
      <button
        className="burger"
        type="button"
        aria-label="Ouvrir le menu"
        onClick={() => setMobileOpen(true)}
      >
        ☰
      </button>
      <button
        className={`side-veil ${mobileOpen ? "show" : ""}`}
        type="button"
        aria-label="Fermer le menu"
        onClick={() => setMobileOpen(false)}
      />

      <aside className={`sidebar ${mobileOpen ? "open" : ""}`}>
        <div className="brand">
          <img className="brand-mark" src="../assets/lofi-radar-logo.jpg" alt="" aria-hidden="true" />
          <div className="brand-copy">
            <h1>
              Lofi <span>Radar</span>
            </h1>
            <small>Social · Community</small>
          </div>
        </div>

        <nav className="nav" aria-label="Navigation principale">
          {(["Pilotage"] as const).map((group) => (
            <div className="nav-group" key={group}>
              <div className="nav-label">{group}</div>
              {NAV.filter((item) => item.group === group).map((item) => {
                const isAnalyticsParent = item.id === "overview";
                const isPostsParent = item.id === "top";
                const isCommentsParent = item.id === "all-comments";
                const isRecommendationsParent = item.id === "ideas";
                const isExpandable = isExpandableNavView(item.id);
                const isExpanded = isExpandable && expandedNavSection === item.id;
                const isRecommendationsView = view === "ideas" || view === "comments" || view === "trends" || view === "audio-trends" || view === "scrolling" || view === "playlist-promos";
                const isActive = !isExpandable && view === item.id;
                const isSectionActive = isAnalyticsParent
                  ? view === "overview"
                  : isPostsParent
                    ? view === "top" || view === "all"
                    : isCommentsParent
                      ? view === "all-comments"
                      : isRecommendationsParent && isRecommendationsView;

                return (
                  <div
                    className={`nav-entry ${isExpanded ? "expanded" : ""}`}
                    key={item.id}
                  >
                    <button
                      className={isActive ? "active" : isSectionActive ? "section-active" : ""}
                      type="button"
                      aria-label={item.label}
                      title={item.label}
                      aria-current={isActive || (isSectionActive && !isExpanded) ? "page" : undefined}
                      aria-controls={isExpandableNavView(item.id) ? NAV_SUBMENU_IDS[item.id] : undefined}
                      aria-expanded={isExpandable ? isExpanded : undefined}
                      onClick={() => {
                        if (isExpandableNavView(item.id)) {
                          toggleNavSection(item.id);
                          return;
                        }

                        setView(item.id);
                        setMobileOpen(false);
                      }}
                    >
                      <span className="nav-emoji">{item.emoji}</span>
                      <span className="nav-text">{item.label}</span>
                      {isExpandable ? (
                        <span className="nav-caret" aria-hidden="true">⌄</span>
                      ) : null}
                    </button>

                    {isAnalyticsParent ? (
                      <div
                        className="nav-submenu"
                        id="analytics-platform-subnav"
                        role="group"
                        aria-label="Plateformes d’Analytics"
                        hidden={!isExpanded}
                      >
                        {PLATFORM_ORDER.map((key) => {
                          const meta = PLATFORM_META[key];
                          const isPlatformActive = view === "overview" && audiencePlatform === key;
                          return (
                            <button
                              className={isPlatformActive ? "active" : ""}
                              type="button"
                              aria-current={isPlatformActive ? "page" : undefined}
                              aria-label={meta.label}
                              title={meta.label}
                              onClick={() => chooseAudiencePlatform(key)}
                              key={key}
                            >
                              <img
                                className="nav-platform-logo"
                                src={`platforms/${key}.svg`}
                                alt=""
                                width="18"
                                height="18"
                              />
                              <span className="nav-text">{meta.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}

                    {isPostsParent ? (
                      <div
                        className="nav-submenu"
                        id="posts-platform-subnav"
                        role="group"
                        aria-label="Plateformes de Contenu"
                        hidden={!isExpanded}
                      >
                        <button
                          className={view === "all" ? "active" : ""}
                          type="button"
                          aria-current={view === "all" ? "page" : undefined}
                          onClick={() => {
                            setView("all");
                            setMobileOpen(false);
                          }}
                        >
                          <span className="nav-emoji">🌐</span>
                          <span className="nav-text">Toutes plateformes</span>
                        </button>
                        {PLATFORM_ORDER.map((key) => {
                          const meta = PLATFORM_META[key];
                          const isPlatformActive = view === "top" && topPlatform === key;
                          return (
                            <button
                              className={isPlatformActive ? "active" : ""}
                              type="button"
                              aria-current={isPlatformActive ? "page" : undefined}
                              aria-label={meta.label}
                              title={meta.label}
                              onClick={() => chooseTopPlatform(key)}
                              key={key}
                            >
                              <img
                                className="nav-platform-logo"
                                src={`platforms/${key}.svg`}
                                alt=""
                                width="18"
                                height="18"
                              />
                              <span className="nav-text">{meta.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}

                    {isCommentsParent ? (
                      <div
                        className="nav-submenu"
                        id="comments-platform-subnav"
                        role="group"
                        aria-label="Plateformes de Commentaires"
                        hidden={!isExpanded}
                      >
                        <button
                          className={view === "all-comments" && commentPlatform === "all" ? "active" : ""}
                          type="button"
                          aria-current={view === "all-comments" && commentPlatform === "all" ? "page" : undefined}
                          onClick={() => chooseCommentPlatform("all")}
                        >
                          <span className="nav-emoji">🌐</span>
                          <span className="nav-text">Toutes plateformes</span>
                        </button>
                        {PLATFORM_ORDER.map((key) => {
                          const meta = PLATFORM_META[key];
                          const isPlatformActive = view === "all-comments" && commentPlatform === key;
                          return (
                            <button
                              className={isPlatformActive ? "active" : ""}
                              type="button"
                              aria-current={isPlatformActive ? "page" : undefined}
                              aria-label={meta.label}
                              title={meta.label}
                              onClick={() => chooseCommentPlatform(key)}
                              key={key}
                            >
                              <img
                                className="nav-platform-logo"
                                src={`platforms/${key}.svg`}
                                alt=""
                                width="18"
                                height="18"
                              />
                              <span className="nav-text">{meta.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}

                    {isRecommendationsParent ? (
                      <div
                        className="nav-submenu"
                        id="recommendations-subnav"
                        role="group"
                        aria-label="Rubriques d’Extraction"
                        hidden={!isExpanded}
                      >
                        {RECOMMENDATION_NAV.map((child) => {
                          const isChildActive = view === child.id;
                          return (
                            <button
                              className={isChildActive ? "active" : ""}
                              type="button"
                              aria-current={isChildActive ? "page" : undefined}
                              aria-label={child.label}
                              title={child.label}
                              onClick={() => {
                                setView(child.id);
                                setMobileOpen(false);
                              }}
                              key={child.id}
                            >
                              <span className="nav-emoji">{child.emoji}</span>
                              <span className="nav-text">{child.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="sync-row">
            <span className={`sync-dot ${scanning ? "loading" : error ? "error" : ""}`} />
            <div>
              <b>{scanning ? "Scan en cours" : `${activeSources}/4 sources actives`}</b>
              <span>{lastSuccess ? `Dernier relevé ${formatDate(lastSuccess, true)}` : "Premier scan à lancer"}</span>
            </div>
          </div>
          <button className="refresh-button" type="button" disabled={scanning} onClick={() => void runScan()}>
            {scanning
              ? "⏳ Collecte…"
              : previewMode
                ? "💡 Recalculer les idées"
                : "↻ Scanner les réseaux"}
          </button>
        </div>
      </aside>

      <main className={`main ${view === "overview" ? "main-dashboard" : ""}`}>
        <header className="platform-header">
          <div className="radar-switch" role="navigation" aria-label="Changer de site Lofi Radar">
            <a className="youtube" href="../" aria-label="YouTube">
              <img src="platforms/youtube.svg" alt="" />
              <span className="platform-label">YouTube</span>
            </a>
            <a className="spotify" href="../spotify/?app=20260825-dashboard-v1#dashboard" aria-label="Spotify">
              <img src="platforms/spotify.svg?v=20260825-logo-v3" width="24" height="24" alt="" />
              <span className="platform-label">Spotify</span>
            </a>
            <a className="social on" href="./" aria-current="page" aria-label="Socials">
              <img src="platforms/instagram.svg" alt="" />
              <span className="platform-label">Socials</span>
            </a>
          </div>
        </header>

        {error ? (
          <div className="error-banner" role="alert">
            <span>⚠️</span>
            <div>
              <b>Le radar a rencontré un problème</b>
              <p>{error}</p>
            </div>
            <button type="button" aria-label="Fermer" onClick={() => setError("")}>×</button>
          </div>
        ) : null}

        {historyError ? (
          <div className="error-banner" role="alert">
            <span>⚠️</span>
            <div>
              <b>Les fiches détaillées ne sont pas disponibles</b>
              <p>{historyError}</p>
            </div>
          </div>
        ) : null}

        {loading && !workspace ? (
          <div className="scanner-loading">
            <div className="radar-loader">◉</div>
            <h3>Scan des comptes officiels Lofi Girl</h3>
            <p>Instagram, X, TikTok et YouTube sont interrogés et normalisés.</p>
            <div className="scan-platforms">📸 &nbsp; 𝕏 &nbsp; 🎵 &nbsp; ▶️</div>
          </div>
        ) : null}

        {workspace && view === "overview" ? (
          <AudienceDashboard
            activePlatform={audiencePlatform}
            history={initialAudienceHistory}
            analytics={audienceAnalytics}
            demographics={audienceDemographics}
            posts={workspace.posts}
          />
        ) : null}

        {view === "comments" ? (
          <CommentOpportunitiesView
            feed={commentOpportunityFeed}
            loading={commentsLoading}
            error={commentsError}
          />
        ) : null}

        {view === "trends" ? (
          <TrendFeedView
            feed={trendFeed}
            scanStatus={initialVideoTrendScanStatus}
            loading={trendsLoading}
            error={trendsError}
          />
        ) : null}

        {view === "audio-trends" ? (
          <AudioTrendFeedView
            feed={audioTrendFeed}
            scanStatus={initialAudioTrendScanStatus}
            loading={audioTrendsLoading}
            error={audioTrendsError}
          />
        ) : null}

        {view === "scrolling" ? (
          <ScrollingFeedView
            feed={scrollingFeed}
            loading={scrollingLoading}
            error={scrollingError}
          />
        ) : null}

        {view === "playlist-promos" ? (
          <PlaylistPromoFeedView
            feed={playlistPromoFeed}
            loading={playlistPromosLoading}
            error={playlistPromosError}
          />
        ) : null}

        {workspace && view === "ideas" ? (
          <div className="recommendations-view">
            <header className="recommendations-heading">
              <h2>Posts recommandés</h2>
            </header>

            <div className="reco-controlbar">
              <div className="reco-status-tabs" role="tablist" aria-label="Statut des contenus extraits">
                <button
                  className={ideaStatusFilter === "pending" || ideaStatusFilter === "rework" ? "active pending" : "pending"}
                  type="button"
                  role="tab"
                  aria-selected={ideaStatusFilter === "pending" || ideaStatusFilter === "rework"}
                  onClick={() => setIdeaStatusFilter("pending")}
                >
                  <span>🟡 À valider</span><b>{ideaDecisionCounts.pending + ideaDecisionCounts.rework}</b>
                </button>
                <button
                  className={ideaStatusFilter === "produce" ? "active validated" : "validated"}
                  type="button"
                  role="tab"
                  aria-selected={ideaStatusFilter === "produce"}
                  onClick={() => setIdeaStatusFilter("produce")}
                >
                  <span>✓ Validées</span><b>{ideaDecisionCounts.produce}</b>
                </button>
                <button
                  className={ideaStatusFilter === "discard" ? "active refused" : "refused"}
                  type="button"
                  role="tab"
                  aria-selected={ideaStatusFilter === "discard"}
                  onClick={() => setIdeaStatusFilter("discard")}
                >
                  <span>✕ Refusées</span><b>{ideaDecisionCounts.discard}</b>
                </button>
              </div>
              <button
                className="reco-refresh-button"
                type="button"
                disabled={scanning}
                onClick={() => {
                  setIdeaStatusFilter("pending");
                  void runScan();
                }}
              >
                ↻ Nouvelles idées
              </button>
            </div>

            {editorialWorkflowSyncing ? <span className="workflow-syncing">Synchronisation…</span> : null}

            {historyLoading || !editorialWorkflowReady ? (
              <HistoryLoadingState
                loadedPlatformCount={loadedPlatformCount}
                label="Génération des posts recommandés à partir de l’historique complet"
              />
            ) : visibleIdeas.length ? (
              <div className="reco-grid">
                {visibleIdeas.map((idea) => (
                  <RecommendationCard
                    idea={idea}
                    rank={ideaRankById.get(idea.id) ?? 1}
                    decision={editorialWorkflow.feedback[idea.id]?.decision}
                    disabled={editorialWorkflowSyncing}
                    onDecision={setIdeaDecision}
                    onInspect={setActiveRecommendation}
                    key={idea.id}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-state reco-empty-state">
                <span>🧭</span>
                <h3>Aucun post recommandé dans ce filtre</h3>
                <p>Affiche un autre état pour retrouver les propositions.</p>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => {
                    setIdeaStatusFilter("pending");
                  }}
                >
                  Voir les posts à valider
                </button>
              </div>
            )}
          </div>
        ) : null}

        {workspace && view === "planning" ? (
          <PlanningBoard
            schedule={editorialWorkflow.schedule}
            syncing={editorialWorkflowSyncing}
            workflowReady={editorialWorkflowReady}
            workflowAvailable={editorialWorkflowAvailable}
            onRetryWorkflow={() => {
              setEditorialWorkflowReady(false);
              setEditorialWorkflowReloadToken((token) => token + 1);
            }}
            onOpenPublication={() => setView("publication")}
          />
        ) : null}

        {workspace && view === "publication" ? (
          <PublicationWorkspace
            schedule={editorialWorkflow.schedule}
            syncing={editorialWorkflowSyncing}
            workflowReady={editorialWorkflowReady}
            workflowAvailable={editorialWorkflowAvailable}
            onRetryWorkflow={() => {
              setEditorialWorkflowReady(false);
              setEditorialWorkflowReloadToken((token) => token + 1);
            }}
            onOpenRecommendations={() => {
              setIdeaStatusFilter("pending");
              setView("ideas");
            }}
          />
        ) : null}

        {workspace && view === "top" ? (
          <div className="view-stack top-platform-view">
            <section
              className={`category-results tone-${PLATFORM_META[topPlatform].tone}`}
              aria-label={`${PLATFORM_META[topPlatform].label} · ${activeTopFormat?.label ?? topFormatFilter}`}
            >
              <header className="category-results-header category-results-toolbar">
                <div className="category-results-adjacent-filters" aria-label="Filtres de catégorie et de publication">
                  <FilterDropdown
                    id="top-format-filter"
                    label="Catégorie"
                    onChange={setTopFormatFilter}
                    options={categoryFilters(topPlatform).map((filter) => {
                      const loadedCount = topPlatformPosts.filter((post) =>
                        matchesSocialFormatFilter(post, filter.key),
                      ).length;
                      const count =
                        topPlatformPending && topDuration === "all"
                          ? publicFormatCounts?.[topPlatform]?.[filter.key] ?? loadedCount
                          : loadedCount;
                      return { ...filter, count };
                    })}
                    value={topFormatFilter}
                  />
                  <FilterDropdown
                    id="top-duration-filter"
                    label="Date de publication"
                    onChange={setTopDuration}
                    options={SOCIAL_DURATION_FILTERS}
                    value={topDuration}
                  />
                </div>

                <div className="category-results-sort-filter">
                  <FilterDropdown
                    id="top-sort-filter"
                    label="Trier"
                    onChange={setTopSort}
                    options={TOP_SORT_OPTIONS}
                    value={topSort}
                  />
                </div>
              </header>

              {topUndatedCount > 0 ? (
                <p className="top-undated-note">
                  ℹ️ {topUndatedCount} post{topUndatedCount > 1 ? "s" : ""} sans date
                  publique {topUndatedCount > 1 ? "restent" : "reste"} disponible{topUndatedCount > 1 ? "s" : ""}
                  uniquement dans All time.
                </p>
              ) : null}

              {topPlatformPending ? (
                <HistoryLoadingState
                  loadedPlatformCount={loadedPlatformCount}
                  label={`Chargement des fiches ${PLATFORM_META[topPlatform].label}`}
                />
              ) : topFilteredPosts.length ? (
                <div className="post-grid top-ranking-grid">
                  {topFilteredPosts.map((post, index) => (
                    <PostCard
                      post={post}
                      rank={index + 1}
                      compact={false}
                      isPlaying={activeInlineVideoId === `${post.platform}:${post.external_post_id}`}
                      onTogglePlayback={toggleInlineVideo}
                      onOpenDetails={setActiveDetailsPost}
                      key={post.id}
                    />
                  ))}
                </div>
              ) : (
                <div className={`format-empty-state top-ranking-empty tone-${PLATFORM_META[topPlatform].tone}`}>
                  <span>{topFormatFilter === "comment" ? "💭" : "📡"}</span>
                  <div>
                    <h3>
                      {topEmptyIsDuration
                        ? "Aucun contenu daté dans cette période"
                        : "Aucun contenu disponible pour cette catégorie"}
                    </h3>
                    <p>
                      {topEmptyIsDuration
                        ? "Essaie une date de publication plus large ou reviens à All time."
                        : formatEmptyCopy(topPlatform, topFormatFilter)}
                    </p>
                  </div>
                  <button className="button ghost compact" type="button" onClick={() => setView("sources")}>
                    Voir les limites →
                  </button>
                </div>
              )}
            </section>
          </div>
        ) : null}

        {workspace && view === "all" ? (
          <div className="view-stack all-posts-view">
            <section className="top-ranking-controls tone-all all-posts-controls" aria-label="Contrôles du contenu">
              <div className="all-posts-heading">
                <span className="section-kicker">Toutes plateformes confondues</span>
                <h2>🌐 Contenu</h2>
              </div>

              <div className="top-duration-control-row">
                <span className="section-kicker">Date de publication</span>
                <div className="format-filter-tabs top-duration-tabs" aria-label="Filtrer le contenu par date de publication">
                  {SOCIAL_DURATION_FILTERS.map((option) => (
                    <button
                      className={topDuration === option.key ? "active" : ""}
                      type="button"
                      aria-pressed={topDuration === option.key}
                      onClick={() => setTopDuration(option.key)}
                      key={option.key}
                    >
                      {option.emoji} {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="top-sort-control-row">
                <span className="section-kicker">Trier</span>
                <div className="format-filter-tabs library-sort-tabs" role="group" aria-label="Trier le contenu">
                  <button className={librarySort === "popular" ? "active" : ""} type="button" aria-pressed={librarySort === "popular"} onClick={() => setLibrarySort("popular")}>
                    🏆 Plus populaire
                  </button>
                  <button className={librarySort === "recent" ? "active" : ""} type="button" aria-pressed={librarySort === "recent"} onClick={() => setLibrarySort("recent")}>
                    🗓️ Plus récent
                  </button>
                </div>
              </div>
            </section>

            <section
              className="category-results tone-all"
              aria-labelledby="all-posts-title"
            >
              <header className="category-results-header">
                <div>
                  <span className="section-kicker">Classement global</span>
                  <h2 id="all-posts-title">🏆 YouTube · Instagram · TikTok · X</h2>
                </div>
                <span>{formatNumber(allPlatformPosts.length)} posts</span>
              </header>

              {allPlatformPosts.length ? (
                <>
                  <div className="post-grid top-ranking-grid all-platform-ranking-grid">
                    {visiblePosts.map((post, index) => (
                      <PostCard
                        post={post}
                        rank={index + 1}
                        compact
                        isPlaying={activeInlineVideoId === `${post.platform}:${post.external_post_id}`}
                        onTogglePlayback={toggleInlineVideo}
                        onOpenDetails={setActiveDetailsPost}
                        key={post.id}
                      />
                    ))}
                  </div>
                  {visiblePosts.length < allPlatformPosts.length ? (
                    <div className="progressive-pagination">
                      <span>
                        {visiblePosts.length} sur {allPlatformPosts.length} posts affichés
                      </span>
                      <button
                        className="button ghost"
                        type="button"
                        onClick={() =>
                          setPostPagination({
                            key: paginationKey,
                            count: visiblePostCount + POSTS_PAGE_SIZE,
                          })
                        }
                      >
                        Afficher {Math.min(POSTS_PAGE_SIZE, allPlatformPosts.length - visiblePosts.length)} de plus ↓
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="empty-state">
                  <span>🔎</span>
                  <h3>Aucun post disponible</h3>
                  <p>Le prochain relevé remplira ce classement toutes plateformes confondues.</p>
                  <button className="button ghost" type="button" onClick={() => setView("sources")}>
                    Voir les limites →
                  </button>
                </div>
              )}
            </section>
          </div>
        ) : null}

        {workspace && view === "all-comments" ? (
          <AuthoredCommentsView
            posts={authoredComments}
            generatedAt={workspace.generatedAt}
            platform={commentPlatform}
          />
        ) : null}

        {workspace && view === "sources" ? (
          <div className="view-stack">
            <div className="source-notice">
              <span>🛰️</span>
              <div>
                <b>Première base : signaux publics réellement visibles</b>
                <p>Le radar collecte ce que chaque réseau rend public. Les connexions propriétaires ajouteront ensuite portée, watch time, sauvegardes et rétention.</p>
              </div>
            </div>
            <div className="sources-detail-grid">
              {accounts.map((account) => {
                const meta = PLATFORM_META[account.platform];
                const history = workspace.historyCoverage?.find(
                  (item) => item.platform === account.platform,
                );
                return (
                  <article className={`source-detail-card tone-${meta.tone}`} key={account.id}>
                    <div className="source-detail-head">
                      <span className="source-logo large">{meta.emoji}</span>
                      <div>
                        <span className="section-kicker">Compte officiel vérifié</span>
                        <h3>{meta.label} · @{account.handle}</h3>
                      </div>
                      <span className={`source-state ${account.status}`}>{account.status === "error" ? "Erreur" : account.status === "limited" ? "Couverture limitée" : "Actif"}</span>
                    </div>
                    <div className="source-kpis">
                      <div><b>{formatNumber(account.follower_count)}</b><span>abonnés visibles</span></div>
                      <div><b>{account.post_count}</b><span>posts collectés</span></div>
                      <div><b>{formatDate(account.last_success_at, true)}</b><span>dernier succès</span></div>
                    </div>
                    <div className="coverage-box">
                      <span>Couverture</span>
                      <p>{account.coverage_label}</p>
                      {history?.limitations?.length ? (
                        <details className="coverage-limit-details">
                          <summary>
                            Voir les {history.limitations.length} limites de cette source
                          </summary>
                          <ul className="coverage-limit-list">
                            {history.limitations.map((limitation) => (
                              <li key={limitation}>{limitation}</li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                      {account.last_error ? <small>Dernière limite : {account.last_error}</small> : null}
                    </div>
                    <div className="source-actions">
                      <a className="button ghost compact" href={account.profile_url} target="_blank" rel="noreferrer">Voir le profil ↗</a>
                      <button className="button primary compact" type="button" disabled={scanning} onClick={() => void runScan(account.platform)}>
                        {previewMode ? `🏆 Voir le top ${meta.label}` : `↻ Scanner ${meta.label}`}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        ) : null}
      </main>

      <PostDetailsModal
        post={activeDetailsPost}
        editorialAnalysis={activeDetailsAnalysis}
        onClose={closeActiveDetails}
      />
      <RecommendationDetailsModal
        idea={activeRecommendation}
        rank={activeRecommendation ? ideaRankById.get(activeRecommendation.id) ?? 1 : null}
        onClose={closeActiveRecommendation}
      />
      {toast ? <div className="toast">✅ {toast}</div> : null}
    </div>
  );
}

function AudienceDashboard({
  activePlatform,
  history,
  analytics,
  demographics,
  posts,
}: {
  activePlatform: Platform;
  history: AudienceHistory | null;
  analytics: AudienceAnalytics | null;
  demographics: AudienceDemographics | null;
  posts: readonly SocialPost[];
}) {
  const [periodKey, setPeriodKey] = useState<AudienceChartPeriodKey>("30d");
  const [requestedMetrics, setRequestedMetrics] = useState<Record<Platform, AudienceAnalyticsMetricKey>>(
    () => ({ ...NATIVE_ANALYTICS_DEFAULT_METRIC }),
  );
  const requestedMetric = requestedMetrics[activePlatform];
  const selectMetric = (metric: AudienceAnalyticsMetricKey) => {
    setRequestedMetrics((current) => ({
      ...current,
      [activePlatform]: metric,
    }));
  };

  return (
    <section className="audience-dashboard" aria-labelledby="audience-dashboard-title">
      <div className="audience-dashboard-toolbar">
        <header className="audience-dashboard-heading">
          <div>
            <span className="section-kicker">Audience & engagement</span>
            <h2 id="audience-dashboard-title">Analytics</h2>
          </div>
        </header>
      </div>

      <AudienceAnalyticsExplorer
        activePlatform={activePlatform}
        analytics={analytics}
        demographics={demographics}
        history={history}
        onSelectMetric={selectMetric}
        onSelectPeriod={setPeriodKey}
        periodKey={periodKey}
        posts={posts}
        requestedMetric={requestedMetric}
      />
    </section>
  );
}

type NativeAnalyticsMetricMeta = {
  label: string;
  description: string;
  aggregation: "stock" | "flow" | "duration";
};

const NATIVE_ANALYTICS_METRIC_META: Record<AudienceAnalyticsMetricKey, NativeAnalyticsMetricMeta> = {
  followersTotal: {
    label: "Total followers",
    description: "Stock observé au dernier relevé natif de la période.",
    aggregation: "stock",
  },
  followersNet: {
    label: "Nouveaux followers",
    description: "Gains moins désabonnements sur la période.",
    aggregation: "flow",
  },
  contentViews: {
    label: "Vues du contenu",
    description: "Vues natives des contenus publiés.",
    aggregation: "flow",
  },
  impressions: {
    label: "Impressions",
    description: "Affichages comptabilisés par la plateforme.",
    aggregation: "flow",
  },
  reach: {
    label: "Comptes touchés",
    description: "Audience unique déclarée par la plateforme.",
    aggregation: "flow",
  },
  profileVisits: {
    label: "Visites du profil",
    description: "Visites natives du profil ou de la chaîne.",
    aggregation: "flow",
  },
  engagements: {
    label: "Engagements",
    description: "Interactions natives comptabilisées par la plateforme.",
    aggregation: "flow",
  },
  likes: {
    label: "J’aime",
    description: "Mentions J’aime observées dans les analytics natifs.",
    aggregation: "flow",
  },
  comments: {
    label: "Commentaires",
    description: "Commentaires observés dans les analytics natifs.",
    aggregation: "flow",
  },
  shares: {
    label: "Partages",
    description: "Partages observés dans les analytics natifs.",
    aggregation: "flow",
  },
  bookmarks: {
    label: "Enregistrements",
    description: "Contenus enregistrés selon la plateforme.",
    aggregation: "flow",
  },
  replies: {
    label: "Réponses",
    description: "Réponses natives aux publications.",
    aggregation: "flow",
  },
  reposts: {
    label: "Reposts",
    description: "Republications natives des contenus.",
    aggregation: "flow",
  },
  newFollowers: {
    label: "Nouveaux followers",
    description: "Nouveaux abonnements comptabilisés sur la période.",
    aggregation: "flow",
  },
  unfollows: {
    label: "Désabonnements",
    description: "Désabonnements comptabilisés sur la période.",
    aggregation: "flow",
  },
  mediaViews: {
    label: "Vues média",
    description: "Vues natives des médias lorsque la plateforme les distingue.",
    aggregation: "flow",
  },
  watchTimeSeconds: {
    label: "Temps de visionnage",
    description: "Temps de visionnage natif cumulé.",
    aggregation: "duration",
  },
  accountsEngaged: {
    label: "Comptes engagés",
    description: "Comptes uniques ayant interagi avec le contenu.",
    aggregation: "flow",
  },
  profileActivity: {
    label: "Activité du profil",
    description: "Actions réalisées sur le profil selon la plateforme.",
    aggregation: "flow",
  },
  externalLinkTaps: {
    label: "Clics lien externe",
    description: "Clics sortants depuis le profil ou le contenu.",
    aggregation: "flow",
  },
  contentPublished: {
    label: "Contenus publiés",
    description: "Nombre de contenus publiés sur la période.",
    aggregation: "flow",
  },
};

const NATIVE_ANALYTICS_PRIORITY: Record<Platform, readonly AudienceAnalyticsMetricKey[]> = {
  youtube: [
    "followersNet",
    "followersTotal",
    "contentViews",
    "watchTimeSeconds",
    "impressions",
    "engagements",
  ],
  instagram: [
    "newFollowers",
    "followersTotal",
    "reach",
    "accountsEngaged",
    "contentViews",
    "profileVisits",
    "engagements",
  ],
  tiktok: [
    "followersNet",
    "followersTotal",
    "contentViews",
    "profileVisits",
    "engagements",
  ],
  x: [
    "followersNet",
    "followersTotal",
    "impressions",
    "engagements",
    "profileVisits",
  ],
};

const NATIVE_ANALYTICS_DEFAULT_METRIC: Record<Platform, AudienceAnalyticsMetricKey> = {
  youtube: "followersNet",
  instagram: "newFollowers",
  tiktok: "followersNet",
  x: "followersNet",
};

const AUDIENCE_CHART_PERIODS = [
  { key: "30d", emoji: "📅", label: "30 jours", days: 30, snapshotKey: "30d" },
  { key: "90d", emoji: "🗓️", label: "90 jours", days: 90, snapshotKey: "90d" },
  { key: "180d", emoji: "🌗", label: "180 jours", days: 180, snapshotKey: null },
  { key: "360d", emoji: "📆", label: "360 jours", days: 360, snapshotKey: null },
  { key: "all", emoji: "♾️", label: "All time", days: null, snapshotKey: "all" },
] as const satisfies readonly {
  key: string;
  emoji: string;
  label: string;
  days: number | null;
  snapshotKey: AudienceAnalyticsPeriodKey | null;
}[];

const AUDIENCE_PLATFORM_CURVE_START_DATE: Partial<Record<Platform, string>> = {
  youtube: "2015-03-15",
};

type AudienceChartPeriodKey = (typeof AUDIENCE_CHART_PERIODS)[number]["key"];

type AudienceMetricSeriesPoint = {
  date: string;
  value: number;
  capturedAt: string;
  precision: AudienceObservation["precision"] | null;
  sourceUrl: string;
};

function readStoredEditorialWorkflow(): EditorialWorkflowState {
  try {
    const raw = window.localStorage.getItem(EDITORIAL_WORKFLOW_STORAGE_KEY);
    return raw ? normalizeWorkflowState(JSON.parse(raw)) : EMPTY_EDITORIAL_WORKFLOW;
  } catch {
    return EMPTY_EDITORIAL_WORKFLOW;
  }
}

async function mergeAndPersistEditorialWorkflow(
  incoming: EditorialWorkflowState,
): Promise<EditorialWorkflowState> {
  const persist = () => {
    const merged = mergeWorkflowStates(readStoredEditorialWorkflow(), incoming);
    window.localStorage.setItem(EDITORIAL_WORKFLOW_STORAGE_KEY, JSON.stringify(merged));
    return merged;
  };
  if (!navigator.locks) return persist();
  return navigator.locks.request(
    EDITORIAL_WORKFLOW_MUTATION_LOCK,
    { mode: "exclusive" },
    async () => persist(),
  );
}

function audienceChartPointsAreContinuous(
  previous: AudienceMetricSeriesPoint,
  current: AudienceMetricSeriesPoint,
) {
  const elapsedDays = Math.round(
    (nativeAnalyticsDateTime(current.date) - nativeAnalyticsDateTime(previous.date)) /
      (24 * 60 * 60 * 1_000),
  );
  const comparablePrecision =
    !previous.precision ||
    !current.precision ||
    previous.precision === current.precision;
  return elapsedDays === 1 && comparablePrecision;
}

function AudienceAnalyticsExplorer({
  activePlatform,
  analytics,
  demographics,
  history,
  onSelectMetric,
  onSelectPeriod,
  periodKey,
  posts,
  requestedMetric,
}: {
  activePlatform: Platform;
  analytics: AudienceAnalytics | null;
  demographics: AudienceDemographics | null;
  history: AudienceHistory | null;
  onSelectMetric: (metric: AudienceAnalyticsMetricKey) => void;
  onSelectPeriod: (period: AudienceChartPeriodKey) => void;
  periodKey: AudienceChartPeriodKey;
  posts: readonly SocialPost[];
  requestedMetric: AudienceAnalyticsMetricKey;
}) {
  if (!analytics && !history) return null;

  const chartPeriod = AUDIENCE_CHART_PERIODS.find((option) => option.key === periodKey)
    ?? AUDIENCE_CHART_PERIODS[0];
  const periodDays = chartPeriod.days;
  const periodLabel = chartPeriod.label;
  const meta = PLATFORM_META[activePlatform];
  const generatedAt = latestIsoTimestamp(analytics?.generatedAt, history?.generatedAt)
    ?? "1970-01-01T00:00:00.000Z";
  const analyticsPlatform = analytics?.platforms[activePlatform] ?? null;
  const demographicPlatform = demographics?.platforms[activePlatform] ?? null;
  const platformHistory = history?.platforms[activePlatform] ?? null;
  const latestHistory = platformHistory ? latestAudienceObservation(platformHistory) : null;
  const headlineHistory = platformHistory
    ? preferredAudienceHeadlineObservation(platformHistory)
    : null;
  const curveStartDate = AUDIENCE_PLATFORM_CURVE_START_DATE[activePlatform] ?? null;
  const allDaily = (analyticsPlatform?.daily ?? []).filter((point) => (
    curveStartDate === null || point.date >= curveStartDate
  ));
  const allHistoryPoints = audienceHistoryPointsForPeriod(
    platformHistory,
    audienceParisDay(generatedAt),
    null,
    curveStartDate,
  );
  const nativePeriodKey = chartPeriod.snapshotKey;
  const periodSnapshot = analyticsPlatform && nativePeriodKey
    ? analyticsPlatform.periods[nativePeriodKey]
    : null;
  const orderedMetrics = nativeAnalyticsMetricOrder(activePlatform);
  const metricWindows = orderedMetrics.map((metric) => {
    const metricEndDate = audienceMetricEndDate(
      metric,
      allDaily,
      allHistoryPoints,
      periodSnapshot,
      audienceParisDay(generatedAt),
    );
    const metricDaily = nativeAnalyticsDailyForPeriod(
      allDaily,
      metricEndDate,
      periodDays,
    );
    const metricHistory = audienceHistoryPointsForPeriod(
      platformHistory,
      metricEndDate,
      periodDays,
      curveStartDate,
    );
    const series = audienceMetricSeries(metric, metricDaily, metricHistory);
    const summary = metric === "followersTotal"
      ? audienceFollowersMetricSummary(series)
        ?? nativeAnalyticsMetricSummary(metric, metricDaily, periodSnapshot)
      : nativeAnalyticsMetricSummary(metric, metricDaily, periodSnapshot);
    return {
      metric,
      endDate: metricEndDate,
      series,
      summary,
    };
  });
  const availableMetricWindows = metricWindows.filter((window) => window.summary !== null);
  const summaryForMetric = (metric: AudienceAnalyticsMetricKey) => {
    const existingWindow = metricWindows.find((window) => window.metric === metric);
    if (existingWindow) return existingWindow.summary;

    const metricEndDate = audienceMetricEndDate(
      metric,
      allDaily,
      allHistoryPoints,
      periodSnapshot,
      audienceParisDay(generatedAt),
    );
    const metricDaily = nativeAnalyticsDailyForPeriod(
      allDaily,
      metricEndDate,
      periodDays,
    );
    const metricHistory = audienceHistoryPointsForPeriod(
      platformHistory,
      metricEndDate,
      periodDays,
      curveStartDate,
    );
    const series = audienceMetricSeries(metric, metricDaily, metricHistory);
    return metric === "followersTotal"
      ? audienceFollowersMetricSummary(series)
        ?? nativeAnalyticsMetricSummary(metric, metricDaily, periodSnapshot)
      : nativeAnalyticsMetricSummary(metric, metricDaily, periodSnapshot);
  };
  const firstMetricSummary = (metrics: readonly AudienceAnalyticsMetricKey[]) => {
    for (const metric of metrics) {
      const summary = summaryForMetric(metric);
      if (summary) return { metric, summary };
    }
    return null;
  };
  const activeWindow = availableMetricWindows.find((window) => window.metric === requestedMetric)
    ?? availableMetricWindows[0]
    ?? null;
  const availableMetrics = availableMetricWindows.map((window) => window.metric);
  const activeMetric = activeWindow?.metric ?? null;
  const endDate = activeWindow?.endDate ?? audienceParisDay(generatedAt);
  const activeSeries = activeWindow?.series ?? [];
  const activeSummary = activeWindow?.summary ?? null;
  const engagement = calculatePlatformEngagementWindow(
    activePlatform,
    posts,
    latestHistory,
    generatedAt,
    periodDays,
  );
  const observedFollowerPoints = audiencePointsForPeriod(
    platformHistory,
    history?.generatedAt ?? null,
    periodDays,
  );
  const observedFollowerGrowth = audienceGrowthFromObservedPoints(observedFollowerPoints);
  const followerChangeSummary = summaryForMetric("newFollowers")
    ?? summaryForMetric("followersNet");
  const followersDelta = followerChangeSummary?.value
    ?? (activePlatform === "instagram" ? null : observedFollowerGrowth?.followersDelta)
    ?? null;
  const observedGrowthDays = observedFollowerGrowth
    ? elapsedCalendarDays(
      observedFollowerGrowth.from.capturedAt,
      observedFollowerGrowth.to.capturedAt,
    )
    : null;
  const followersDeltaPeriodLabel = followerChangeSummary
    ? periodLabel
    : observedGrowthDays !== null
      ? `${observedGrowthDays} jour${observedGrowthDays > 1 ? "s" : ""} observé${observedGrowthDays > 1 ? "s" : ""}`
      : periodLabel;
  const viewsSummary = firstMetricSummary(
    activePlatform === "x"
      ? ["impressions", "contentViews", "mediaViews"]
      : ["contentViews", "impressions", "mediaViews"],
  );
  const reachSummary = summaryForMetric("reach");
  const nativeEngagementsSummary = summaryForMetric("engagements");
  const engagementComponents = (["likes", "comments", "shares"] as const)
    .map((metric) => summaryForMetric(metric))
    .filter((summary): summary is NativeAnalyticsMetricSummary => summary !== null);
  const engagementsValue = nativeEngagementsSummary?.value
    ?? (activePlatform === "tiktok" && engagementComponents.length > 0
      ? engagementComponents.reduce((total, summary) => total + summary.value, 0)
      : null);
  const engagementsBasis = nativeEngagementsSummary
    ? periodLabel
    : engagementsValue !== null
      ? `Likes + commentaires + partages · ${periodLabel}`
      : "Non fourni";

  return (
    <section
      className={`audience-explorer tone-${meta.tone}`}
      id="audience-explorer"
      aria-label={`Analytics ${meta.label}`}
    >
      <div className="audience-overview-screen">
        <div className="audience-explorer-summary" aria-label={`Synthèse ${meta.label}`}>
        <div className="audience-explorer-summary-kpi">
          <span>Total followers</span>
          <strong title={headlineHistory?.label}>
            {headlineHistory ? formatAudienceFollowers(headlineHistory) : "—"}
          </strong>
          <small>
            {headlineHistory
              ? `${headlineHistory.precision === "exact" ? "Relevé exact" : "Dernier relevé"} · ${formatAudienceDate(headlineHistory.capturedAt)}`
              : "Dernier relevé"}
          </small>
        </div>
        <div className="audience-explorer-summary-kpi">
          <span>Nouveaux followers</span>
          <strong
            className={
              followersDelta === null || followersDelta === 0
                ? undefined
                : followersDelta < 0
                  ? "negative"
                  : "positive"
            }
          >
            {followersDelta !== null ? formatAudienceDelta(followersDelta) : "—"}
          </strong>
          <small>{followersDeltaPeriodLabel}</small>
        </div>
        <div
          className="audience-explorer-summary-kpi"
          title={`Moyenne des likes et commentaires des posts mesurables sur ${periodLabel.toLowerCase()}, divisée par le nombre actuel de followers.`}
        >
          <span>Taux d’engagement</span>
          <strong>{engagement ? formatAudiencePercent(engagement.ratePercent) : "—"}</strong>
          <small>{engagement ? `${engagement.sampleSize} posts` : periodLabel}</small>
        </div>
        <div className="audience-explorer-summary-kpi">
          <span>Vues / impressions</span>
          <strong title={viewsSummary
            ? formatNativeAnalyticsMetric(viewsSummary.summary.value, viewsSummary.metric, false)
            : undefined}
          >
            {viewsSummary
              ? formatNativeAnalyticsMetric(viewsSummary.summary.value, viewsSummary.metric, true)
              : "—"}
          </strong>
          <small>
            {viewsSummary
              ? `${viewsSummary.metric === "impressions" ? "Impressions" : "Vues"} · ${periodLabel}`
              : "Non fourni"}
          </small>
        </div>
        <div className="audience-explorer-summary-kpi">
          <span>Reach</span>
          <strong title={reachSummary
            ? formatNativeAnalyticsMetric(reachSummary.value, "reach", false)
            : undefined}
          >
            {reachSummary
              ? formatNativeAnalyticsMetric(reachSummary.value, "reach", true)
              : "—"}
          </strong>
          <small>{reachSummary ? periodLabel : "Non fourni"}</small>
        </div>
        <div className="audience-explorer-summary-kpi">
          <span>Engagements</span>
          <strong title={engagementsValue !== null
            ? formatNativeAnalyticsMetric(engagementsValue, "engagements", false)
            : undefined}
          >
            {engagementsValue !== null
              ? formatNativeAnalyticsMetric(engagementsValue, "engagements", true)
              : "—"}
          </strong>
          <small>{engagementsBasis}</small>
        </div>
        </div>

        {availableMetrics.length > 0 && activeMetric && activeSummary ? (
          <>
          <div className="audience-explorer-chart-controls">
            <div
              className="audience-explorer-metrics"
              role="group"
              aria-label={`Métrique du graphique ${meta.label}`}
            >
              {availableMetricWindows.map((metricWindow) => {
                const { metric, summary } = metricWindow;
                const metricMeta = NATIVE_ANALYTICS_METRIC_META[metric];
                if (!summary) return null;
                return (
                  <button
                    className={metric === activeMetric ? "active" : ""}
                    type="button"
                    aria-pressed={metric === activeMetric}
                    title={metricMeta.description}
                    onClick={() => onSelectMetric(metric)}
                    key={metric}
                  >
                    <span>{metricMeta.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="audience-period-dropdown">
              <FilterDropdown
                id="analytics-period-filter"
                label="Période"
                value={periodKey}
                options={AUDIENCE_CHART_PERIODS}
                onChange={onSelectPeriod}
              />
            </div>
          </div>

          <div className="audience-native-chart-shell">
            <AudienceNativeMetricChart
              key={`${activePlatform}:${activeMetric}:${periodKey}:${endDate}`}
              bottomReserve={24}
              endDate={endDate}
              metric={activeMetric}
              minimumDate={curveStartDate}
              periodDays={periodDays}
              periodLabel={periodLabel}
              platformLabel={meta.label}
              points={activeSeries}
              aggregateOnly={activeSeries.length === 0 && activeSummary.basis === "period"}
            />

            <footer className="audience-native-chart-caption">
              <span>
                {periodKey === "all"
                  ? curveStartDate
                    ? `Depuis le ${formatNativeAnalyticsDate(curveStartDate)} · jours absents non reliés`
                    : "Toute la plage native importée · jours absents non reliés"
                  : "Données réelles · jours absents non reliés"}
              </span>
            </footer>
          </div>

          </>
        ) : (
          <div className="audience-native-empty" role="status">
            Aucune donnée mesurable sur {periodLabel.toLowerCase()}.
          </div>
        )}
      </div>

      {availableMetrics.length > 0 && activeMetric && activeSummary ? (
        <AudienceDemographicsPanel
          platform={activePlatform}
          snapshot={demographicPlatform}
        />
      ) : null}
    </section>
  );
}

function AudienceDemographicsPanel({
  platform,
  snapshot,
}: {
  platform: Platform;
  snapshot: AudienceDemographics["platforms"][Platform] | null;
}) {
  const meta = PLATFORM_META[platform];
  const dimensions = [snapshot?.countries, snapshot?.ages, snapshot?.genders]
    .filter((dimension): dimension is AudienceDemographicDimension => Boolean(dimension));
  const latestObservedAt = dimensions.reduce<string | null>(
    (latest, dimension) => latestIsoTimestamp(latest, dimension.provenance.collectedAt),
    null,
  );
  const countryDisplayLimit = AUDIENCE_COUNTRY_DISPLAY_LIMITS[platform];

  return (
    <section
      className="audience-demographics"
      aria-labelledby="audience-demographics-title"
    >
      <header className="audience-demographics-heading">
        <div>
          <span className="section-kicker">Démographie</span>
          <h3 id="audience-demographics-title">Audience {meta.label}</h3>
        </div>
        <span>
          {latestObservedAt
            ? `Données natives · ${formatAudienceDate(latestObservedAt)}`
            : "Donnée native non disponible"}
        </span>
      </header>

      <div className="audience-demographics-grid">
        <AudienceDemographicCard
          dimension={snapshot?.countries ?? null}
          emptyLabel={`Localisation non disponible pour ${meta.label}`}
          kind="countries"
          title={`Top ${countryDisplayLimit} pays`}
          countryDisplayLimit={countryDisplayLimit}
        />
        <div className="audience-demographics-breakdowns" role="group" aria-label="Âge et genre">
          <AudienceDemographicCard
            dimension={snapshot?.ages ?? null}
            emptyLabel={`Âge non disponible pour ${meta.label}`}
            kind="ages"
            title="Répartition par âge"
          />
          <AudienceDemographicCard
            dimension={snapshot?.genders ?? null}
            emptyLabel={`Genre non disponible pour ${meta.label}`}
            kind="genders"
            title="Répartition par genre"
          />
        </div>
      </div>
    </section>
  );
}

const AUDIENCE_COUNTRY_DISPLAY_LIMITS: Record<Platform, number> = {
  youtube: 10,
  instagram: 20,
  tiktok: 20,
  x: 20,
};

const AUDIENCE_DEMOGRAPHIC_PIE_COLORS: Record<string, string> = {
  age_13_17: "#cc79a7",
  age_18_24: "#56b4e9",
  age_25_34: "#e69f00",
  age_35_44: "#009e73",
  age_45_54: "#f0e442",
  age_55_64: "#0072b2",
  age_55_plus: "#0072b2",
  age_65_plus: "#d55e00",
  female: "#e764a8",
  male: "#56b4e9",
  user_specified: "#f0e442",
  other: "#aab2c5",
};

const AUDIENCE_DEMOGRAPHIC_PIE_FALLBACKS = [
  "#56b4e9",
  "#e69f00",
  "#009e73",
  "#f0e442",
  "#cc79a7",
  "#d55e00",
];

const AUDIENCE_DEMOGRAPHIC_PIE_RADIUS = 37.5;
const AUDIENCE_DEMOGRAPHIC_PIE_STROKE_WIDTH = 25;
const AUDIENCE_DEMOGRAPHIC_PIE_SEPARATOR_FRACTION = 0.0028;

type AudienceDemographicPieSlice = {
  key: string;
  label: string;
  share: number;
  color: string;
  start: number;
  end: number;
};

function AudienceDemographicCard({
  dimension,
  emptyLabel,
  kind,
  title,
  countryDisplayLimit = 20,
}: {
  dimension: AudienceDemographicDimension | null;
  emptyLabel: string;
  kind: "countries" | "ages" | "genders";
  title: string;
  countryDisplayLimit?: number;
}) {
  const [pieTooltip, setPieTooltip] = useState<{
    key: string;
    x: number | null;
    y: number | null;
  } | null>(null);
  const allDisplayEntries = dimension
    ? audienceDemographicDisplayEntries(dimension.entries, kind)
    : [];
  const countryEntries = kind === "countries"
    ? allDisplayEntries.filter((entry) => entry.countryCode !== null)
    : [];
  const countryAggregateFromSource = kind === "countries"
    ? allDisplayEntries.find((entry) => entry.countryCode === null) ?? null
    : null;
  const countryReportedEntries = [
    ...countryEntries,
    ...(countryAggregateFromSource ? [countryAggregateFromSource] : []),
  ];
  const countryReportedShare = countryReportedEntries.reduce(
    (total, entry) => total + (entry.share ?? 0),
    0,
  );
  const countryResidualShare = Math.max(0, Math.min(1, 1 - countryReportedShare));
  const visibleCountryEntries = countryEntries.slice(0, countryDisplayLimit);
  const hiddenCountryEntries = countryEntries.slice(countryDisplayLimit);
  const hiddenCountryShare = hiddenCountryEntries.reduce(
    (total, entry) => total + (entry.share ?? 0),
    0,
  );
  const countryAggregateShare = hiddenCountryShare
    + (countryAggregateFromSource?.share ?? 0)
    + countryResidualShare;
  const countryAggregateEntry = kind === "countries"
    && (countryAggregateFromSource || countryAggregateShare >= 0.005)
      ? {
          key: countryAggregateFromSource?.key ?? "other_countries",
          label: "Autres pays",
          share: countryAggregateShare,
          countryCode: null,
          reported: true,
        }
      : null;
  const visibleEntries = kind === "countries"
    ? countryAggregateEntry
      ? [...visibleCountryEntries, countryAggregateEntry]
      : visibleCountryEntries
    : allDisplayEntries;
  const unreportedAgeCount = kind === "ages"
    ? visibleEntries.filter((entry) => !entry.reported).length
    : 0;
  const usesMerged55Plus = kind === "ages" && visibleEntries.some((entry) => entry.key === "age_55_plus");
  const pieSlices = kind === "countries"
    ? []
    : audienceDemographicPieSlices(visibleEntries);
  const pieTooltipEntry = pieTooltip
    ? pieSlices.find((entry) => entry.key === pieTooltip.key) ?? null
    : null;
  const pieTooltipId = `audience-demographic-${kind}-tooltip`;
  const pieAriaLabel = kind === "countries"
    ? undefined
    : `${title} : ${visibleEntries.map((entry) => (
      `${entry.label} ${entry.share === null ? "non fourni" : formatAudienceDemographicShare(entry.share)}`
    )).join(", ")}`;

  return (
    <article className={`audience-demographic-card kind-${kind}`}>
      <header>
        <h4>{title}</h4>
        {dimension ? (
          <span>
            {dimension.provenance.periodLabel ?? "Snapshot actuel"}
            {kind === "countries"
              ? ` · ${visibleCountryEntries.length}/${countryDisplayLimit} pays fournis`
              : ""}
          </span>
        ) : null}
      </header>
      {dimension ? (
        <>
          {kind === "countries" ? (
            <ul className="audience-demographic-list">
              {visibleEntries.map((entry) => (
                <li key={entry.key}>
                  <img
                    src={`flags/${entry.countryCode?.toLowerCase() ?? "globe"}.svg`}
                    alt=""
                    width="20"
                    height="15"
                    aria-hidden="true"
                  />
                  <span>{entry.label}</span>
                  <span className="audience-demographic-bar" aria-hidden="true">
                    {entry.share !== null ? (
                      <span style={{ width: `${Math.max(0, Math.min(100, entry.share * 100))}%` }} />
                    ) : null}
                  </span>
                  <strong>{entry.share === null ? "—" : formatAudienceDemographicShare(entry.share)}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <div className="audience-demographic-pie-layout">
              <div
                className="audience-demographic-pie"
                role="img"
                aria-label={pieAriaLabel}
                aria-describedby={pieTooltipEntry ? pieTooltipId : undefined}
                tabIndex={pieSlices.length > 0 ? 0 : undefined}
                onFocus={() => {
                  const firstSlice = pieSlices[0];
                  if (firstSlice) setPieTooltip({ key: firstSlice.key, x: null, y: null });
                }}
                onBlur={() => setPieTooltip(null)}
                onPointerMove={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const x = event.clientX - bounds.left;
                  const y = event.clientY - bounds.top;
                  const slice = audienceDemographicPieSliceAtPoint(
                    pieSlices,
                    x,
                    y,
                    bounds.width,
                    bounds.height,
                  );
                  setPieTooltip(slice ? { key: slice.key, x, y } : null);
                }}
                onPointerLeave={() => setPieTooltip(null)}
              >
                <svg
                  className="audience-demographic-pie-svg"
                  viewBox="0 0 100 100"
                  aria-hidden="true"
                  focusable="false"
                  shapeRendering="geometricPrecision"
                >
                  <circle
                    className="audience-demographic-pie-track"
                    cx="50"
                    cy="50"
                    r={AUDIENCE_DEMOGRAPHIC_PIE_RADIUS}
                    fill="none"
                    strokeWidth={AUDIENCE_DEMOGRAPHIC_PIE_STROKE_WIDTH}
                  />
                  {pieSlices.map((slice) => {
                    const stroke = audienceDemographicPieStrokeGeometry(slice, pieSlices.length);
                    return (
                      <circle
                        className="audience-demographic-pie-slice"
                        cx="50"
                        cy="50"
                        r={AUDIENCE_DEMOGRAPHIC_PIE_RADIUS}
                        fill="none"
                        pathLength="1"
                        stroke={slice.color}
                        strokeDasharray={stroke.dashArray}
                        strokeDashoffset={stroke.dashOffset}
                        strokeLinecap="butt"
                        strokeWidth={AUDIENCE_DEMOGRAPHIC_PIE_STROKE_WIDTH}
                        transform="rotate(-90 50 50)"
                        key={slice.key}
                      />
                    );
                  })}
                </svg>
                <span className="audience-demographic-pie-label">
                  {kind === "ages" ? "Âge" : "Genre"}
                </span>
                {pieTooltipEntry ? (
                  <span
                    className="audience-demographic-pie-tooltip"
                    id={pieTooltipId}
                    role="tooltip"
                    style={pieTooltip && pieTooltip.x !== null && pieTooltip.y !== null
                      ? { left: pieTooltip.x, top: pieTooltip.y }
                      : undefined}
                  >
                    <i style={{ backgroundColor: pieTooltipEntry.color }} aria-hidden="true" />
                    <span>{pieTooltipEntry.label}</span>
                    <strong>{formatAudienceDemographicShare(pieTooltipEntry.share)}</strong>
                  </span>
                ) : null}
              </div>
              <ul className="audience-demographic-pie-legend">
                {visibleEntries.map((entry, index) => (
                  <li
                    className={entry.reported ? undefined : "unavailable"}
                    aria-label={entry.reported ? undefined : `${entry.label} : non fourni par la plateforme`}
                    aria-describedby={pieTooltipEntry?.key === entry.key ? pieTooltipId : undefined}
                    tabIndex={entry.share !== null && entry.share > 0 ? 0 : undefined}
                    onFocus={() => {
                      if (entry.share !== null && entry.share > 0) {
                        setPieTooltip({ key: entry.key, x: null, y: null });
                      }
                    }}
                    onBlur={() => setPieTooltip(null)}
                    onPointerEnter={() => {
                      if (entry.share !== null && entry.share > 0) {
                        setPieTooltip({ key: entry.key, x: null, y: null });
                      }
                    }}
                    onPointerLeave={() => setPieTooltip(null)}
                    key={entry.key}
                  >
                    <span
                      className="audience-demographic-pie-swatch"
                      style={{ backgroundColor: audienceDemographicPieColor(entry.key, index) }}
                      aria-hidden="true"
                    />
                    <span>{entry.label}</span>
                    <strong>{entry.share === null ? "—" : formatAudienceDemographicShare(entry.share)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {unreportedAgeCount > 0 || usesMerged55Plus ? (
            <p className="audience-demographic-note">
              {unreportedAgeCount > 0 ? "— = non fourni" : null}
              {unreportedAgeCount > 0 && usesMerged55Plus ? " · " : null}
              {usesMerged55Plus ? "55–64 et 65+ regroupés dans 55+" : null}
            </p>
          ) : null}
        </>
      ) : (
        <div className="audience-demographic-empty">
          {emptyLabel}
        </div>
      )}
    </article>
  );
}

function formatAudienceDemographicShare(share: number) {
  return new Intl.NumberFormat("fr-FR", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(share);
}

function audienceDemographicPieColor(key: string, index: number) {
  return AUDIENCE_DEMOGRAPHIC_PIE_COLORS[key]
    ?? AUDIENCE_DEMOGRAPHIC_PIE_FALLBACKS[index % AUDIENCE_DEMOGRAPHIC_PIE_FALLBACKS.length];
}

function audienceDemographicPieSlices(
  entries: ReadonlyArray<{ key: string; label: string; share: number | null }>,
): AudienceDemographicPieSlice[] {
  const visible = entries.flatMap((entry, index) => (
    entry.share !== null && entry.share > 0
      ? [{
          key: entry.key,
          label: entry.label,
          share: entry.share,
          color: audienceDemographicPieColor(entry.key, index),
        }]
      : []
  ));
  const total = visible.reduce((sum, entry) => sum + entry.share, 0);
  if (total <= 0) return [];

  let start = 0;
  return visible.map((entry) => {
    const end = start + entry.share / total;
    const slice = { ...entry, start, end };
    start = end;
    return slice;
  });
}

function audienceDemographicPieSliceAtPoint(
  slices: readonly AudienceDemographicPieSlice[],
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const radius = Math.min(width, height) / 2;
  const dx = x - width / 2;
  const dy = y - height / 2;
  const distance = Math.hypot(dx, dy);
  if (radius <= 0 || distance > radius || distance < radius * 0.52) return null;

  const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 450) % 360;
  const position = angle / 360;
  return slices.find((slice) => position >= slice.start && position < slice.end)
    ?? slices.at(-1)
    ?? null;
}

function audienceDemographicPieStrokeGeometry(
  slice: AudienceDemographicPieSlice,
  sliceCount: number,
) {
  const span = Math.max(0, slice.end - slice.start);
  const gap = sliceCount > 1
    ? Math.min(AUDIENCE_DEMOGRAPHIC_PIE_SEPARATOR_FRACTION, span * 0.18)
    : 0;
  const visibleSpan = Math.max(0, span - gap);
  return {
    dashArray: `${visibleSpan} ${Math.max(0, 1 - visibleSpan)}`,
    dashOffset: -(slice.start + gap / 2),
  };
}

function audienceMetricSeries(
  metric: AudienceAnalyticsMetricKey,
  daily: readonly AudienceAnalyticsDailyPoint[],
  historyPoints: readonly AudienceObservation[],
): AudienceMetricSeriesPoint[] {
  const byDate = new Map<string, AudienceMetricSeriesPoint>();
  for (const point of daily) {
    const value = point.metrics[metric];
    if (!isNativeAnalyticsValue(value)) continue;
    byDate.set(point.date, {
      date: point.date,
      value,
      capturedAt: `${point.date}T12:00:00.000Z`,
      precision: null,
      sourceUrl: point.provenance.sourceUrl,
    });
  }
  if (metric === "followersTotal") {
    for (const point of historyPoints) {
      const date = audienceParisDay(point.capturedAt);
      byDate.set(date, {
        date,
        value: point.followers,
        capturedAt: point.capturedAt,
        precision: point.precision,
        sourceUrl: point.sourceUrl,
      });
    }
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function audienceFollowersMetricSummary(
  points: readonly AudienceMetricSeriesPoint[],
): NativeAnalyticsMetricSummary | null {
  const latest = points.at(-1);
  if (!latest) return null;
  return {
    value: latest.value,
    observedCount: points.length,
    basis: "latest",
    provenance: {
      provider: "Suivi followers",
      collectedAt: latest.capturedAt,
      sourceUrl: latest.sourceUrl,
      basis: latest.precision ? `Compteur ${latest.precision}` : "Analytics officiel",
    },
  };
}

type NativeAnalyticsMetricSummary = {
  value: number;
  observedCount: number;
  basis: "period" | "daily" | "latest";
  provenance: AudienceAnalyticsPeriodSnapshot["provenance"];
};

function nativeAnalyticsMetricOrder(platform: Platform): AudienceAnalyticsMetricKey[] {
  return [...NATIVE_ANALYTICS_PRIORITY[platform]];
}

function nativeAnalyticsDailyForPeriod(
  daily: readonly AudienceAnalyticsDailyPoint[],
  endDate: string,
  periodDays: number | null,
) {
  const endTime = nativeAnalyticsDateTime(endDate);
  const minimumTime = periodDays === null
    ? Number.NEGATIVE_INFINITY
    : endTime - Math.max(0, periodDays - 1) * 24 * 60 * 60 * 1_000;
  return daily.filter((point) => {
    const time = nativeAnalyticsDateTime(point.date);
    return Number.isFinite(time) && time >= minimumTime && time <= endTime;
  });
}

function audienceHistoryPointsForPeriod(
  platformHistory: AudienceHistory["platforms"][Platform] | null,
  endDate: string,
  periodDays: number | null,
  minimumDate: string | null = null,
) {
  if (!platformHistory) return [];
  const endTime = nativeAnalyticsDateTime(endDate);
  const periodMinimumTime = periodDays === null
    ? Number.NEGATIVE_INFINITY
    : endTime - Math.max(0, periodDays - 1) * 24 * 60 * 60 * 1_000;
  const configuredMinimumTime = minimumDate === null
    ? Number.NEGATIVE_INFINITY
    : nativeAnalyticsDateTime(minimumDate);
  const minimumTime = Math.max(periodMinimumTime, configuredMinimumTime);
  return platformHistory.observations.filter((point) => {
    const time = nativeAnalyticsDateTime(audienceParisDay(point.capturedAt));
    return Number.isFinite(time) && time >= minimumTime && time <= endTime;
  });
}

function audienceMetricEndDate(
  metric: AudienceAnalyticsMetricKey,
  daily: readonly AudienceAnalyticsDailyPoint[],
  historyPoints: readonly AudienceObservation[],
  periodSnapshot: AudienceAnalyticsPeriodSnapshot | null,
  fallbackDate: string,
) {
  const dates = daily
    .filter((point) => isNativeAnalyticsValue(point.metrics[metric]))
    .map((point) => point.date);
  if (metric === "followersTotal") {
    dates.push(...historyPoints.map((point) => audienceParisDay(point.capturedAt)));
  }
  if (
    dates.length === 0 &&
    periodSnapshot &&
    isNativeAnalyticsValue(periodSnapshot.metrics[metric])
  ) {
    dates.push(periodSnapshot.endDate);
  }
  return dates.sort().at(-1) ?? fallbackDate;
}

function nativeAnalyticsMetricSummary(
  metric: AudienceAnalyticsMetricKey,
  daily: readonly AudienceAnalyticsDailyPoint[],
  periodSnapshot: AudienceAnalyticsPeriodSnapshot | null,
): NativeAnalyticsMetricSummary | null {
  const periodValue = periodSnapshot?.metrics[metric];
  if (periodSnapshot && typeof periodValue === "number" && Number.isFinite(periodValue)) {
    return {
      value: periodValue,
      observedCount: daily.filter((point) => isNativeAnalyticsValue(point.metrics[metric])).length,
      basis: NATIVE_ANALYTICS_METRIC_META[metric].aggregation === "stock" ? "latest" : "period",
      provenance: periodSnapshot.provenance,
    };
  }

  const observed = daily.filter((point) => isNativeAnalyticsValue(point.metrics[metric]));
  if (observed.length === 0) return null;
  if (NATIVE_ANALYTICS_METRIC_META[metric].aggregation === "stock") {
    const latest = observed.at(-1)!;
    return {
      value: latest.metrics[metric]!,
      observedCount: observed.length,
      basis: "latest",
      provenance: latest.provenance,
    };
  }
  return {
    value: observed.reduce((total, point) => total + point.metrics[metric]!, 0),
    observedCount: observed.length,
    basis: "daily",
    provenance: observed.at(-1)!.provenance,
  };
}

function AudienceNativeMetricChart({
  aggregateOnly,
  bottomReserve,
  endDate,
  metric,
  minimumDate,
  periodDays,
  periodLabel,
  platformLabel,
  points,
}: {
  aggregateOnly: boolean;
  bottomReserve: number;
  endDate: string;
  metric: AudienceAnalyticsMetricKey;
  minimumDate: string | null;
  periodDays: number | null;
  periodLabel: string;
  platformLabel: string;
  points: readonly AudienceMetricSeriesPoint[];
}) {
  const chartViewportRef = useRef<HTMLDivElement>(null);
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);
  const [chartDimensions, setChartDimensions] = useState({ width: 940, height: 180 });
  const metricLabel = NATIVE_ANALYTICS_METRIC_META[metric].label;

  useEffect(() => {
    const viewport = chartViewportRef.current;
    if (!viewport) return;

    const resizeChart = () => {
      const width = Math.max(700, Math.round(viewport.clientWidth));
      const availableHeight = Math.floor(
        window.innerHeight - viewport.getBoundingClientRect().top - bottomReserve - 34,
      );
      const height = window.innerWidth <= 900
        ? 180
        : Math.max(180, Math.min(Math.round(window.innerHeight * 0.72), availableHeight));
      setChartDimensions((current) => (
        current.width === width && current.height === height
          ? current
          : { width, height }
      ));
    };

    resizeChart();
    const resizeObserver = new ResizeObserver(resizeChart);
    resizeObserver.observe(viewport);
    window.addEventListener("resize", resizeChart);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", resizeChart);
    };
  }, [bottomReserve]);

  const geometry = useMemo(() => {
    const { width, height } = chartDimensions;
    const plotLeft = 24;
    const plotRight = width - 82;
    const plotTop = 12;
    const plotBottom = height - 40;
    if (points.length === 0) return null;

    const observedTimes = points.map((point) => nativeAnalyticsDateTime(point.date));
    const observedValues = points.map((point) => point.value);
    const requestedEndTime = nativeAnalyticsDateTime(endDate);
    const minimumTime = minimumDate === null
      ? Number.NEGATIVE_INFINITY
      : nativeAnalyticsDateTime(minimumDate);
    const requestedStartTime = periodDays === null
      ? Number.isFinite(minimumTime) ? minimumTime : observedTimes[0]
      : requestedEndTime - Math.max(0, periodDays - 1) * 24 * 60 * 60 * 1_000;
    const firstTime = Math.max(minimumTime, Math.min(requestedStartTime, observedTimes[0]));
    const lastTime = Math.max(requestedEndTime, observedTimes.at(-1)!);
    const timeSpan = Math.max(lastTime - firstTime, 1);
    const rawMinimum = Math.min(...observedValues);
    const rawMaximum = Math.max(...observedValues);
    const signed = metric === "followersNet" || rawMinimum < 0;
    const domainMinimum = signed ? Math.min(0, rawMinimum) : rawMinimum;
    const domainMaximum = signed ? Math.max(0, rawMaximum) : rawMaximum;
    const rawSpan = domainMaximum - domainMinimum;
    const padding = rawSpan === 0
      ? Math.max(1, Math.abs(domainMaximum) * 0.08)
      : rawSpan * 0.12;
    const paddedMinimum = signed ? domainMinimum - padding : Math.max(0, domainMinimum - padding);
    const paddedMaximum = domainMaximum + padding;
    const maximumAbsoluteValue = Math.max(Math.abs(paddedMinimum), Math.abs(paddedMaximum));
    const axisUnit = metric === "watchTimeSeconds"
      ? maximumAbsoluteValue >= 3_600
        ? 3_600
        : 60
      : 1;
    const axis = buildAudienceChartAxis(paddedMinimum, paddedMaximum, {
      targetIntervals: 4,
      unit: axisUnit,
      minimumStep: 1,
    });
    const minimum = axis.minimum;
    const maximum = axis.maximum;
    const valueSpan = Math.max(maximum - minimum, 1);
    const x = (timestamp: number) =>
      plotLeft + ((timestamp - firstTime) / timeSpan) * (plotRight - plotLeft);
    const y = (value: number) =>
      plotBottom - ((value - minimum) / valueSpan) * (plotBottom - plotTop);
    const coordinates = points.map((point, index) => ({
      point,
      value: point.value,
      time: observedTimes[index],
      x: x(observedTimes[index]),
      y: y(point.value),
    }));
    const pointMarkers = metric === "followersTotal"
      ? coordinates.filter((coordinate, index) => {
        const previous = coordinates[index - 1];
        const next = coordinates[index + 1];
        const continuesFromPrevious = previous
          ? audienceChartPointsAreContinuous(previous.point, coordinate.point)
          : false;
        const continuesToNext = next
          ? audienceChartPointsAreContinuous(coordinate.point, next.point)
          : false;
        return !continuesFromPrevious || !continuesToNext;
      })
      : [];
    const paths: string[] = [];
    let activePath = "";
    coordinates.forEach((coordinate, index) => {
      const previous = coordinates[index - 1];
      const move = `M ${coordinate.x.toFixed(2)} ${coordinate.y.toFixed(2)}`;
      if (!previous) {
        activePath = move;
        return;
      }
      if (audienceChartPointsAreContinuous(previous.point, coordinate.point)) {
        activePath += ` L ${coordinate.x.toFixed(2)} ${coordinate.y.toFixed(2)}`;
        return;
      }
      if (activePath.includes(" L ")) paths.push(activePath);
      activePath = move;
    });
    if (activePath.includes(" L ")) paths.push(activePath);
    const gridLines = axis.ticks.map((value) => ({ value, y: y(value) }));
    const tickCount = periodDays === null && timeSpan > 500 * 24 * 60 * 60 * 1_000 ? 4 : 5;
    const dateTicks = Array.from({ length: tickCount }, (_, index) => {
      const ratio = index / (tickCount - 1);
      const timestamp = firstTime + ratio * timeSpan;
      return { timestamp, x: plotLeft + ratio * (plotRight - plotLeft) };
    });
    const zeroY = minimum <= 0 && maximum >= 0 ? y(0) : null;
    return {
      axisStep: axis.step,
      coordinates,
      dateTicks,
      gridLines,
      height,
      paths,
      plotBottom,
      plotLeft,
      plotRight,
      plotTop,
      pointMarkers,
      timeSpan,
      width,
      zeroY,
    };
  }, [chartDimensions, endDate, metric, minimumDate, periodDays, points]);

  if (!geometry) {
    return (
      <div className="audience-native-chart-empty" role="status">
        <strong>{aggregateOnly ? `Agrégat officiel · ${periodLabel}` : "Série quotidienne indisponible"}</strong>
        <span>
          {aggregateOnly
            ? `La plateforme ne fournit pas de courbe quotidienne exportable pour ${metricLabel.toLowerCase()}.`
            : `Aucune valeur quotidienne réelle pour ${metricLabel.toLowerCase()} sur cette période.`}
        </span>
      </div>
    );
  }

  const {
    axisStep,
    coordinates,
    dateTicks,
    gridLines,
    height,
    paths,
    plotBottom,
    plotLeft,
    plotRight,
    plotTop,
    pointMarkers,
    timeSpan,
    width,
    zeroY,
  } = geometry;
  const hoveredCoordinate = hoveredPointIndex === null
    ? null
    : coordinates[hoveredPointIndex] ?? null;
  const tooltipWidth = 132;
  const tooltipHeight = 40;
  const tooltipX = hoveredCoordinate
    ? Math.min(plotRight - tooltipWidth, Math.max(plotLeft, hoveredCoordinate.x - tooltipWidth / 2))
    : 0;
  const tooltipY = hoveredCoordinate
    ? hoveredCoordinate.y - tooltipHeight - 9 >= 2
      ? hoveredCoordinate.y - tooltipHeight - 9
      : hoveredCoordinate.y + 9
    : 0;

  return (
    <div className="audience-native-line-chart">
      <div className="audience-native-chart-viewport" ref={chartViewportRef}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{ height: `${height}px` }}
          role="img"
          aria-label={`${metricLabel} par jour · ${platformLabel}`}
          tabIndex={0}
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const pointerX = ((event.clientX - bounds.left) / bounds.width) * width;
            if (pointerX < plotLeft || pointerX > plotRight) {
              setHoveredPointIndex(null);
              return;
            }
            let low = 0;
            let high = coordinates.length - 1;
            while (low < high) {
              const middle = Math.floor((low + high) / 2);
              if (coordinates[middle].x < pointerX) low = middle + 1;
              else high = middle;
            }
            const rightIndex = low;
            const leftIndex = Math.max(0, rightIndex - 1);
            const closestIndex =
              Math.abs(coordinates[leftIndex].x - pointerX) <=
              Math.abs(coordinates[rightIndex].x - pointerX)
                ? leftIndex
                : rightIndex;
            setHoveredPointIndex((current) => current === closestIndex ? current : closestIndex);
          }}
          onPointerLeave={() => setHoveredPointIndex(null)}
          onBlur={() => setHoveredPointIndex(null)}
        >
          <desc>
            {`${points.length} valeurs réelles sur ${periodLabel.toLowerCase()}. Les dates absentes et les valeurs nulles ne sont ni reliées ni interpolées.`}
          </desc>
          <rect
            className="audience-native-chart-hit-area"
            x={plotLeft}
            y={plotTop}
            width={plotRight - plotLeft}
            height={plotBottom - plotTop}
          />
          {gridLines.map((line) => (
            <g className="audience-native-chart-grid" key={line.y}>
              <line x1={plotLeft} x2={plotRight} y1={line.y} y2={line.y} />
              <text x={plotRight + 14} y={line.y + 4}>
                {formatAudienceAxisTick(line.value, metric, axisStep)}
              </text>
            </g>
          ))}
          {zeroY !== null ? (
            <line
              className="audience-native-chart-zero"
              x1={plotLeft}
              x2={plotRight}
              y1={zeroY}
              y2={zeroY}
            />
          ) : null}
          {paths.map((path, index) => (
            <path
              className="audience-native-chart-line"
              d={path}
              key={`${index}:${path.slice(0, 32)}`}
            />
          ))}
          {pointMarkers.map((coordinate) => (
            <circle
              aria-hidden="true"
              className="audience-native-chart-observation"
              cx={coordinate.x}
              cy={coordinate.y}
              key={`${coordinate.point.date}:${coordinate.value}`}
              r="3"
            />
          ))}
          {hoveredCoordinate ? (
            <g className="audience-native-chart-hover">
              <line
                className="audience-native-chart-hover-guide"
                x1={hoveredCoordinate.x}
                x2={hoveredCoordinate.x}
                y1={plotTop}
                y2={plotBottom}
              />
              <circle cx={hoveredCoordinate.x} cy={hoveredCoordinate.y} r="3" />
              <g
                className="audience-native-chart-tooltip"
                role="tooltip"
                transform={`translate(${tooltipX} ${tooltipY})`}
              >
                <rect width={tooltipWidth} height={tooltipHeight} rx="7" />
                <text className="audience-native-chart-tooltip-date" x="10" y="15">
                  {formatNativeAnalyticsDate(hoveredCoordinate.point.date)}
                </text>
                <text className="audience-native-chart-tooltip-value" x="10" y="31">
                  {formatAudienceSeriesValue(hoveredCoordinate.point, metric, false)}
                </text>
              </g>
            </g>
          ) : null}
          {dateTicks.map((tick, index) => (
            <text
              className="audience-native-chart-date"
              key={tick.timestamp}
              x={tick.x}
              y={height - 10}
              textAnchor={index === 0 ? "start" : index === dateTicks.length - 1 ? "end" : "middle"}
            >
              {formatAudienceChartDate(
                new Date(tick.timestamp).toISOString(),
                timeSpan > 500 * 24 * 60 * 60 * 1_000,
              )}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

function isNativeAnalyticsValue(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nativeAnalyticsDateTime(date: string) {
  return Date.parse(`${date}T12:00:00.000Z`);
}

function formatNativeAnalyticsDate(date: string) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00.000Z`)).replace(".", "");
}

function formatNativeAnalyticsMetric(
  value: number,
  metric: AudienceAnalyticsMetricKey,
  compact: boolean,
) {
  if (
    metric === "followersTotal" ||
    metric === "followersNet" ||
    metric === "newFollowers" ||
    metric === "unfollows"
  ) {
    const formattedFollowers = new Intl.NumberFormat("fr-FR", {
      maximumFractionDigits: 0,
    }).format(Math.round(Math.abs(value)));
    if (metric === "followersNet" || metric === "newFollowers") {
      return `${value >= 0 ? "+" : "−"}${formattedFollowers}`;
    }
    return value < 0 ? `−${formattedFollowers}` : formattedFollowers;
  }
  if (metric === "watchTimeSeconds") {
    const hours = value / 3_600;
    if (Math.abs(hours) >= 1) {
      return `${new Intl.NumberFormat("fr-FR", {
        notation: compact && Math.abs(hours) >= 10_000 ? "compact" : "standard",
        maximumFractionDigits: hours < 10 ? 1 : 0,
      }).format(hours)} h`;
    }
    return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value / 60)} min`;
  }
  const formatted = new Intl.NumberFormat("fr-FR", {
    notation: compact && Math.abs(value) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 0,
  }).format(Math.abs(value));
  return value < 0 ? `−${formatted}` : formatted;
}

function formatAudienceAxisTick(
  value: number,
  metric: AudienceAnalyticsMetricKey,
  step: number,
) {
  const normalizedValue = Object.is(Math.round(value), -0) ? 0 : Math.round(value);
  if (metric === "watchTimeSeconds") {
    const divisor = Math.max(Math.abs(value), Math.abs(step)) >= 3_600 ? 3_600 : 60;
    const unit = divisor === 3_600 ? "h" : "min";
    const unitValue = value / divisor;
    const unitStep = Math.abs(step / divisor);
    const maximumFractionDigits = unitStep >= 1 ? 0 : unitStep >= 0.1 ? 1 : 2;
    return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits }).format(unitValue)} ${unit}`;
  }

  const absolute = Math.abs(normalizedValue);
  const isFollowerMetric =
    metric === "followersTotal" ||
    metric === "followersNet" ||
    metric === "newFollowers" ||
    metric === "unfollows";
  let formatted: string;
  if (isFollowerMetric || absolute < 10_000) {
    formatted = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(absolute);
  } else {
    const divisor = absolute >= 1_000_000 ? 1_000_000 : 1_000;
    const normalizedStep = Math.abs(step) / divisor;
    const maximumFractionDigits = normalizedStep >= 1 ? 0 : normalizedStep >= 0.1 ? 1 : 2;
    formatted = new Intl.NumberFormat("fr-FR", {
      notation: "compact",
      maximumFractionDigits,
    }).format(absolute);
  }

  if (normalizedValue === 0) return "0";
  if (normalizedValue < 0) return `−${formatted}`;
  return metric === "followersNet" || metric === "newFollowers" ? `+${formatted}` : formatted;
}


function audiencePointsForPeriod(
  platformHistory: AudienceHistory["platforms"][Platform] | null,
  periodEndAt: string | null,
  days: number | null,
) {
  if (!platformHistory || !periodEndAt) return [];
  const periodEndTime = Date.parse(periodEndAt);
  if (!Number.isFinite(periodEndTime)) return [];
  const minimumTime = days === null
    ? Number.NEGATIVE_INFINITY
    : periodEndTime - Math.max(0, days - 1) * 24 * 60 * 60 * 1_000;
  return platformHistory.observations.filter((observation) => {
    const capturedTime = Date.parse(observation.capturedAt);
    return capturedTime >= minimumTime && capturedTime <= periodEndTime;
  });
}

function audienceGrowthFromObservedPoints(points: AudienceObservation[]) {
  const exactPoints = points.filter((point) => point.precision === "exact");
  if (exactPoints.length < 2) return null;
  const from = exactPoints[0];
  const to = exactPoints.at(-1)!;
  const followersDelta = to.followers - from.followers;
  return {
    from,
    to,
    followersDelta,
    ratePercent: (followersDelta / from.followers) * 100,
  };
}

function latestIsoTimestamp(left: string | null | undefined, right: string | null | undefined) {
  if (!left) return right ?? null;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function elapsedCalendarDays(from: string, to: string) {
  const fromDay = audienceParisDay(from);
  const toDay = audienceParisDay(to);
  return Math.max(0, Math.round((Date.parse(`${toDay}T12:00:00Z`) - Date.parse(`${fromDay}T12:00:00Z`)) / (24 * 60 * 60 * 1_000)));
}

function audienceParisDay(value: string) {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function formatAudienceSeriesValue(
  point: AudienceMetricSeriesPoint,
  metric: AudienceAnalyticsMetricKey,
  compact: boolean,
) {
  const value = formatNativeAnalyticsMetric(point.value, metric, compact);
  return metric === "followersTotal" && point.precision && point.precision !== "exact"
    ? `≈ ${value}`
    : value;
}

function formatAudienceChartDate(value: string, yearOnly: boolean) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("fr-FR", yearOnly
    ? { timeZone: "Europe/Paris", month: "short", year: "2-digit" }
    : { timeZone: "Europe/Paris", day: "2-digit", month: "short" }
  ).format(date).replace(".", "");
}

function formatAudienceFollowers(observation: AudienceObservation) {
  if (observation.precision === "exact") {
    return new Intl.NumberFormat("fr-FR").format(observation.followers);
  }
  return `≈ ${new Intl.NumberFormat("fr-FR", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(observation.followers)}`;
}

function formatAudienceDelta(value: number) {
  const formatted = new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: 0,
  }).format(Math.round(Math.abs(value)));
  return `${value >= 0 ? "+" : "−"}${formatted}`;
}

function formatAudiencePercent(value: number) {
  return new Intl.NumberFormat("fr-FR", {
    style: "percent",
    minimumFractionDigits: value < 0.1 ? 2 : 1,
    maximumFractionDigits: value < 0.1 ? 2 : 1,
  }).format(value / 100);
}

function formatAudienceDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function TrendFeedView({
  feed,
  scanStatus,
  loading,
  error,
}: {
  feed: SocialTrendFeed | null;
  scanStatus: VideoTrendScanStatus | null;
  loading: boolean;
  error: string;
}) {
  const [platformFilter, setPlatformFilter] = useState<TrendPlatformFilter>("all");
  const [activeTrend, setActiveTrend] = useState<SocialTrend | null>(null);
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);
  const actionableTrends = useMemo(
    () => (feed?.trends ?? []).filter(
      (trend) => isActionableSocialTrend(trend) && trend.referencePost?.mediaType === "video",
    ),
    [feed?.trends],
  );
  const selectedVideoTrends = useMemo(
    () => selectGirlFirstSocialTrends(
      actionableTrends.filter((trend) => trend.referencePost?.mediaType === "video"),
      50,
    ),
    [actionableTrends],
  );
  const matchedTrendIds = useMemo(
    () => new Set(scanStatus?.discoveryAudit.matchedTrendIds ?? []),
    [scanStatus?.discoveryAudit.matchedTrendIds],
  );
  const orderedVideoTrends = useMemo(
    () => [
      ...selectedVideoTrends.filter((trend) => matchedTrendIds.has(trend.id)),
      ...selectedVideoTrends.filter((trend) => !matchedTrendIds.has(trend.id)),
    ],
    [matchedTrendIds, selectedVideoTrends],
  );
  const visibleTrends = useMemo(
    () => {
      if (platformFilter === "all") {
        return orderedVideoTrends;
      }
      const filtered = filterSocialTrends(selectedVideoTrends, {
        platform: platformFilter,
      });
      return [
        ...filtered.filter((trend) => matchedTrendIds.has(trend.id)),
        ...filtered.filter((trend) => !matchedTrendIds.has(trend.id)),
      ];
    },
    [matchedTrendIds, orderedVideoTrends, platformFilter, selectedVideoTrends],
  );
  return (
    <div className="trend-feed-view">
      <header className="trend-feed-heading">
        <h2>Trends vidéos</h2>
      </header>

      <div className="trend-feed-controls" aria-label="Filtres des tendances">
        <div className="trend-filter-group">
          <span>Plateforme</span>
          <div className="trend-filter-tabs" role="group" aria-label="Filtrer par plateforme">
            {TREND_PLATFORM_FILTERS.map((option) => (
              <button
                className={platformFilter === option.key ? "active" : ""}
                type="button"
                aria-pressed={platformFilter === option.key}
                onClick={() => {
                  setActivePlayerId(null);
                  setPlatformFilter(option.key);
                }}
                key={option.key}
              >
                {option.emoji} {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error ? (
        <div className="trend-feed-notice" role="status">
          <span aria-hidden="true">⚠️</span>
          <p>
            {feed
              ? "La dernière mise à jour n’a pas pu être chargée. Le snapshot ci-dessous reste disponible."
              : error}
          </p>
        </div>
      ) : null}

      {loading && !feed ? (
        <div className="trend-feed-loading" role="status">
          <span aria-hidden="true">⏳</span>
          <div>
            <b>Préparation du snapshot Trends vidéos</b>
            <p>Les signaux et leurs sources sont en cours de chargement.</p>
          </div>
        </div>
      ) : feed && visibleTrends.length ? (
        <div className="post-grid top-ranking-grid trend-shorts-grid">
          {visibleTrends.map((trend, index) => (
            <TrendFeedCard
              trend={trend}
              rank={index + 1}
              onOpenDetails={(selectedTrend) => {
                setActivePlayerId(null);
                setActiveTrend(selectedTrend);
              }}
              playerActive={activePlayerId === trend.id}
              onActivatePlayer={() => setActivePlayerId(trend.id)}
              onClosePlayer={() => setActivePlayerId(null)}
              feedCapturedAt={feed.capturedAt}
              key={`${trend.id}:${feed.capturedAt.slice(0, 10)}`}
            />
          ))}
        </div>
      ) : feed ? (
        <div className="empty-state trend-feed-empty">
          <span>🧭</span>
          <h3>Aucune tendance dans ce filtre</h3>
          <p>Essaie un autre univers ou affiche toutes les plateformes.</p>
          <button
            className="button secondary"
            type="button"
            onClick={() => {
              setActivePlayerId(null);
              setPlatformFilter("all");
            }}
          >
            Voir toutes les tendances
          </button>
        </div>
      ) : null}

      <TrendDetailsModal
        trend={activeTrend}
        onClose={() => setActiveTrend(null)}
        key={activeTrend?.id ?? "closed-trend-details"}
      />
    </div>
  );
}

function TrendFeedCard({
  trend,
  rank,
  onOpenDetails,
  playerActive,
  onActivatePlayer,
  onClosePlayer,
  feedCapturedAt,
}: {
  trend: SocialTrend;
  rank: number;
  onOpenDetails: (trend: SocialTrend) => void;
  playerActive: boolean;
  onActivatePlayer: () => void;
  onClosePlayer: () => void;
  feedCapturedAt: string;
}) {
  const lifecycle = TREND_LIFECYCLE_META[trend.lifecycle];
  const referencePost = trend.referencePost;
  const [activeProposalIndex, setActiveProposalIndex] = useState(() =>
    dailyRotationIndex(trend.id, feedCapturedAt, trend.proposals.length),
  );
  if (!referencePost) return null;
  const publishedDate = formatCardPublishedDate(referencePost.publishedAt);
  const footerMetrics = trendReferenceFooterMetrics(referencePost);
  const activeProposal = trend.proposals[activeProposalIndex] ?? trend.proposals[0];

  return (
    <article className={`social-post-card trend-reference-card has-media tone-${lifecycle.tone}`}>
      <TrendReferenceMedia
        trend={trend}
        rank={rank}
        active={playerActive}
        onActivate={onActivatePlayer}
        onClose={onClosePlayer}
      />
      <div className="post-card-body trend-card-body">
        <div className="trend-card-meta-line">
          <span>
            {trendPlatformEmoji(referencePost.platform)} {referencePost.author ?? trendPlatformLabel(referencePost.platform)}
          </span>
        </div>
        <div className="post-card-title">
          <div className="post-media-caption">
            <span className="trend-card-source-title">{trend.title}</span>
            <h3>{activeProposal?.concept ?? trend.whyLofi}</h3>
          </div>
        </div>
        <div className="trend-proposal-tabs" role="group" aria-label={`Choisir une proposition pour ${trend.title}`}>
          {trend.proposals.map((proposal, index) => (
            <button
              className={activeProposalIndex === index ? "active" : ""}
              type="button"
              aria-pressed={activeProposalIndex === index}
              onClick={() => setActiveProposalIndex(index)}
              key={`${proposal.tone}:${index}`}
            >
              {proposal.label}
            </button>
          ))}
        </div>
        <footer>
          {publishedDate ? (
            <time className="post-published-date" dateTime={referencePost.publishedAt ?? undefined}>
              {publishedDate}
            </time>
          ) : <span />}
          <span className="post-card-footer-metrics" aria-label="Performances visibles">
            {footerMetrics.map((metric) => (
              <span key={metric.label} title={metric.label}>
                {metric.icon} <b>{formatNumber(metric.value)}</b>
              </span>
            ))}
          </span>
          <span className="post-card-actions">
            <button type="button" onClick={() => onOpenDetails(trend)}>
              Plus d’informations
            </button>
          </span>
        </footer>
      </div>
    </article>
  );
}

function TrendReferenceMedia({
  trend,
  rank,
  active,
  onActivate,
  onClose,
}: {
  trend: SocialTrend;
  rank: number;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const referencePost = trend.referencePost;
  const tiktokExternalId = referencePost?.platform === "tiktok"
    ? referencePost.url.match(/\/video\/(\d{12,24})/i)?.[1] ?? null
    : null;
  const tiktokOEmbedUrl = referencePost?.platform === "tiktok"
    ? `https://www.tiktok.com/oembed?url=${encodeURIComponent(referencePost.url)}`
    : null;
  const cachedTikTokThumbnail = tiktokExternalId
    ? getCachedTikTokThumbnail(tiktokExternalId)
    : null;
  const [thumbnail, setThumbnail] = useState<string | null>(
    referencePost?.thumbnailUrl ?? cachedTikTokThumbnail,
  );

  useEffect(() => {
    if (
      referencePost?.platform !== "tiktok" ||
      !tiktokExternalId ||
      !tiktokOEmbedUrl ||
      thumbnail
    ) return;
    let cancelled = false;
    const loadThumbnail = () => {
      void requestTikTokThumbnail(tiktokExternalId, tiktokOEmbedUrl).then((url) => {
        if (!cancelled && url) setThumbnail(url);
      });
    };
    const target = containerRef.current;
    const stopObserving = target
      ? observeTikTokPreview(target, loadThumbnail)
      : (() => {
          loadThumbnail();
          return () => undefined;
        })();
    return () => {
      cancelled = true;
      stopObserving();
    };
  }, [referencePost?.platform, thumbnail, tiktokExternalId, tiktokOEmbedUrl]);

  if (!referencePost) return null;

  return (
    <div
      className={`post-visual trend-reference-visual platform-${referencePost.platform} is-playable ${active ? "is-playing" : ""}`}
      ref={containerRef}
    >
      {active ? (
        <SocialInlinePlayer
          active
          platform={referencePost.platform}
          sourceUrl={referencePost.url}
          title={`Post de référence pour ${trend.title}`}
          onClose={onClose}
        />
      ) : (
        <button
          className="post-visual-trigger"
          type="button"
          onClick={onActivate}
          aria-label={`Lire le post de référence pour « ${trend.title} »`}
        >
          {thumbnail ? (
            <img
              src={thumbnail}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => {
                if (tiktokExternalId) TIKTOK_THUMBNAIL_CACHE.delete(tiktokExternalId);
                setThumbnail(null);
              }}
            />
          ) : (
            <span className="post-preview-placeholder" aria-hidden="true">
              <b>{trendPlatformEmoji(referencePost.platform)}</b>
              <small>Post de référence</small>
            </span>
          )}
          <span className="media-play-mark" aria-hidden="true">▶</span>
        </button>
      )}
      <span className="post-rank">#{rank}</span>
      {referencePost.durationSeconds !== null ? (
        <span className="trend-duration-badge">⏱ {formatTrendDuration(referencePost.durationSeconds)}</span>
      ) : null}
    </div>
  );
}

function TrendDetailsModal({
  trend,
  onClose,
}: {
  trend: SocialTrend | null;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const [activeTone, setActiveTone] = useState<TrendTone>(
    trend?.proposals[0]?.tone ?? "complice",
  );
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const isOpen = Boolean(trend);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [isOpen, onClose]);

  if (!trend?.referencePost) return null;
  const referencePost = trend.referencePost;
  const lifecycle = TREND_LIFECYCLE_META[trend.lifecycle];
  const character = TREND_CHARACTER_META[trend.character];
  const reuseEvidence = trend.reuseEvidence;
  const proposal =
    trend.proposals.find((candidate) => candidate.tone === activeTone) ?? trend.proposals[0];
  const referenceMetrics = trendReferenceMetrics(referencePost);
  const titleId = `trend-details-${trend.id}`;
  const copyProposal = async () => {
    if (!proposal) return;
    const copied = await copyText(proposal.copy);
    setCopyState(copied ? "copied" : "error");
  };

  return (
    <div
      className="post-details-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`post-details-modal trend-details-modal tone-${lifecycle.tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={modalRef}
      >
        <header>
          <h2 id={titleId}>{trend.title}</h2>
          <button
            className="post-details-close"
            type="button"
            onClick={onClose}
            ref={closeButtonRef}
            aria-label="Fermer la fiche trend"
          >
            ✕
          </button>
        </header>

        <section className="trend-lofi-adaptation" aria-label={`Adaptation ${character.detailLabel} proposée`}>
          <span>{character.emoji} Adaptation {character.detailLabel}</span>
          <h4>{proposal?.title}</h4>
          <p>{proposal?.concept}</p>
        </section>

        {proposal ? (
          <section className="trend-modal-copy-section">
            <div className="trend-tone-tabs" role="group" aria-label={`Choisir un ton pour ${trend.title}`}>
              {trend.proposals.map((candidate) => {
                const tone = TREND_TONE_META[candidate.tone];
                const isActive = activeTone === candidate.tone;
                return (
                  <button
                    className={isActive ? "active" : ""}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => {
                      setActiveTone(candidate.tone);
                      setCopyState("idle");
                    }}
                    key={candidate.tone}
                  >
                    {tone.emoji} {candidate.label || tone.label}
                  </button>
                );
              })}
            </div>
            <blockquote>{proposal.copy}</blockquote>
            <button className="trend-copy-button" type="button" aria-live="polite" onClick={() => void copyProposal()}>
              {copyState === "copied"
                ? "✓ Texte copié"
                : copyState === "error"
                  ? "Copie impossible"
                  : "📋 Copier le texte"}
            </button>
          </section>
        ) : null}

        <div className={`post-details-summary ${referencePost.thumbnailUrl ? "has-thumbnail" : ""}`}>
          {referencePost.thumbnailUrl ? <img src={referencePost.thumbnailUrl} alt="" /> : null}
          <div>
            <span className="section-kicker">Post de référence · {referencePost.author ?? trendPlatformLabel(referencePost.platform)}</span>
            <p>{referencePost.caption}</p>
            {referenceMetrics.length ? (
              <div className="metric-row details-current-metrics">
                {referenceMetrics.map((metric) => <span key={metric}>{metric}</span>)}
              </div>
            ) : null}
            <a className="trend-original-link" href={referencePost.url} target="_blank" rel="noreferrer">
              Voir le post original ↗
            </a>
          </div>
        </div>

        {reuseEvidence ? (
          <section className="trend-example-section" aria-label="Exemples de la trend">
            <h4>Exemples</h4>
            <div className="trend-reuse-creators">
              {reuseEvidence.posts.map((post) => (
                <a href={post.url} target="_blank" rel="noreferrer" key={`${post.platform}:${post.url}`}>
                  <img src={`platforms/${post.platform}.svg`} alt="" width="20" height="20" />
                  <b>{post.author}</b>
                  <small>Voir l’exemple ↗</small>
                </a>
              ))}
              {trendExampleSearchLinks(trend).map((link) => (
                <a className="trend-more-examples-link" href={link.url} target="_blank" rel="noreferrer" key={`more:${link.platform}`}>
                  <img src={`platforms/${link.platform}.svg`} alt="" width="20" height="20" />
                  <b>Plus d’exemples</b>
                  <small>{link.label} ↗</small>
                </a>
              ))}
            </div>
          </section>
        ) : null}
      </section>
    </div>
  );
}

function trendPlatformLabel(platform: TrendPlatform) {
  if (platform === "youtube") return "YouTube Shorts";
  return PLATFORM_META[platform].label;
}

function trendPlatformEmoji(platform: TrendPlatform) {
  return PLATFORM_META[platform].emoji;
}

function trendExampleSearchLinks(trend: SocialTrend) {
  const platforms = new Set<TrendPlatform>(trend.platforms);
  if (trend.referencePost) platforms.add(trend.referencePost.platform);
  const query = [trend.title, ...trend.keywords.slice(0, 2)].join(" ");
  const encodedQuery = encodeURIComponent(query);

  return [...platforms].map((platform) => {
    if (platform === "instagram") {
      return {
        platform,
        label: "Instagram",
        url: `https://www.instagram.com/explore/search/keyword/?q=${encodedQuery}`,
      };
    }
    if (platform === "tiktok") {
      return {
        platform,
        label: "TikTok",
        url: `https://www.tiktok.com/search?q=${encodedQuery}`,
      };
    }
    if (platform === "youtube") {
      return {
        platform,
        label: "YouTube Shorts",
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${query} shorts`)}`,
      };
    }
    return {
      platform,
      label: "X",
      url: `https://x.com/search?q=${encodedQuery}&src=typed_query&f=top`,
    };
  });
}

function trendReferenceMetrics(referencePost: TrendReferencePost) {
  return [
    referencePost.durationSeconds !== null
      ? `⏱️ ${formatTrendDuration(referencePost.durationSeconds)}`
      : null,
    referencePost.metrics.views !== null
      ? `▶️ ${formatNumber(referencePost.metrics.views)} vues`
      : null,
    referencePost.metrics.likes !== null
      ? `❤️ ${formatNumber(referencePost.metrics.likes)}`
      : null,
    referencePost.metrics.comments !== null
      ? `💬 ${formatNumber(referencePost.metrics.comments)}`
      : null,
  ].filter((metric): metric is string => metric !== null);
}

function formatTrendDuration(durationSeconds: number) {
  return `${new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(durationSeconds)} s`;
}

function trendReferenceFooterMetrics(referencePost: TrendReferencePost) {
  return [
    referencePost.metrics.views !== null
      ? { icon: metricEmoji("views", referencePost.platform), label: "vues", value: referencePost.metrics.views }
      : null,
    referencePost.metrics.likes !== null
      ? { icon: metricEmoji("likes", referencePost.platform), label: "likes", value: referencePost.metrics.likes }
      : null,
    referencePost.metrics.comments !== null
      ? { icon: metricEmoji("comments", referencePost.platform), label: "commentaires", value: referencePost.metrics.comments }
      : null,
  ].filter(Boolean) as Array<{ icon: string; label: string; value: number }>;
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

function HistoryLoadingState({
  loadedPlatformCount,
  label,
  compact = false,
}: {
  loadedPlatformCount: number;
  label: string;
  compact?: boolean;
}) {
  const progress = Math.max(0, Math.min(100, (loadedPlatformCount / 4) * 100));
  return (
    <div className={`history-loading-state ${compact ? "compact" : ""}`} role="status">
      <span className="history-loading-icon" aria-hidden="true">⏳</span>
      <div>
        <b>{label}</b>
        <small>
          Les vrais compteurs sont déjà affichés · {loadedPlatformCount}/4 réseaux prêts
        </small>
        <span className="history-loading-track" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </span>
      </div>
    </div>
  );
}

function recommendationTier(score: number) {
  if (score >= 80) return "S";
  if (score >= 65) return "A";
  return "B";
}

function recommendationDisplayTitle(value: string) {
  return value;
}

type RecommendationSeed = SocialIdea["seedPosts"][number];

function recommendationContentIcon(contentType: SocialIdea["contentType"]) {
  if (contentType === "Vidéo courte") return "🎬";
  if (contentType === "Visuel statique") return "🖼️";
  if (contentType === "Carrousel") return "📚";
  if (contentType === "Question visuelle") return "💬";
  return "✍️";
}

function recommendationSeedMetrics(seed: RecommendationSeed) {
  return [
    seed.views !== null ? `▶ ${formatNumber(seed.views)} vues` : null,
    seed.likes !== null ? `❤️ ${formatNumber(seed.likes)} likes` : null,
    seed.comments !== null ? `💬 ${formatNumber(seed.comments)}` : null,
  ].filter((value): value is string => Boolean(value));
}

function recommendationSeedRank(seed: RecommendationSeed) {
  return seed.cohortRank === 1
    ? `n°1 sur ${seed.cohortSize} dans son format`
    : `n°${seed.cohortRank} sur ${seed.cohortSize} dans son format`;
}

function RecommendationCard({
  idea,
  rank,
  decision,
  disabled,
  onDecision,
  onInspect,
}: {
  idea: LearnedIdea;
  rank: number;
  decision?: IdeaDecision;
  disabled: boolean;
  onDecision: (idea: SocialIdea, decision: IdeaDecision) => void;
  onInspect: (idea: LearnedIdea) => void;
}) {
  const tier = recommendationTier(idea.learnedPotentialScore);

  return (
    <article className={`reco-card decision-${decision ?? "pending"}`}>
      <button
        className="reco-card-main"
        type="button"
        onClick={() => onInspect(idea)}
        aria-label={`Voir le détail de la recommandation ${recommendationDisplayTitle(idea.title)}`}
      >
        <header className="reco-card-head">
          <span className="reco-rank">N° {rank}</span>
          <span
            className={`reco-score tier-${tier.toLowerCase()}`}
            aria-label={`Potentiel ${idea.learnedPotentialScore} sur 100`}
          >
            🔥 {idea.learnedPotentialScore}/100
          </span>
        </header>
        <h3>{recommendationDisplayTitle(idea.title)}</h3>
        <div className="reco-tags">
          <span>{recommendationContentIcon(idea.contentType)} {idea.contentType}</span>
          <span>🧬 {idea.patternLabel}</span>
        </div>

        <div className="reco-copy-block">
          <span>💡 L’idée</span>
          <p>{idea.proposedFormat}</p>
        </div>
        <div className="reco-copy-block hook">
          <span>📝 Texte prêt à poster</span>
          <p>« {idea.hook} »</p>
        </div>

        {idea.seedPosts[0] ? (
          <div className="reco-proof-preview">
            <span>🔥 Inspiré de vos succès</span>
            <b>« {idea.seedPosts[0].label} »</b>
            <small>
              {recommendationSeedMetrics(idea.seedPosts[0]).slice(0, 2).join(" · ")} · {recommendationSeedRank(idea.seedPosts[0])}
            </small>
          </div>
        ) : null}
        <span className="reco-more">Voir la fiche →</span>
      </button>

      <footer className="reco-quick-actions" aria-label="Décider et entraîner le classement">
        <button
          className="reco-action edit"
          type="button"
          disabled={disabled}
          aria-pressed={decision === "rework"}
          onClick={() => void onDecision(idea, "rework")}
        >
          ✎ Modifier
        </button>
        <button
          className="reco-action refuse"
          type="button"
          disabled={disabled}
          aria-pressed={decision === "discard"}
          onClick={() => void onDecision(idea, "discard")}
        >
          ✕ Refuser
        </button>
        <button
          className="reco-action validate"
          type="button"
          disabled={disabled}
          aria-pressed={decision === "produce"}
          onClick={() => void onDecision(idea, "produce")}
        >
          ✓ Valider
        </button>
      </footer>
    </article>
  );
}

function RecommendationDetailsModal({
  idea,
  rank,
  onClose,
}: {
  idea: LearnedIdea | null;
  rank: number | null;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const isOpen = Boolean(idea);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [isOpen, onClose]);

  if (!idea) return null;

  return (
    <div
      className="post-details-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="post-details-modal recommendation-details-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recommendation-details-title"
        ref={modalRef}
      >
        <header>
          <div>
            <span>💡 Idée #{rank ?? 1} · {recommendationContentIcon(idea.contentType)} {idea.contentType}</span>
            <h2 id="recommendation-details-title">{recommendationDisplayTitle(idea.title)}</h2>
            <small className="details-theme-label">🔥 Potentiel {idea.learnedPotentialScore}/100 · {idea.proofLabel}</small>
          </div>
          <button
            className="post-details-close"
            type="button"
            onClick={onClose}
            ref={closeButtonRef}
            aria-label="Fermer la recommandation"
          >
            ✕
          </button>
        </header>

        <div className="recommendation-detail-grid clear-idea-grid">
          <section className="recommendation-detail-panel featured">
            <span className="section-kicker">💡 L’idée</span>
            <p>{idea.proposedFormat}</p>
          </section>
          <section className="recommendation-detail-panel">
            <span className="section-kicker">📝 Texte prêt à poster</span>
            <p>« {idea.hook} »</p>
          </section>
        </div>

        <section className="recommendation-detail-section">
          <span className="section-kicker">🎬 Ce qu’on produit</span>
          <div className="recommendation-production-brief">
            <b>{recommendationContentIcon(idea.contentType)} {idea.contentType}</b>
            <p>{idea.proposedFormat}</p>
          </div>
        </section>

        <section className="recommendation-detail-section">
          <span className="section-kicker">🔥 Pourquoi ça peut marcher chez nous</span>
          <div className="recommendation-history-proof">
            <p>{idea.whyItWorked}</p>
            <strong>{idea.observedSignal.summary}</strong>
            {idea.comparisonInsight ? <small>{idea.comparisonInsight}</small> : null}
          </div>
        </section>

        <section className="recommendation-detail-section">
          <span className="section-kicker">🏆 Les posts qui le prouvent</span>
          <div className="recommendation-source-links">
            {idea.seedPosts.map((seed, index) => (
              <a
                href={seed.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Ouvrir le post preuve ${index + 1}`}
                key={`${seed.platform}:${seed.externalId}`}
              >
                {seed.thumbnailUrl ? (
                  <img src={seed.thumbnailUrl} alt="" loading="lazy" />
                ) : (
                  <span className="recommendation-source-fallback">🏆</span>
                )}
                <div>
                  <b>« {seed.label} »</b>
                  <small>{recommendationSeedMetrics(seed).join(" · ")}</small>
                  <small>{recommendationSeedRank(seed)}{seed.publishedAt ? ` · ${formatCardPublishedDate(seed.publishedAt)}` : ""}</small>
                </div>
                <strong>Ouvrir ↗</strong>
              </a>
            ))}
          </div>
        </section>

        <section className="recommendation-detail-section">
          <span className="section-kicker">🧬 Ce qu’on reprend / ce qu’on change</span>
          <div className="recommendation-mechanic-grid">
            <article>
              <b>Ce qu’on reprend</b>
              <p>{idea.borrowedMechanic}</p>
            </article>
            <article>
              <b>Ce qu’on change</b>
              <p>{idea.novelty}</p>
            </article>
          </div>
        </section>

        <div className="recommendation-caveat">
          <span>🧪</span>
          <p>Cette idée reprend une mécanique déjà performante chez Lofi Girl, mais reste une nouvelle variation à tester. Aucun visuel ni aucune musique générés par IA.</p>
        </div>
      </section>
    </div>
  );
}

type RoadmapScale = "month" | "year";
type RoadmapDisplayMode = "list" | "calendar";
type PublicationCalendarItem = ScheduledIdea & LocalPublicationScheduleEntry;

const ROADMAP_WEEKDAYS = ["L", "M", "M", "J", "V", "S", "D"];

function roadmapCalendarCells(year: number, month: number) {
  const first = new Date(Date.UTC(year, month, 1));
  const leadingDays = (first.getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) =>
    new Date(Date.UTC(year, month, index - leadingDays + 1)),
  );
}

function roadmapDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function roadmapMonthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month, 1)));
}

function PublicationWorkspace({
  schedule,
  syncing,
  workflowReady,
  workflowAvailable,
  onRetryWorkflow,
  onOpenRecommendations,
}: {
  schedule: ScheduledIdea[];
  syncing: boolean;
  workflowReady: boolean;
  workflowAvailable: boolean;
  onRetryWorkflow: () => void;
  onOpenRecommendations: () => void;
}) {
  const ignoreScheduledPlans = useCallback(() => undefined, []);
  const ignoreStorageAvailability = useCallback(() => undefined, []);

  return (
    <div className="roadmap-view publication-view">
      <header className="roadmap-heading">
        <div>
          <h2>Publication</h2>
          <p>Prépare et valide les contenus destinés aux comptes officiels.</p>
        </div>
        {syncing ? <span className="workflow-syncing">Synchronisation…</span> : null}
      </header>

      <PublicationComposer
        schedule={schedule}
        syncing={syncing}
        workflowReady={workflowReady}
        workflowAvailable={workflowAvailable}
        onScheduledPlansChange={ignoreScheduledPlans}
        onStorageAvailabilityChange={ignoreStorageAvailability}
        onRetryWorkflow={onRetryWorkflow}
        onOpenRecommendations={onOpenRecommendations}
      />
    </div>
  );
}

function readLocalScheduledPlans(): LocalPublicationScheduleEntry[] {
  const raw = window.localStorage.getItem(PUBLICATION_STORAGE_KEY);
  if (!raw) return [];
  const queue = normalizePublicationQueue(JSON.parse(raw));
  return sortedPublicationPlans(queue)
    .filter((plan) => plan.status === "scheduled")
    .map((plan) => ({
      ideaId: plan.ideaId,
      publishAtLocal: plan.publishAtLocal,
      platforms: plan.platforms,
      caption: plan.caption,
    }));
}

function PlanningBoard({
  schedule,
  syncing,
  workflowReady,
  workflowAvailable,
  onRetryWorkflow,
  onOpenPublication,
}: {
  schedule: ScheduledIdea[];
  syncing: boolean;
  workflowReady: boolean;
  workflowAvailable: boolean;
  onRetryWorkflow: () => void;
  onOpenPublication: () => void;
}) {
  const now = new Date();
  const [scale, setScale] = useState<RoadmapScale>("year");
  const [displayMode, setDisplayMode] = useState<RoadmapDisplayMode>("calendar");
  const [cursorYear, setCursorYear] = useState(now.getFullYear());
  const [cursorMonth, setCursorMonth] = useState(now.getMonth());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [localScheduledPlans, setLocalScheduledPlans] = useState<LocalPublicationScheduleEntry[]>([]);
  const [publicationStorageReady, setPublicationStorageReady] = useState(false);
  const [publicationStorageAvailable, setPublicationStorageAvailable] = useState(true);
  const closeSelectedDay = useCallback(() => setSelectedDay(null), []);

  useEffect(() => {
    const refresh = () => {
      try {
        setLocalScheduledPlans(readLocalScheduledPlans());
        setPublicationStorageAvailable(true);
      } catch {
        setLocalScheduledPlans([]);
        setPublicationStorageAvailable(false);
      } finally {
        setPublicationStorageReady(true);
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === PUBLICATION_STORAGE_KEY || event.key === null) refresh();
    };
    refresh();
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);
  const localScheduleByIdea = new Map(
    localScheduledPlans.map((item) => [item.ideaId, item] as const),
  );
  const sortedSchedule: PublicationCalendarItem[] = schedule
    .filter((item) => item.status === "planned" && localScheduleByIdea.has(item.ideaId))
    .map((item) => {
      const localPlan = localScheduleByIdea.get(item.ideaId)!;
      return {
        ...item,
        ...localPlan,
        hook: localPlan.caption,
        scheduledFor: localPlan.publishAtLocal.slice(0, 10),
      };
    })
    .sort((left, right) =>
      left.publishAtLocal.localeCompare(right.publishAtLocal) || left.ideaId.localeCompare(right.ideaId),
    );
  const filteredSchedule = sortedSchedule.filter((item) => {
    const yearMatches = Number(item.scheduledFor.slice(0, 4)) === cursorYear;
    if (!yearMatches) return false;
    return scale === "year" || Number(item.scheduledFor.slice(5, 7)) - 1 === cursorMonth;
  });
  const scheduleByDate = new Map<string, PublicationCalendarItem[]>();
  for (const item of filteredSchedule) {
    const existing = scheduleByDate.get(item.scheduledFor) ?? [];
    existing.push(item);
    scheduleByDate.set(item.scheduledFor, existing);
  }
  const selectedItems = selectedDay
    ? sortedSchedule.filter((item) => item.scheduledFor === selectedDay)
    : [];
  const periodLabel = scale === "year"
    ? String(cursorYear)
    : roadmapMonthLabel(cursorYear, cursorMonth);

  const movePeriod = (direction: -1 | 1) => {
    if (scale === "year") {
      setCursorYear((year) => year + direction);
      return;
    }
    const next = new Date(Date.UTC(cursorYear, cursorMonth + direction, 1));
    setCursorYear(next.getUTCFullYear());
    setCursorMonth(next.getUTCMonth());
  };

  return (
    <div className="roadmap-view">
      <header className="roadmap-heading">
        <div>
          <h2>Planning</h2>
          <p>Retrouve dans le calendrier les contenus validés et programmés.</p>
        </div>
        {syncing ? <span className="workflow-syncing">Synchronisation…</span> : null}
      </header>

      {workflowReady && workflowAvailable && publicationStorageReady && publicationStorageAvailable ? (
        <>
          <div className="roadmap-controls">
            <div className="roadmap-scale-toggle" aria-label="Période des publications">
              <button className={scale === "month" ? "active" : ""} type="button" aria-pressed={scale === "month"} onClick={() => setScale("month")}>Mois</button>
              <button className={scale === "year" ? "active" : ""} type="button" aria-pressed={scale === "year"} onClick={() => setScale("year")}>Année</button>
            </div>
            <div className="roadmap-period-navigation">
              <button type="button" aria-label="Période précédente" onClick={() => movePeriod(-1)}>‹</button>
              <strong>{periodLabel}</strong>
              <button type="button" aria-label="Période suivante" onClick={() => movePeriod(1)}>›</button>
            </div>
            <div className="roadmap-display-toggle" aria-label="Affichage des publications">
              <button className={displayMode === "list" ? "active" : ""} type="button" aria-label="Liste" aria-pressed={displayMode === "list"} onClick={() => setDisplayMode("list")}>☰</button>
              <button className={displayMode === "calendar" ? "active" : ""} type="button" aria-label="Calendrier" aria-pressed={displayMode === "calendar"} onClick={() => setDisplayMode("calendar")}>▣</button>
            </div>
          </div>

          {displayMode === "list" ? (
            <RoadmapList
              items={filteredSchedule}
              onOpenPublication={onOpenPublication}
            />
          ) : (
            <div className="roadmap-calendar-shell platform-neutral">
              {scale === "year" ? (
                <div className="roadmap-year-grid">
                  {Array.from({ length: 12 }, (_, month) => (
                    <RoadmapMiniMonth
                      year={cursorYear}
                      month={month}
                      scheduleByDate={scheduleByDate}
                      onSelectDay={setSelectedDay}
                      key={`${cursorYear}-${month}`}
                    />
                  ))}
                </div>
              ) : (
                <RoadmapMonth
                  year={cursorYear}
                  month={cursorMonth}
                  scheduleByDate={scheduleByDate}
                  onSelectDay={setSelectedDay}
                />
              )}
            </div>
          )}

          {!sortedSchedule.length ? (
            <button className="roadmap-empty-cta" type="button" onClick={onOpenPublication}>
              🚀 Programmer un contenu depuis Publication
            </button>
          ) : null}

          <RoadmapDayModal
            date={selectedDay}
            items={selectedItems}
            onClose={closeSelectedDay}
          />
        </>
      ) : (
        <div className="empty-state roadmap-list-empty">
          <span>{!workflowReady ? "⏳" : "🔒"}</span>
          <h3>
            {!workflowReady
              ? "Chargement du planning"
              : !workflowAvailable
                ? "Planning momentanément indisponible"
                : "Stockage local indisponible"}
          </h3>
          <p>
            {!workflowReady
              ? "Les contenus programmés arrivent dans un instant."
              : !workflowAvailable
                ? "Recharge les contenus validés pour retrouver le planning."
                : "Le calendrier reste verrouillé pour éviter d’afficher une programmation incomplète."}
          </p>
          {workflowReady && !workflowAvailable ? (
            <button className="button secondary" type="button" onClick={onRetryWorkflow}>Réessayer</button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function RoadmapMiniMonth({
  year,
  month,
  scheduleByDate,
  onSelectDay,
}: {
  year: number;
  month: number;
  scheduleByDate: Map<string, PublicationCalendarItem[]>;
  onSelectDay: (date: string) => void;
}) {
  return (
    <section className="roadmap-mini-month">
      <h3>{new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month, 1)))}</h3>
      <div className="roadmap-weekdays" aria-hidden="true">
        {ROADMAP_WEEKDAYS.map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}
      </div>
      <div className="roadmap-mini-days">
        {roadmapCalendarCells(year, month).map((date) => {
          const key = roadmapDateKey(date);
          const outside = date.getUTCMonth() !== month;
          const items = outside ? [] : (scheduleByDate.get(key) ?? []);
          return items.length ? (
            <button
              className={`roadmap-mini-event ${items.length > 1 ? "multiple" : ""}`}
              type="button"
              title={items.map((item) => recommendationDisplayTitle(item.title)).join(" · ")}
              aria-label={`${date.getUTCDate()} ${roadmapMonthLabel(year, month)}, ${items.length} publication${items.length > 1 ? "s" : ""}`}
              onClick={() => onSelectDay(key)}
              key={key}
            >
              {date.getUTCDate()}
              {items.length > 1 ? <small>{items.length}</small> : null}
            </button>
          ) : (
            <span className={outside ? "outside" : ""} key={key}>{date.getUTCDate()}</span>
          );
        })}
      </div>
    </section>
  );
}

function RoadmapMonth({
  year,
  month,
  scheduleByDate,
  onSelectDay,
}: {
  year: number;
  month: number;
  scheduleByDate: Map<string, PublicationCalendarItem[]>;
  onSelectDay: (date: string) => void;
}) {
  return (
    <section className="roadmap-month-calendar">
      <div className="roadmap-month-weekdays" aria-hidden="true">
        {["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"].map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="roadmap-month-days">
        {roadmapCalendarCells(year, month).map((date) => {
          const key = roadmapDateKey(date);
          const outside = date.getUTCMonth() !== month;
          const items = outside ? [] : (scheduleByDate.get(key) ?? []);
          return (
            <div className={`roadmap-month-day ${outside ? "outside" : ""} ${items.length ? "has-events" : ""}`} key={key}>
              <span className="roadmap-month-day-number">{date.getUTCDate()}</span>
              <div className="roadmap-month-events">
                {items.map((item) => (
                  <button
                    className="roadmap-month-event"
                    type="button"
                    title={recommendationDisplayTitle(item.title)}
                    onClick={() => onSelectDay(key)}
                    key={item.id}
                  >
                    <span>✦</span>
                    <b>{recommendationDisplayTitle(item.title)}</b>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RoadmapList({
  items,
  onOpenPublication,
}: {
  items: PublicationCalendarItem[];
  onOpenPublication: () => void;
}) {
  if (!items.length) {
    return (
      <div className="empty-state roadmap-list-empty">
        <span>🗓️</span>
        <h3>Aucune publication sur cette période</h3>
        <p>Programme un contenu ou change de période.</p>
        <button className="button primary" type="button" onClick={onOpenPublication}>Ouvrir Publication</button>
      </div>
    );
  }

  return (
    <div className="roadmap-list">
      {items.map((item) => (
        <article className="roadmap-list-card" key={item.id}>
          <time dateTime={item.publishAtLocal}>
            <b>{item.scheduledFor.slice(8, 10)}</b>
            <span>{new Intl.DateTimeFormat("fr-FR", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${item.scheduledFor}T12:00:00.000Z`))}</span>
          </time>
          <div className="roadmap-list-platforms" aria-label={item.platforms.map((platform) => PLATFORM_META[platform].label).join(", ")}>
            {item.platforms.map((platform) => (
              <img src={`platforms/${platform}.svg`} width="22" height="22" alt="" key={platform} />
            ))}
          </div>
          <div>
            <small>{item.publishAtLocal.slice(11, 16)} · {item.platforms.map((platform) => PLATFORM_META[platform].label).join(" · ")}</small>
            <h3>{recommendationDisplayTitle(item.title)}</h3>
            <p>« {item.hook} »</p>
          </div>
        </article>
      ))}
    </div>
  );
}

function RoadmapDayModal({
  date,
  items,
  onClose,
}: {
  date: string | null;
  items: PublicationCalendarItem[];
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const isOpen = Boolean(date && items.length);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [],
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [isOpen, onClose]);

  if (!date || !items.length) return null;
  return (
    <div className="post-details-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="roadmap-day-modal" role="dialog" aria-modal="true" aria-labelledby="roadmap-day-title" ref={modalRef}>
        <header>
          <div>
            <span className="section-kicker">🗓️ Publication{items.length > 1 ? "s" : ""} planifiée{items.length > 1 ? "s" : ""}</span>
            <h2 id="roadmap-day-title">{formatCardPublishedDate(`${date}T12:00:00.000Z`)}</h2>
          </div>
          <button className="post-details-close" type="button" onClick={onClose} ref={closeButtonRef} aria-label="Fermer">✕</button>
        </header>
        <div className="roadmap-day-modal-list">
          {items.map((item) => (
            <article key={item.id}>
              <div className="roadmap-list-platforms" aria-label={item.platforms.map((platform) => PLATFORM_META[platform].label).join(", ")}>
                {item.platforms.map((platform) => (
                  <img src={`platforms/${platform}.svg`} width="22" height="22" alt="" key={platform} />
                ))}
              </div>
              <div>
                <small>{item.publishAtLocal.slice(11, 16)} · {item.platforms.map((platform) => PLATFORM_META[platform].label).join(" · ")}</small>
                <h3>{recommendationDisplayTitle(item.title)}</h3>
                <p>« {item.hook} »</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

type TikTokThumbnailCacheEntry = { url: string; expiresAt: number };

const TIKTOK_THUMBNAIL_CACHE = new Map<string, TikTokThumbnailCacheEntry>();
const TIKTOK_THUMBNAIL_REQUESTS = new Map<string, Promise<string | null>>();
const TIKTOK_PREVIEW_TARGETS = new Map<Element, () => void>();
let sharedTikTokPreviewObserver: IntersectionObserver | null = null;

function getCachedTikTokThumbnail(externalId: string): string | null {
  const cached = TIKTOK_THUMBNAIL_CACHE.get(externalId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    TIKTOK_THUMBNAIL_CACHE.delete(externalId);
    return null;
  }
  return cached.url;
}

function requestTikTokThumbnail(
  externalId: string,
  oEmbedUrl: string,
): Promise<string | null> {
  const cached = getCachedTikTokThumbnail(externalId);
  if (cached) return Promise.resolve(cached);
  const pending = TIKTOK_THUMBNAIL_REQUESTS.get(externalId);
  if (pending) return pending;

  const request = fetch(oEmbedUrl, { mode: "cors" })
    .then(async (response) => {
      if (!response.ok) return null;
      const payload = (await response.json()) as { thumbnail_url?: unknown };
      const thumbnail = parseTikTokThumbnailUrl(payload.thumbnail_url);
      if (!thumbnail) return null;
      TIKTOK_THUMBNAIL_CACHE.set(externalId, thumbnail);
      return thumbnail.url;
    })
    .catch(() => null)
    .finally(() => TIKTOK_THUMBNAIL_REQUESTS.delete(externalId));
  TIKTOK_THUMBNAIL_REQUESTS.set(externalId, request);
  return request;
}

function observeTikTokPreview(target: Element, onVisible: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onVisible();
    return () => undefined;
  }
  if (!sharedTikTokPreviewObserver) {
    sharedTikTokPreviewObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const callback = TIKTOK_PREVIEW_TARGETS.get(entry.target);
          TIKTOK_PREVIEW_TARGETS.delete(entry.target);
          sharedTikTokPreviewObserver?.unobserve(entry.target);
          callback?.();
        }
      },
      { rootMargin: "420px" },
    );
  }
  TIKTOK_PREVIEW_TARGETS.set(target, onVisible);
  sharedTikTokPreviewObserver.observe(target);
  return () => {
    TIKTOK_PREVIEW_TARGETS.delete(target);
    sharedTikTokPreviewObserver?.unobserve(target);
  };
}

function PostCard({
  post,
  rank,
  compact,
  isPlaying,
  onTogglePlayback,
  onOpenDetails,
}: {
  post: SocialPost;
  rank: number;
  compact: boolean;
  isPlaying: boolean;
  onTogglePlayback: (post: SocialPost) => void;
  onOpenDetails: (post: SocialPost) => void;
}) {
  const isCommunityImage = post.platform === "youtube" && post.format === "community_image";
  const hasMediaPreview = Boolean(getSocialVideoEmbed(post) || post.thumbnail_url || isCommunityImage);
  const postCopy = post.text || post.title || "Publication sans légende";
  const choices = post.format === "community_poll" ? pollChoices(post) : [];
  const publishedDate = formatCardPublishedDate(post.published_at);
  const footerMetrics = [
    { icon: metricEmoji("views", post.platform), label: "vues", value: post.views },
    { icon: metricEmoji("likes", post.platform), label: "likes", value: post.likes },
    { icon: metricEmoji("comments", post.platform), label: "commentaires", value: post.comments },
    { icon: metricEmoji("shares", post.platform), label: "partages", value: post.shares },
  ] satisfies Array<{ icon: string; label: string; value: number | null }>;
  const performanceScore =
    typeof post.performance_score === "number" && Number.isFinite(post.performance_score)
      ? Math.max(0, Math.min(100, Math.round(post.performance_score)))
      : null;
  const performanceScoreTone =
    performanceScore === null
      ? "is-unavailable"
      : performanceScore >= 75
        ? "is-green"
        : performanceScore >= 50
          ? "is-yellow"
          : performanceScore >= 25
            ? "is-orange"
            : "is-red";
  const performanceScoreLabel =
    performanceScore === null
      ? "Score de performance indisponible : aucune métrique publique comparable"
      : `Score de performance ${performanceScore} sur 100`;
  const performanceScoreTitle =
    post.score_explanation?.trim() ||
    (performanceScore === null
      ? "Aucune métrique publique comparable : aucun score n’est calculé."
      : "Score relatif aux posts de la même plateforme et du même format.");

  return (
    <article
      className={`social-post-card ${compact ? "compact" : ""} ${hasMediaPreview ? "has-media" : "text-only"} ${choices.length ? "poll-card" : ""}`}
    >
      <span
        className={`post-performance-score ${performanceScoreTone}`}
        aria-label={performanceScoreLabel}
        title={performanceScoreTitle}
      >
        <span>Score</span>
        <b>{performanceScore ?? "—"}</b>
        <small>/100</small>
      </span>
      {hasMediaPreview ? (
        <PostMediaPreview
          post={post}
          rank={rank}
          isPlaying={isPlaying}
          onTogglePlayback={onTogglePlayback}
          onOpenDetails={onOpenDetails}
        />
      ) : null}
      <div className="post-card-body">
        {!hasMediaPreview ? (
          <div className="post-card-meta-row">
            <span className="inline-post-rank">#{rank}</span>
          </div>
        ) : null}
        <div className="post-card-title">
          <div>
            {hasMediaPreview ? (
              <div className="post-media-caption">
                <h3>
                  <a href={post.url} target="_blank" rel="noreferrer">
                    {postCopy}
                  </a>
                </h3>
              </div>
            ) : (
              <div className="post-text-content">
                <a href={post.url} target="_blank" rel="noreferrer">
                  {postCopy}
                </a>
              </div>
            )}
          </div>
        </div>
        {choices.length ? (
          <ul className="poll-choice-list" aria-label="Options du sondage">
            {choices.map((choice) => <li key={choice}>{choice}</li>)}
          </ul>
        ) : null}
        <footer>
          {publishedDate ? (
            <time className="post-published-date" dateTime={post.published_at ?? undefined}>
              {publishedDate}
            </time>
          ) : <span />}
          <span className="post-card-footer-metrics" aria-label="Performances visibles">
            {footerMetrics.map((metric) => (
              <span
                className={`post-card-metric ${metric.value === null ? "is-unavailable" : ""}`}
                key={metric.label}
                title={metric.value === null ? `${metric.label} non disponibles` : metric.label}
              >
                {metric.icon} <b>{metric.value === null ? "—" : formatNumber(metric.value)}</b>
              </span>
            ))}
          </span>
          <span className="post-card-actions">
            <button type="button" onClick={() => onOpenDetails(post)}>
              Plus d’informations
            </button>
          </span>
        </footer>
      </div>
    </article>
  );
}

function PostMediaPreview({
  post,
  rank,
  isPlaying,
  onTogglePlayback,
  onOpenDetails,
}: {
  post: SocialPost;
  rank: number;
  isPlaying: boolean;
  onTogglePlayback: (post: SocialPost) => void;
  onOpenDetails: (post: SocialPost) => void;
}) {
  const meta = PLATFORM_META[post.platform];
  const video = getSocialVideoEmbed(post);
  const previewRef = useRef<HTMLDivElement>(null);
  const videoPlatform = video?.platform;
  const videoExternalId = video?.externalId;
  const posterUrl = video?.posterUrl ?? post.thumbnail_url;
  const oEmbedUrl = getTikTokOEmbedUrl(post);
  const cachedTikTokThumbnail =
    videoPlatform === "tiktok" && videoExternalId
      ? getCachedTikTokThumbnail(videoExternalId)
      : null;
  const initialThumbnail = posterUrl ?? cachedTikTokThumbnail;
  const [thumbnail, setThumbnail] = useState<string | null>(initialThumbnail);
  const [thumbnailSource, setThumbnailSource] = useState<
    "poster" | "cache" | "oembed" | "none"
  >(posterUrl ? "poster" : cachedTikTokThumbnail ? "cache" : "none");
  const [shouldLoadTikTokThumbnail, setShouldLoadTikTokThumbnail] = useState(
    videoPlatform === "tiktok" && !initialThumbnail,
  );

  useEffect(() => {
    if (
      videoPlatform !== "tiktok" ||
      !videoExternalId ||
      !oEmbedUrl ||
      !shouldLoadTikTokThumbnail
    ) {
      return;
    }
    let cancelled = false;
    const loadThumbnail = () => {
      void requestTikTokThumbnail(videoExternalId, oEmbedUrl).then((url) => {
        if (cancelled) return;
        setShouldLoadTikTokThumbnail(false);
        if (!url) return;
        setThumbnail(url);
        setThumbnailSource("oembed");
      });
    };

    const target = previewRef.current;
    let stopObserving: () => void = () => undefined;
    if (target) stopObserving = observeTikTokPreview(target, loadThumbnail);
    else loadThumbnail();

    return () => {
      cancelled = true;
      stopObserving();
    };
  }, [oEmbedUrl, shouldLoadTikTokThumbnail, videoExternalId, videoPlatform]);

  return (
    <div
      className={`post-visual platform-${post.platform} ${video ? "is-playable" : "is-image"} ${video && isPlaying ? "is-playing" : ""}`}
      ref={previewRef}
    >
      {video && isPlaying ? (
        <>
          <div className="inline-video-frame">
            <iframe
              src={video.playerUrl}
              title={`Lecteur ${meta.label} : ${post.title || post.text || "publication"}`}
              allow="encrypted-media; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          </div>
          <button
            className="inline-player-close"
            type="button"
            onClick={() => onTogglePlayback(post)}
            aria-label="Fermer le lecteur intégré"
          >
            ✕
          </button>
        </>
      ) : (
        <button
          className="post-visual-trigger"
          type="button"
          onClick={() => video ? onTogglePlayback(post) : onOpenDetails(post)}
          disabled={!video && !thumbnail}
          aria-label={
            video
              ? `Lire « ${post.title || post.text || "cette vidéo"} » directement dans le radar`
              : `Voir les informations de « ${post.title || post.text || "cette publication"} »`
          }
        >
          {thumbnail ? (
            <img
              src={thumbnail}
              alt=""
              loading="lazy"
              onError={() => {
                if (videoPlatform === "tiktok" && videoExternalId) {
                  TIKTOK_THUMBNAIL_CACHE.delete(videoExternalId);
                  if (thumbnailSource !== "oembed") {
                    setShouldLoadTikTokThumbnail(true);
                  }
                }
                setThumbnailSource("none");
                setThumbnail(null);
              }}
            />
          ) : (
            <span className="post-preview-placeholder" aria-hidden="true">
              <b>{meta.emoji}</b>
              {video ? <small>Aperçu {meta.label}</small> : null}
            </span>
          )}
          {video ? <span className="media-play-mark" aria-hidden="true">▶</span> : null}
        </button>
      )}
      {!isPlaying ? <span className="post-rank">#{rank}</span> : null}
    </div>
  );
}

function PostDetailsModal({
  post,
  editorialAnalysis,
  onClose,
}: {
  post: SocialPost | null;
  editorialAnalysis: EditorialWhy | null;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const isOpen = Boolean(post);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [isOpen, onClose]);

  if (!post) return null;
  const meta = PLATFORM_META[post.platform];
  const title = post.title || post.text || `Publication ${meta.label}`;
  const thumbnail = getSocialVideoEmbed(post)?.posterUrl ?? post.thumbnail_url;
  const history = normalizedMetricHistory(post);
  const primaryMetric = primaryTimelineMetric(post, history);
  const timelinePoints = primaryMetric
    ? history.filter((point) => point[primaryMetric] !== null)
    : [];
  const firstPoint = timelinePoints[0];
  const lastPoint = timelinePoints.at(-1);
  const firstValue = primaryMetric && firstPoint ? firstPoint[primaryMetric] : null;
  const nearLaunch = isNearLaunchObservation(post, firstPoint?.captured_at);
  const detailTheme = postLabel(post, editorialAnalysis);
  const precisionLabel = post.published_at_precision === "exact"
    ? "Date exacte"
    : post.published_at_precision === "approximate"
      ? "Date approximative"
      : "Précision inconnue";

  return (
    <div
      className="post-details-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`post-details-modal tone-${meta.tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="post-details-title"
        ref={modalRef}
      >
        <header>
          <div>
            <span>{meta.emoji} Fiche détaillée · {getSocialFormatLabel(post)}</span>
            <h2 id="post-details-title">{title}</h2>
            <small className="details-theme-label">{detailTheme}</small>
          </div>
          <button
            className="post-details-close"
            type="button"
            onClick={onClose}
            ref={closeButtonRef}
            aria-label="Fermer la fiche détaillée"
          >
            ✕
          </button>
        </header>

        <div className={`post-details-summary ${thumbnail ? "has-thumbnail" : ""}`}>
          {thumbnail ? (
            <img src={thumbnail} alt="" />
          ) : null}
          <div>
            <span className="section-kicker">Publication</span>
            <p>{post.text || post.title || "Aucun texte public associé."}</p>
            {post.format === "community_poll" && pollChoices(post).length ? (
              <ul className="poll-choice-list details-poll-choice-list" aria-label="Options du sondage">
                {pollChoices(post).map((choice) => <li key={choice}>{choice}</li>)}
              </ul>
            ) : null}
            <div className="metric-row details-current-metrics">
              {metrics(post).map((metric) => (
                <span key={metric.label} title={metric.label}>
                  {metric.icon} <b>{formatNumber(metric.value)}</b> {metric.label}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="post-observation-grid">
          <div>
            <span>Publié</span>
            <b>{formatDetailedDate(post.published_at)}</b>
            <small>{post.published_at ? precisionLabel : "Date publique absente"}</small>
          </div>
          <div>
            <span>Premier relevé</span>
            <b>{formatDetailedDate(firstPoint?.captured_at ?? post.first_seen_at)}</b>
            <small>Première valeur réellement enregistrée par le radar</small>
          </div>
          <div className="launch-observation-card">
            <span>Mesure au lancement</span>
            <b>
              {nearLaunch && primaryMetric && firstValue !== null
                ? `${formatNumber(firstValue)} ${METRIC_META[primaryMetric].label} au 1er relevé`
                : "Non mesurée"}
            </b>
            <small>{observationDelay(post, firstPoint?.captured_at)}</small>
          </div>
          <div>
            <span>Dernier relevé</span>
            <b>{formatDetailedDate(lastPoint?.captured_at ?? post.last_metric_at)}</b>
            <small>{history.length} point{history.length > 1 ? "s" : ""} de mesure conservé{history.length > 1 ? "s" : ""}</small>
          </div>
        </div>

        <footer>
          <span>Données publiques réellement observées · aucune trajectoire inventée</span>
          <a href={post.url} target="_blank" rel="noreferrer">
            Ouvrir sur {meta.label} ↗
          </a>
        </footer>
      </section>
    </div>
  );
}
