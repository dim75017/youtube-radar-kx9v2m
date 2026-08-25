"use client";

/* eslint-disable @next/next/no-img-element -- thumbnails come from live social sources with dynamic hosts. */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  AUDIENCE_PERIODS,
  audienceGrowth,
  audiencePeriod,
  latestAudienceObservation,
  type AudienceHistory,
  type AudienceObservation,
  type AudiencePeriodKey,
} from "../lib/audience-metrics";

import {
  generateSocialIdeas,
  type SocialIdea,
} from "../lib/social-ideas";
import {
  applyPreferenceLearning,
  EMPTY_EDITORIAL_WORKFLOW,
  feedbackForIdea,
  normalizeWorkflowState,
  scheduleAcceptedIdea,
  updateScheduledDate,
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
  trendPriorityScore,
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
import { dailyRotationIndex } from "../lib/daily-rotation";
import { isTrendEditorialScanLate } from "../lib/trend-health";
import {
  isScanLate,
  type AudioTrendScanStatus,
  type VideoTrendScanStatus,
} from "../lib/trend-scan-status";
import { AudioTrendFeedView } from "./AudioTrendFeedView";
import { CommentOpportunitiesView } from "./CommentOpportunitiesView";
import { SocialInlinePlayer } from "./SocialInlinePlayer";

type Platform = "youtube" | "instagram" | "tiktok" | "x";
type View = "overview" | "top" | "comments" | "trends" | "audio-trends" | "ideas" | "planning" | "all" | "sources";
type IdeaStatusFilter = "all" | "pending" | IdeaDecision;
type PostSort = "popular" | "recent";
type TrendPlatformFilter = TrendPlatform | "all";
type TrendCharacterFilter = TrendCharacter | "all";

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
  { id: "overview", emoji: "📊", label: "Tableau de bord", group: "Pilotage" },
  { id: "top", emoji: "🏆", label: "Tous les posts", group: "Pilotage" },
  { id: "ideas", emoji: "💡", label: "Recommandations", group: "Pilotage" },
  { id: "planning", emoji: "🗓️", label: "Roadmap", group: "Pilotage" },
];

const RECOMMENDATION_NAV: Array<{
  id: Extract<View, "ideas" | "comments" | "trends" | "audio-trends">;
  emoji: string;
  label: string;
}> = [
  { id: "trends", emoji: "🔥", label: "Trends vidéos" },
  { id: "audio-trends", emoji: "🎧", label: "Trends audio" },
  { id: "ideas", emoji: "📝", label: "Posts recommandés" },
  { id: "comments", emoji: "💬", label: "Commentaires" },
];

const EDITORIAL_WORKFLOW_STORAGE_KEY = "lofi-social-radar:editorial-workflow:v2";
const POSTS_PAGE_SIZE = 48;
const TREND_CANDIDATE_PREVIEW_LIMIT = 12;
const PLATFORM_ORDER: Platform[] = ["youtube", "instagram", "tiktok", "x"];
const DEFAULT_FORMAT_FILTER: Record<Platform, SocialFormatFilter> = {
  youtube: "short",
  instagram: "reel",
  tiktok: "video",
  x: "static",
};

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

const TREND_CHARACTER_FILTERS: Array<{
  key: TrendCharacterFilter;
  emoji: string;
  label: string;
}> = [
  { key: "all", emoji: "🌐", label: "Tout l’univers" },
  { key: "lofi-girl", emoji: "🎧", label: "Lofi Girl" },
  { key: "lofi-boy", emoji: "🎮", label: "Lofi Boy" },
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
  return getFormatFilters(platform).filter((filter) => filter.key !== "all");
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

function formatTrendEditorialScanDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function SocialOS({
  initialWorkspace = null,
  initialTrendFeed = null,
  initialAudioTrendFeed = null,
  initialVideoTrendScanStatus = null,
  initialAudioTrendScanStatus = null,
  initialCommentOpportunityFeed = null,
  initialAudienceHistory = null,
  previewMode = false,
  publicCounts,
  publicFormatCounts,
  pendingPlatforms = [],
  historyError = "",
}: {
  initialWorkspace?: WorkspacePayload | null;
  initialTrendFeed?: SocialTrendFeed | null;
  initialAudioTrendFeed?: AudioTrendFeed | null;
  initialVideoTrendScanStatus?: VideoTrendScanStatus | null;
  initialAudioTrendScanStatus?: AudioTrendScanStatus | null;
  initialCommentOpportunityFeed?: CommentOpportunityFeed | null;
  initialAudienceHistory?: AudienceHistory | null;
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
  const [commentOpportunityFeed, setCommentOpportunityFeed] = useState<CommentOpportunityFeed | null>(initialCommentOpportunityFeed);
  const [commentsLoading, setCommentsLoading] = useState(!previewMode && !initialCommentOpportunityFeed);
  const [commentsError, setCommentsError] = useState("");
  const [view, setView] = useState<View>("overview");
  const [topPlatform, setTopPlatform] = useState<Platform>("youtube");
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
  const [editorialWorkflowSyncing, setEditorialWorkflowSyncing] = useState(false);
  const editorialWorkflowMutationRef = useRef(false);
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
          setEditorialWorkflow(next);
          setEditorialWorkflowReady(true);
        }
        return;
      }
      try {
        const response = await fetch("/api/editorial-workflow", { cache: "no-store" });
        const payload = await response.json() as EditorialWorkflowState & { error?: string };
        if (!response.ok) throw new Error(payload.error || "Le workflow éditorial ne répond pas.");
        if (!cancelled) setEditorialWorkflow(normalizeWorkflowState(payload));
      } catch (workflowError) {
        if (!cancelled) {
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
  }, [previewMode]);

  useEffect(() => {
    if (!previewMode || !editorialWorkflowReady) return;
    try {
      window.localStorage.setItem(
        EDITORIAL_WORKFLOW_STORAGE_KEY,
        JSON.stringify(editorialWorkflow),
      );
    } catch {
      // Keep the in-memory state when the browser refuses local storage.
    }
  }, [editorialWorkflow, editorialWorkflowReady, previewMode]);

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
          setToast(`Recommandations recalculées sur ${workspace?.posts.length ?? 0} contenus publics`);
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
  const accounts = workspace?.accounts ?? [];
  const normalizedPosts = useMemo(
    () => posts.map(normalizedIdeaPost),
    [posts],
  );
  const resolvedPlatformCounts = useMemo(() => {
    const counts = { youtube: 0, instagram: 0, tiktok: 0, x: 0 } satisfies Record<Platform, number>;
    for (const post of posts) counts[post.platform] += 1;
    for (const key of PLATFORM_ORDER) {
      const publishedCount = publicCounts?.[key];
      if (publishedCount !== undefined) counts[key] = publishedCount;
    }
    return counts;
  }, [posts, publicCounts]);
  const historyLoading = pendingPlatforms.length > 0;
  const loadedPlatformCount = PLATFORM_ORDER.length - pendingPlatforms.length;
  const topPlatformPending = pendingPlatforms.includes(topPlatform);
  const topPosts = useMemo(() => rankPostsByPublicMetric(posts).posts, [posts]);
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
      ? editorialWorkflow.schedule.some((item) => item.ideaId === idea.id)
        ? editorialWorkflow.schedule
        : [...editorialWorkflow.schedule, scheduleAcceptedIdea(idea, editorialWorkflow.schedule, now)]
      : editorialWorkflow.schedule.filter((item) => item.ideaId !== idea.id);
    const optimistic = {
      feedback: { ...editorialWorkflow.feedback, [idea.id]: feedback },
      schedule,
    };
    setEditorialWorkflow(optimistic);
    const scheduled = schedule.find((item) => item.ideaId === idea.id);
    setToast(
      decision === "produce" && scheduled
        ? `✅ Acceptée · planifiée automatiquement le ${formatCardPublishedDate(`${scheduled.scheduledFor}T12:00:00.000Z`)}`
        : decision === "rework"
          ? "🛠️ Marquée à retravailler · préférence mémorisée"
          : "✕ Écartée · préférence mémorisée",
    );
    if (previewMode) return;

    try {
      const response = await fetch("/api/editorial-workflow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "decide", idea, decision }),
      });
      const payload = await response.json() as EditorialWorkflowState & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Décision non enregistrée.");
      setEditorialWorkflow(normalizeWorkflowState(payload));
    } catch (decisionError) {
      setEditorialWorkflow(previous);
      setToast(
        decisionError instanceof Error ? decisionError.message : "Décision non enregistrée.",
      );
    } finally {
      editorialWorkflowMutationRef.current = false;
      setEditorialWorkflowSyncing(false);
    }
  }, [editorialWorkflow, previewMode]);

  const rescheduleIdea = useCallback(async (ideaId: string, scheduledFor: string) => {
    if (!previewMode && editorialWorkflowMutationRef.current) {
      setToast("Une modification du planning est déjà en cours.");
      return;
    }
    const previous = editorialWorkflow;
    let optimisticSchedule: ScheduledIdea[];
    try {
      optimisticSchedule = updateScheduledDate(editorialWorkflow.schedule, ideaId, scheduledFor);
    } catch (scheduleError) {
      setToast(scheduleError instanceof Error ? scheduleError.message : "Date invalide.");
      return;
    }
    if (!previewMode) {
      editorialWorkflowMutationRef.current = true;
      setEditorialWorkflowSyncing(true);
    }
    setEditorialWorkflow({ ...editorialWorkflow, schedule: optimisticSchedule });
    setToast(`🗓️ Déplacée au ${formatCardPublishedDate(`${scheduledFor}T12:00:00.000Z`)}`);
    if (previewMode) return;

    try {
      const response = await fetch("/api/editorial-workflow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reschedule", ideaId, scheduledFor }),
      });
      const payload = await response.json() as EditorialWorkflowState & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Planning non enregistré.");
      setEditorialWorkflow(normalizeWorkflowState(payload));
    } catch (scheduleError) {
      setEditorialWorkflow(previous);
      setToast(scheduleError instanceof Error ? scheduleError.message : "Planning non enregistré.");
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
          <div className="brand-mark" aria-hidden="true">
            ◉<span />
          </div>
          <div className="brand-copy">
            <h1>
              Lofi <span>Radar</span>
            </h1>
            <small>Social · Community</small>
          </div>
        </div>

        <div className="radar-switch" aria-label="Choisir une plateforme">
          <a className="youtube" href="../">
            <img src="platforms/youtube.svg" alt="" />
            <span className="platform-label">YouTube</span>
          </a>
          <a className="spotify" href="../spotify/">
            <img src="platforms/spotify.svg" alt="" />
            <span className="platform-label">Spotify</span>
          </a>
          <a className="social on" href="./" aria-current="page">
            <img src="platforms/instagram.svg" alt="" />
            <span className="platform-label">Social</span>
          </a>
        </div>

        <nav className="nav" aria-label="Navigation principale">
          {(["Pilotage"] as const).map((group) => (
            <div className="nav-group" key={group}>
              <div className="nav-label">{group}</div>
              {NAV.filter((item) => item.group === group).map((item) => {
                const isPostsParent = item.id === "top";
                const isRecommendationsParent = item.id === "ideas";
                const isRecommendationsView = view === "ideas" || view === "comments" || view === "trends" || view === "audio-trends";
                const isActive = isPostsParent
                  ? view === "all"
                  : !isRecommendationsParent && view === item.id;
                const isSectionActive = isPostsParent
                  ? view === "top"
                  : isRecommendationsParent && isRecommendationsView;

                return (
                  <div
                    className="nav-entry"
                    key={item.id}
                  >
                    <button
                      className={isActive ? "active" : isSectionActive ? "section-active" : ""}
                      type="button"
                      aria-current={isActive ? "page" : undefined}
                      aria-label={isPostsParent ? "Tous les posts, toutes plateformes confondues" : undefined}
                      onClick={() => {
                        if (isPostsParent) {
                          setView("all");
                          setMobileOpen(false);
                          return;
                        }
                        if (isRecommendationsParent) {
                          setView("ideas");
                          setMobileOpen(false);
                          return;
                        }

                        setView(item.id);
                        setMobileOpen(false);
                      }}
                    >
                      <span className="nav-emoji">{item.emoji}</span>
                      <span className="nav-text">{item.label}</span>
                    </button>

                    {isPostsParent ? (
                      <div
                        className="nav-submenu"
                        id="posts-platform-subnav"
                        role="group"
                        aria-label="Plateformes de Tous les posts"
                      >
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

                    {isRecommendationsParent ? (
                      <div
                        className="nav-submenu"
                        id="recommendations-subnav"
                        role="group"
                        aria-label="Types de recommandations"
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

      <main className="main">
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
          <AudienceDashboard history={initialAudienceHistory} />
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

        {workspace && view === "ideas" ? (
          <div className="recommendations-view">
            <header className="recommendations-heading">
              <h2>Posts recommandés</h2>
            </header>

            <div className="reco-controlbar">
              <div className="reco-status-tabs" role="tablist" aria-label="Statut des recommandations">
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
          <RoadmapBoard
            schedule={editorialWorkflow.schedule}
            syncing={editorialWorkflowSyncing}
            onReschedule={rescheduleIdea}
            onOpenRecommendations={() => {
              setIdeaStatusFilter("pending");
              setView("ideas");
            }}
          />
        ) : null}

        {workspace && view === "top" ? (
          <div className="view-stack top-platform-view">
            <section
              className={`top-ranking-controls tone-${PLATFORM_META[topPlatform].tone}`}
              aria-label="Contrôles du classement"
            >
              <div className="top-duration-control-row">
                <span className="section-kicker">Durée</span>
                <div
                  className="format-filter-tabs top-duration-tabs"
                  aria-label="Filtrer le classement par durée"
                >
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
                <div className="format-filter-tabs top-sort-tabs" role="group" aria-label="Trier les publications">
                  <button className={topSort === "popular" ? "active" : ""} type="button" aria-pressed={topSort === "popular"} onClick={() => setTopSort("popular")}>
                    🏆 Plus populaire
                  </button>
                  <button className={topSort === "recent" ? "active" : ""} type="button" aria-pressed={topSort === "recent"} onClick={() => setTopSort("recent")}>
                    🗓️ Plus récent
                  </button>
                </div>
              </div>

              <div className="top-format-control-row">
                <span className="section-kicker">
                  Catégories {PLATFORM_META[topPlatform].label}
                </span>
                <div
                  className="format-filter-tabs top-format-tabs"
                  role="group"
                  aria-label={`Catégories ${PLATFORM_META[topPlatform].label}`}
                >
                  {categoryFilters(topPlatform).map((filter) => {
                    const loadedCount = topPlatformPosts.filter((post) =>
                      matchesSocialFormatFilter(post, filter.key),
                    ).length;
                    const count =
                      topPlatformPending && topDuration === "all"
                        ? publicFormatCounts?.[topPlatform]?.[filter.key] ?? loadedCount
                        : loadedCount;
                    return (
                      <button
                        className={topFormatFilter === filter.key ? "active" : ""}
                        type="button"
                        aria-pressed={topFormatFilter === filter.key}
                        onClick={() => setTopFormatFilter(filter.key)}
                        key={filter.key}
                      >
                        {filter.emoji} {filter.label} <span>{count}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {topUndatedCount > 0 ? (
                <p className="top-undated-note">
                  ℹ️ {topUndatedCount} post{topUndatedCount > 1 ? "s" : ""} sans date
                  publique {topUndatedCount > 1 ? "restent" : "reste"} disponible{topUndatedCount > 1 ? "s" : ""}
                  uniquement dans All time.
                </p>
              ) : null}
            </section>

            <section
              className={`category-results tone-${PLATFORM_META[topPlatform].tone}`}
              aria-labelledby="active-category-title"
            >
              <header className="category-results-header">
                <div>
                  <span className="section-kicker">Catégorie active</span>
                  <h2 id="active-category-title">
                    {activeTopFormat?.emoji ?? "📂"} {PLATFORM_META[topPlatform].label} · {activeTopFormat?.label ?? topFormatFilter}
                  </h2>
                </div>
              </header>

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
                        ? "Essaie une durée plus large ou reviens à All time."
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
            <section className="top-ranking-controls tone-all all-posts-controls" aria-label="Contrôles de tous les posts">
              <div className="all-posts-heading">
                <span className="section-kicker">Toutes plateformes confondues</span>
                <h2>🌐 Tous les posts</h2>
              </div>

              <div className="top-duration-control-row">
                <span className="section-kicker">Durée</span>
                <div className="format-filter-tabs top-duration-tabs" aria-label="Filtrer tous les posts par durée">
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
                <div className="format-filter-tabs library-sort-tabs" role="group" aria-label="Trier tous les posts">
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

function AudienceDashboard({ history }: { history: AudienceHistory | null }) {
  const [periodKey, setPeriodKey] = useState<AudiencePeriodKey>("30d");
  const period = audiencePeriod(periodKey);

  return (
    <section className="audience-dashboard" aria-labelledby="audience-dashboard-title">
      <header className="audience-dashboard-heading">
        <div>
          <span className="section-kicker">Audience & engagement</span>
          <h2 id="audience-dashboard-title">Tableau de bord</h2>
        </div>
        <span className="audience-refresh-label">
          ↻ Suivi quotidien{history ? ` · ${formatAudienceDate(history.generatedAt)}` : ""}
        </span>
      </header>

      <div className="audience-period-control">
        <span className="section-kicker">Durée</span>
        <div
          className="format-filter-tabs audience-period-tabs"
          role="group"
          aria-label="Période du tableau de bord"
        >
          {AUDIENCE_PERIODS.map((option) => (
            <button
              className={periodKey === option.key ? "active" : ""}
              type="button"
              aria-pressed={periodKey === option.key}
              onClick={() => setPeriodKey(option.key)}
              key={option.key}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="audience-platform-grid">
        {PLATFORM_ORDER.map((platform) => {
          const meta = PLATFORM_META[platform];
          const platformHistory = history?.platforms[platform] ?? null;
          const latest = platformHistory
            ? latestAudienceObservation(platformHistory)
            : null;
          const growth = platformHistory
            ? period.days === null
              ? audienceGrowth(platformHistory)
              : audienceGrowth(platformHistory, {
                  days: period.days,
                })
            : null;
          const engagement = platformHistory?.engagementByPeriod[periodKey] ?? null;
          const points = sampleAudiencePoints(
            audiencePointsForPeriod(platformHistory, latest, period.days),
          );
          const values = points.map((point) => point.followers);
          const minimum = values.length ? Math.min(...values) : 0;
          const maximum = values.length ? Math.max(...values) : 0;

          return (
            <article className={`audience-platform-card tone-${meta.tone}`} key={platform}>
              <header className="audience-platform-head">
                <span className="audience-platform-logo" aria-hidden="true">
                  <img src={`platforms/${platform}.svg`} alt="" width="24" height="24" />
                </span>
                <div>
                  <span className="section-kicker">@{platform === "youtube" ? "LofiGirl" : "lofigirl"}</span>
                  <h3>{meta.label}</h3>
                </div>
                <time dateTime={latest?.capturedAt}>
                  {latest ? formatAudienceDate(latest.capturedAt) : "En attente"}
                </time>
              </header>

              <div className="audience-total-block">
                <span>Total followers</span>
                <strong>{latest ? formatAudienceFollowers(latest) : "—"}</strong>
                <small>
                  {latest
                    ? latest.precision === "exact"
                      ? "Compteur public exact"
                      : latest.precision === "platform-rounded"
                        ? "Compteur arrondi par la plateforme"
                        : "Jalon public vérifié"
                    : "Premier relevé à effectuer"}
                </small>
              </div>

              <div className="audience-evolution-block">
                <div className="audience-metric-heading">
                  <span>Évolution des followers</span>
                  <b className={growth && growth.followersDelta < 0 ? "negative" : "positive"}>
                    {growth ? `${growth.followersDelta >= 0 ? "↗" : "↘"} ${formatAudienceDelta(growth.followersDelta)}` : "—"}
                  </b>
                </div>
                <div className="audience-spark-bars" aria-hidden="true">
                  {points.map((point) => {
                    const height = maximum === minimum
                      ? 62
                      : 24 + ((point.followers - minimum) / (maximum - minimum)) * 76;
                    return (
                      <i
                        key={`${point.capturedAt}:${point.followers}`}
                        style={{ "--audience-bar-height": `${height}%` } as CSSProperties}
                      />
                    );
                  })}
                </div>
                <small>
                  {growth
                    ? `${formatAudiencePercent(growth.ratePercent)} depuis le ${formatAudienceDate(growth.from.capturedAt)}`
                    : latest
                      ? period.days === null
                        ? `Suivi démarré le ${formatAudienceDate(latest.capturedAt)}`
                        : `Historique ${period.label.toLowerCase()} en cours · ${points.length} relevé${points.length > 1 ? "s" : ""}`
                      : "Suivi pas encore démarré"}
                </small>
              </div>

              <div
                className="audience-engagement-block"
                title={`Moyenne des likes et commentaires des posts mesurables sur ${period.label.toLowerCase()}, divisée par le nombre actuel de followers.`}
              >
                <span>Taux d’engagement</span>
                <strong>{engagement ? formatAudiencePercent(engagement.ratePercent) : "—"}</strong>
                <small>
                  {engagement
                    ? `${engagement.sampleSize} posts mesurables · ${period.label}`
                    : `Aucun post mesurable · ${period.label}`}
                </small>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function audiencePointsForPeriod(
  platformHistory: AudienceHistory["platforms"][Platform] | null,
  latest: AudienceObservation | null,
  days: number | null,
) {
  if (!platformHistory || !latest) return [];
  const latestTime = Date.parse(latest.capturedAt);
  const minimumTime = days === null
    ? Number.NEGATIVE_INFINITY
    : latestTime - days * 24 * 60 * 60 * 1_000;
  return platformHistory.observations.filter((observation) => {
    const capturedTime = Date.parse(observation.capturedAt);
    return capturedTime >= minimumTime && capturedTime <= latestTime;
  });
}

function sampleAudiencePoints(points: AudienceObservation[], maximum = 24) {
  if (points.length <= maximum) return points;
  return Array.from({ length: maximum }, (_, index) => {
    const sourceIndex = Math.round((index * (points.length - 1)) / (maximum - 1));
    return points[sourceIndex];
  });
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
  const absolute = Math.abs(value);
  const formatted = new Intl.NumberFormat("fr-FR", {
    notation: absolute >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(absolute);
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
  const [characterFilter, setCharacterFilter] = useState<TrendCharacterFilter>("all");
  const [activeTrend, setActiveTrend] = useState<SocialTrend | null>(null);
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);
  const [freshnessCheckedAt, setFreshnessCheckedAt] = useState(Date.now);
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
  const proposalCount = useMemo(
    () => selectedVideoTrends.reduce((total, trend) => total + trend.proposals.length, 0),
    [selectedVideoTrends],
  );
  const visibleTrends = useMemo(
    () => {
      if (platformFilter === "all" && characterFilter === "all") {
        return orderedVideoTrends;
      }
      const filtered = filterSocialTrends(selectedVideoTrends, {
        platform: platformFilter,
        character: characterFilter,
      });
      return [
        ...filtered.filter((trend) => matchedTrendIds.has(trend.id)),
        ...filtered.filter((trend) => !matchedTrendIds.has(trend.id)),
      ];
    },
    [characterFilter, matchedTrendIds, orderedVideoTrends, platformFilter, selectedVideoTrends],
  );
  const editorialScanDate = formatTrendEditorialScanDate(feed?.capturedAt);
  const refreshIsLate = isTrendEditorialScanLate(feed?.capturedAt, freshnessCheckedAt);
  const dailyScanDate = formatTrendEditorialScanDate(scanStatus?.discoveryAudit.scannedAt);
  const dailyScanIsLate = isScanLate(scanStatus?.discoveryAudit.scannedAt, freshnessCheckedAt);

  useEffect(() => {
    const interval = window.setInterval(
      () => setFreshnessCheckedAt(Date.now()),
      60 * 60 * 1_000,
    );
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="trend-feed-view">
      <header className="trend-feed-heading">
        <div>
          <span className="section-kicker">Veille éditoriale quotidienne · focus Lofi Girl</span>
          <h2>Trends vidéos</h2>
          <p>
            Un exemple performant par trend, uniquement si la même mécanique a été reprise par plusieurs créateurs. Lofi Girl reste prioritaire.
          </p>
        </div>
        {scanStatus && dailyScanDate ? (
          <span className={`trend-snapshot-pill ${dailyScanIsLate ? "is-late" : ""}`}>
            Scan 24 h : {scanStatus.discoveryAudit.candidateCount} signaux · {scanStatus.discoveryAudit.qualifiedInventoryCount} cartes retrouvées · {dailyScanDate}
          </span>
        ) : null}
      </header>

      {feed && editorialScanDate ? (
        <div className={`trend-scan-summary ${refreshIsLate ? "is-degraded" : ""}`} role="status">
          <div>
            <b>{dailyScanIsLate ? "Scan quotidien en retard" : "Scan quotidien effectué"}</b>
            <span>Dernier lot complet : {editorialScanDate} · {selectedVideoTrends.length} cartes · {proposalCount} adaptations</span>
          </div>
          <p>
            {refreshIsLate
              ? `${scanStatus?.discoveryAudit.qualifiedInventoryCount ?? 0}/50 cartes de l’inventaire ont été retrouvées dans les sources du jour. Le lot complet précédent reste affiché pour ne pas présenter des candidats non qualifiés comme des trends.`
              : "Le lot affiché a passé les contrôles multi-créateurs, métriques et durée."}
          </p>
        </div>
      ) : null}

      {scanStatus?.discoveryAudit.candidateUrls.length ? (
        <DailyCandidateLinks
          title="Nouveaux signaux vidéo détectés au dernier scan"
          urls={scanStatus.discoveryAudit.candidateUrls}
        />
      ) : null}

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
        <div className="trend-filter-group">
          <span>Univers</span>
          <div className="trend-filter-tabs" role="group" aria-label="Filtrer par univers">
            {TREND_CHARACTER_FILTERS.map((option) => (
              <button
                className={characterFilter === option.key ? "active" : ""}
                type="button"
                aria-pressed={characterFilter === option.key}
                onClick={() => {
                  setActivePlayerId(null);
                  setCharacterFilter(option.key);
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
              scanMatched={matchedTrendIds.has(trend.id)}
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
              setCharacterFilter("all");
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

function DailyCandidateLinks({ title, urls }: { title: string; urls: readonly string[] }) {
  const visibleUrls = urls.slice(0, TREND_CANDIDATE_PREVIEW_LIMIT);
  return (
    <section className="trend-candidate-panel" aria-label={title}>
      <div className="trend-candidate-panel-heading">
        <div>
          <b>{title}</b>
          <span>Ces liens sont des candidats récents, pas encore des trends qualifiées.</span>
        </div>
        <span>{urls.length} détectés</span>
      </div>
      <div className="trend-candidate-links">
        {visibleUrls.map((url, index) => {
          const platform = trendPlatformFromUrl(url);
          return (
            <a href={url} target="_blank" rel="noreferrer" key={url}>
              {platform ? (
                <img src={`platforms/${platform}.svg`} alt="" width="17" height="17" />
              ) : null}
              Signal {index + 1}
            </a>
          );
        })}
        {urls.length > visibleUrls.length ? (
          <span className="trend-candidate-overflow">+{urls.length - visibleUrls.length} autres</span>
        ) : null}
      </div>
    </section>
  );
}

function trendPlatformFromUrl(candidate: string): TrendPlatform | null {
  try {
    const host = new URL(candidate).hostname.toLowerCase();
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok";
    if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return "youtube";
    if (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com") return "x";
    return null;
  } catch {
    return null;
  }
}

function TrendFeedCard({
  trend,
  rank,
  onOpenDetails,
  playerActive,
  onActivatePlayer,
  onClosePlayer,
  scanMatched,
  feedCapturedAt,
}: {
  trend: SocialTrend;
  rank: number;
  onOpenDetails: (trend: SocialTrend) => void;
  playerActive: boolean;
  onActivatePlayer: () => void;
  onClosePlayer: () => void;
  scanMatched: boolean;
  feedCapturedAt: string;
}) {
  const lifecycle = TREND_LIFECYCLE_META[trend.lifecycle];
  const character = TREND_CHARACTER_META[trend.character];
  const referencePost = trend.referencePost;
  const [activeProposalIndex, setActiveProposalIndex] = useState(() =>
    dailyRotationIndex(trend.id, feedCapturedAt, trend.proposals.length),
  );
  if (!referencePost) return null;
  const publishedDate = formatCardPublishedDate(referencePost.publishedAt);
  const footerMetrics = trendReferenceFooterMetrics(referencePost);
  const activeProposal = trend.proposals[activeProposalIndex] ?? trend.proposals[0];
  const reuseCount = trend.reuseEvidence?.posts.length ?? 0;

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
          <span className={`status-badge tone-${lifecycle.tone}`}>
            {lifecycle.emoji} {lifecycle.label}
          </span>
        </div>
        <span className="trend-reuse-pill">
          🔥 Repris par {reuseCount}+ créateurs
        </span>
        <span className={`trend-scan-card-state ${scanMatched ? "is-current" : "is-retained"}`}>
          {scanMatched ? "Retrouvée dans le scan du jour" : "Conservée du dernier lot complet"}
        </span>
        <div className="post-card-title">
          <div className="post-media-caption">
            <span className="trend-card-source-title">{character.emoji} {character.label} · {trend.territory}</span>
            <span className="trend-proposal-title">{activeProposal?.title ?? trend.title}</span>
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
          <div>
            <span>{trendPlatformEmoji(referencePost.platform)} Fiche trend · {lifecycle.emoji} {lifecycle.label}</span>
            <h2 id={titleId}>{trend.title}</h2>
            <small className="details-theme-label">{character.emoji} {character.detailLabel} · potentiel {trendPriorityScore(trend)}/100</small>
          </div>
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

        <div className="post-observation-grid">
          <div>
            <span>Publié</span>
            <b>{formatDetailedDate(referencePost.publishedAt)}</b>
            <small>{referencePost.selectionLabel}</small>
          </div>
          <div>
            <span>Potentiel</span>
            <b>{trendPriorityScore(trend)}/100</b>
            <small>Momentum, fit avec l’univers Lofi et saturation</small>
          </div>
          <div>
            <span>Stade</span>
            <b>{lifecycle.emoji} {lifecycle.label}</b>
            <small>{trend.timing}</small>
          </div>
          <div>
            <span>Créateurs vérifiés</span>
            <b>🔥 {reuseEvidence?.posts.length ?? 0}</b>
            <small>Adaptations natives distinctes</small>
          </div>
        </div>

        {reuseEvidence ? (
          <section className="trend-reuse-proof" aria-label="Preuve de reprise par plusieurs créateurs">
            <header>
              <div>
                <span className="section-kicker">Vraie trend, pas simple post viral</span>
                <h4>🔥 Reprise par plusieurs créateurs</h4>
              </div>
              <time dateTime={reuseEvidence.verifiedAt}>{formatDetailedDate(reuseEvidence.verifiedAt)}</time>
            </header>
            <p>{reuseEvidence.summary}</p>
            <div className="trend-reuse-creators">
              {reuseEvidence.posts.map((post) => {
                const isReference = post.url === referencePost.url;
                return (
                  <a href={post.url} target="_blank" rel="noreferrer" key={`${post.platform}:${post.url}`}>
                    <span>{trendPlatformEmoji(post.platform)}</span>
                    <b>{post.author}</b>
                    <small>{isReference ? "Exemple principal" : "Reprise vérifiée"} ↗</small>
                  </a>
                );
              })}
            </div>
          </section>
        ) : null}

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

        <div className="trend-detail-grid">
          <section><span>🧩 Ce qui se répète</span><p>{trend.mechanic}</p></section>
          <section><span>{character.emoji} Pourquoi {character.detailLabel}</span><p>{trend.whyLofi}</p></section>
          <section><span>⏱️ Bon moment</span><p>{trend.timing}</p></section>
          <section><span>🎬 À produire</span><p>{trend.production}</p></section>
        </div>

        <div className="trend-tags" aria-label="Mots-clés observés">
          <span>{trendTypeLabel(trend.type)}</span>
          {trend.keywords.map((keyword) => <span key={keyword}>#{keyword.replace(/^#/, "")}</span>)}
        </div>

        <section className="trend-proof-section">
          <header>
            <div><span className="section-kicker">Preuves observées</span><h4>🔎 D’où vient le signal</h4></div>
          </header>
          <ul className="trend-proof-list">
            {trend.observations.map((observation) => {
              const observationMetrics = trendObservationMetrics(observation);
              return (
                <li key={observation.id}>
                  <div>
                    <span className="trend-proof-platform">{trendPlatformEmoji(observation.platform)} {trendPlatformLabel(observation.platform)}</span>
                    <span className="trend-proof-window">{observation.windowLabel}</span>
                    <span className={`trend-proof-exactness exactness-${observation.exactness}`}>{trendObservationEvidenceLabel(observation.exactness)}</span>
                  </div>
                  <p>{observation.signal}</p>
                  {observationMetrics.length ? <div className="trend-proof-metrics">{observationMetrics.map((metric) => <span key={metric}>{metric}</span>)}</div> : null}
                  <a href={observation.sourceUrl} target="_blank" rel="noreferrer">{observation.sourceLabel} ↗</a>
                </li>
              );
            })}
          </ul>
        </section>

        <p className="trend-caveat">ℹ️ {trend.caveat}</p>
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

function trendTypeLabel(type: SocialTrend["type"]) {
  const labels: Record<SocialTrend["type"], string> = {
    hashtag: "Hashtag",
    sound: "Son",
    "spoken-audio": "Audio parlé",
    "meme-template": "Mème",
    format: "Format",
    moment: "Moment culturel",
  };
  return labels[type];
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

function trendObservationMetrics(observation: SocialTrend["observations"][number]) {
  return [
    observation.rank !== null ? `Rang #${formatNumber(observation.rank)}` : null,
    observation.posts !== null ? `${formatNumber(observation.posts)} posts` : null,
    observation.views !== null ? `${formatNumber(observation.views)} vues` : null,
    observation.uses !== null ? `${formatNumber(observation.uses)} utilisations` : null,
  ].filter((metric): metric is string => metric !== null);
}

function trendObservationEvidenceLabel(
  exactness: SocialTrend["observations"][number]["exactness"],
) {
  if (exactness === "exact") return "Mesure plateforme";
  if (exactness === "platform-estimate") return "Compteur public arrondi";
  return "Signal éditorial sourcé";
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

function RoadmapBoard({
  schedule,
  syncing,
  onReschedule,
  onOpenRecommendations,
}: {
  schedule: ScheduledIdea[];
  syncing: boolean;
  onReschedule: (ideaId: string, scheduledFor: string) => void;
  onOpenRecommendations: () => void;
}) {
  const now = new Date();
  const [scale, setScale] = useState<RoadmapScale>("year");
  const [displayMode, setDisplayMode] = useState<RoadmapDisplayMode>("calendar");
  const [cursorYear, setCursorYear] = useState(now.getFullYear());
  const [cursorMonth, setCursorMonth] = useState(now.getMonth());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const closeSelectedDay = useCallback(() => setSelectedDay(null), []);
  const sortedSchedule = [...schedule].sort((left, right) =>
    left.scheduledFor.localeCompare(right.scheduledFor) || left.ideaId.localeCompare(right.ideaId),
  );
  const filteredSchedule = sortedSchedule.filter((item) => {
    const yearMatches = Number(item.scheduledFor.slice(0, 4)) === cursorYear;
    if (!yearMatches) return false;
    return scale === "year" || Number(item.scheduledFor.slice(5, 7)) - 1 === cursorMonth;
  });
  const scheduleByDate = new Map<string, ScheduledIdea[]>();
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
        <h2>Roadmap</h2>
        {syncing ? <span className="workflow-syncing">Synchronisation…</span> : null}
      </header>

      <div className="roadmap-controls">
        <div className="roadmap-scale-toggle" aria-label="Période de la roadmap">
          <button className={scale === "month" ? "active" : ""} type="button" onClick={() => setScale("month")}>Mois</button>
          <button className={scale === "year" ? "active" : ""} type="button" onClick={() => setScale("year")}>Année</button>
        </div>
        <div className="roadmap-period-navigation">
          <button type="button" aria-label="Période précédente" onClick={() => movePeriod(-1)}>‹</button>
          <strong>{periodLabel}</strong>
          <button type="button" aria-label="Période suivante" onClick={() => movePeriod(1)}>›</button>
        </div>
        <div className="roadmap-display-toggle" aria-label="Affichage de la roadmap">
          <button className={displayMode === "list" ? "active" : ""} type="button" aria-label="Liste" onClick={() => setDisplayMode("list")}>☰</button>
          <button className={displayMode === "calendar" ? "active" : ""} type="button" aria-label="Calendrier" onClick={() => setDisplayMode("calendar")}>▣</button>
        </div>
      </div>

      {displayMode === "list" ? (
        <RoadmapList
          items={filteredSchedule}
          syncing={syncing}
          onReschedule={onReschedule}
          onOpenRecommendations={onOpenRecommendations}
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

      {!schedule.length ? (
        <button className="roadmap-empty-cta" type="button" onClick={onOpenRecommendations}>
          💡 Valider une recommandation pour remplir la roadmap
        </button>
      ) : null}

      <RoadmapDayModal
        date={selectedDay}
        items={selectedItems}
        syncing={syncing}
        onReschedule={(ideaId, scheduledFor) => {
          onReschedule(ideaId, scheduledFor);
          closeSelectedDay();
        }}
        onClose={closeSelectedDay}
      />
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
  scheduleByDate: Map<string, ScheduledIdea[]>;
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
  scheduleByDate: Map<string, ScheduledIdea[]>;
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
  syncing,
  onReschedule,
  onOpenRecommendations,
}: {
  items: ScheduledIdea[];
  syncing: boolean;
  onReschedule: (ideaId: string, scheduledFor: string) => void;
  onOpenRecommendations: () => void;
}) {
  if (!items.length) {
    return (
      <div className="empty-state roadmap-list-empty">
        <span>🗓️</span>
        <h3>Aucune publication sur cette période</h3>
        <p>Valide une recommandation ou change de période.</p>
        <button className="button primary" type="button" onClick={onOpenRecommendations}>Voir les recommandations</button>
      </div>
    );
  }

  return (
    <div className="roadmap-list">
      {items.map((item) => (
        <article className="roadmap-list-card" key={item.id}>
          <time dateTime={item.scheduledFor}>
            <b>{item.scheduledFor.slice(8, 10)}</b>
            <span>{new Intl.DateTimeFormat("fr-FR", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${item.scheduledFor}T12:00:00.000Z`))}</span>
          </time>
          <span className="roadmap-list-platform" aria-hidden="true">✦</span>
          <div>
            <small>Publication commune</small>
            <h3>{recommendationDisplayTitle(item.title)}</h3>
            <p>« {item.hook} »</p>
          </div>
          <label>
            Modifier la date
            <input
              type="date"
              disabled={syncing}
              value={item.scheduledFor}
              onChange={(event) => onReschedule(item.ideaId, event.target.value)}
            />
          </label>
        </article>
      ))}
    </div>
  );
}

function RoadmapDayModal({
  date,
  items,
  syncing,
  onReschedule,
  onClose,
}: {
  date: string | null;
  items: ScheduledIdea[];
  syncing: boolean;
  onReschedule: (ideaId: string, scheduledFor: string) => void;
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
        modalRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') ?? [],
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
              <span>✦</span>
              <div>
                <small>Publication commune</small>
                <h3>{recommendationDisplayTitle(item.title)}</h3>
                <p>« {item.hook} »</p>
              </div>
              <label>
                Modifier la date
                <input
                  type="date"
                  disabled={syncing}
                  value={item.scheduledFor}
                  onChange={(event) => onReschedule(item.ideaId, event.target.value)}
                />
              </label>
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
  const [isTextExpanded, setIsTextExpanded] = useState(false);
  const canExpandText =
    postCopy.length > (hasMediaPreview ? 70 : 120) ||
    postCopy.split(/\r?\n/).length > 2;
  const footerMetrics = [
    post.views !== null ? { icon: metricEmoji("views", post.platform), label: "vues", value: post.views } : null,
    post.likes !== null ? { icon: metricEmoji("likes", post.platform), label: "likes", value: post.likes } : null,
  ].filter(Boolean) as Array<{ icon: string; label: string; value: number }>;

  return (
    <article
      className={`social-post-card ${compact ? "compact" : ""} ${hasMediaPreview ? "has-media" : "text-only"} ${choices.length ? "poll-card" : ""}`}
    >
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
              <div className={`post-media-caption ${isTextExpanded ? "is-expanded" : ""}`}>
                <h3>
                  <a href={post.url} target="_blank" rel="noreferrer">
                    {postCopy}
                  </a>
                </h3>
                {canExpandText ? (
                  <button
                    className="post-text-expand"
                    type="button"
                    aria-expanded={isTextExpanded}
                    aria-label={isTextExpanded ? "Réduire la légende" : "Voir toute la légende"}
                    onClick={() => setIsTextExpanded((value) => !value)}
                  >
                    {isTextExpanded ? "Voir moins" : "… Voir plus"}
                  </button>
                ) : null}
              </div>
            ) : (
              <div className={`post-text-content ${isTextExpanded ? "is-expanded" : ""}`}>
                <a href={post.url} target="_blank" rel="noreferrer">
                  {postCopy}
                </a>
                {canExpandText ? (
                  <button
                    className="post-text-expand"
                    type="button"
                    aria-expanded={isTextExpanded}
                    aria-label={isTextExpanded ? "Réduire le texte" : "Voir tout le texte"}
                    onClick={() => setIsTextExpanded((value) => !value)}
                  >
                    {isTextExpanded ? "Voir moins" : "… Voir plus"}
                  </button>
                ) : null}
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
              <span key={metric.label} title={metric.label}>
                {metric.icon} <b>{formatNumber(metric.value)}</b>
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
  const lastValue = primaryMetric && lastPoint ? lastPoint[primaryMetric] : null;
  const totalDelta = firstValue !== null && lastValue !== null ? lastValue - firstValue : null;
  const nearLaunch = isNearLaunchObservation(post, firstPoint?.captured_at);
  const detailTheme = postLabel(post, editorialAnalysis);
  const editorialAnalysisId = `details-editorial-${post.platform}-${post.external_post_id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
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

        <section className="metric-evolution" aria-labelledby="metric-evolution-title">
          <div className="details-section-heading">
            <div>
              <span className="section-kicker">Évolution mesurée</span>
              <h3 id="metric-evolution-title">
                {primaryMetric ? `${METRIC_META[primaryMetric].icon} ${METRIC_META[primaryMetric].label}` : "Aucune métrique publique"}
              </h3>
            </div>
            {totalDelta !== null && timelinePoints.length > 1 ? (
              <span className={`metric-delta ${totalDelta >= 0 ? "positive" : "negative"}`}>
                {totalDelta >= 0 ? "+" : ""}{formatNumber(totalDelta)} depuis le premier relevé
              </span>
            ) : null}
          </div>
          {timelinePoints.length > 1 && primaryMetric ? (
            <div className="metric-timeline">
              {timelinePoints.slice(-8).map((point, index, points) => {
                const value = point[primaryMetric];
                const previousValue = index > 0 ? points[index - 1][primaryMetric] : null;
                const delta = value !== null && previousValue !== null ? value - previousValue : null;
                return (
                  <div key={`${point.source}:${point.captured_at}`}>
                    <span>{formatDetailedDate(point.captured_at)}</span>
                    <b>{formatNumber(value)}</b>
                    <small>
                      {delta === null || index === 0
                        ? "Premier point affiché"
                        : `${delta >= 0 ? "+" : ""}${formatNumber(delta)}`}
                    </small>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="metric-history-empty">
              <span>📍</span>
              <div>
                <b>Un seul relevé disponible pour l’instant</b>
                <p>La progression s’affichera automatiquement dès le prochain scan. Le radar ne reconstruit pas une courbe passée qu’il n’a pas observée.</p>
              </div>
            </div>
          )}
        </section>

        {editorialAnalysis ? (
          <section
            className={`editorial-why details-editorial-why status-${editorialAnalysis.status}`}
            aria-labelledby={editorialAnalysisId}
          >
            <div className="editorial-why-heading">
              <span id={editorialAnalysisId}>🧠 Pourquoi ça ressort</span>
              <small>
                {editorialAnalysis.status === "no-differentiator"
                  ? "Différence non isolée"
                  : editorialAnalysis.confidence === "medium"
                    ? "Comparaison étayée"
                    : "Hypothèse prudente"}
              </small>
            </div>
            <h4>{editorialAnalysis.headline}</h4>
            <p>{editorialAnalysis.mechanism}</p>
            <div className="editorial-why-comparison">
              <b>Ce qui le différencie</b>
              <span>{editorialAnalysis.comparison}</span>
            </div>
            <div className="editorial-why-lesson">
              <b>À reproduire</b>
              <span>{editorialAnalysis.transferableLesson}</span>
            </div>
            {editorialAnalysis.limitations[0] ? (
              <small className="editorial-why-limit">
                Périmètre : {editorialAnalysis.limitations[0]}
              </small>
            ) : null}
          </section>
        ) : null}

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
