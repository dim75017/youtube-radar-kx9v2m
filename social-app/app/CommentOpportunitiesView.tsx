"use client";

/* eslint-disable @next/next/no-img-element -- platform logos and live social previews use public assets. */

import { useEffect, useMemo, useState } from "react";

import {
  commentOpportunityGoldenWindow,
  commentOpportunityRankScore,
  COMMENT_OPPORTUNITY_CATEGORY_LABELS,
  COMMENT_OPPORTUNITY_MOMENT_TIER_LABELS,
  rankCommentOpportunities,
  type CommentOpportunity,
  type CommentOpportunityCategory,
  type CommentOpportunityFeed,
  type CommentOpportunityGoldenWindow,
  type CommentOpportunityMomentTier,
  type CommentOpportunityPlatform,
  type CommentOpportunityTone,
} from "../lib/comment-opportunities";

type PlatformFilter = CommentOpportunityPlatform | "all";
type TierFilter = CommentOpportunityMomentTier | "all";
type CategoryFilter = CommentOpportunityCategory | "all";
type OpportunitySort = "urgency" | "priority" | "recent";
type QueueFilter = "pending" | "done" | "skipped";
type QueueState = Exclude<QueueFilter, "pending">;

const COMMENT_QUEUE_STORAGE_KEY = "lofi-social-radar:comment-opportunity-statuses:v1";
/** The countdown has to move on its own, or nobody trusts it. */
const CLOCK_TICK_MS = 30_000;

const PLATFORM_OPTIONS: Array<{
  key: PlatformFilter;
  label: string;
  logo: string | null;
}> = [
  { key: "all", label: "Toutes", logo: null },
  { key: "youtube", label: "YouTube", logo: "platforms/youtube.svg" },
  { key: "instagram", label: "Instagram", logo: "platforms/instagram.svg" },
  { key: "tiktok", label: "TikTok", logo: "platforms/tiktok.svg" },
  { key: "x", label: "X", logo: "platforms/x.svg" },
];

const TIER_OPTIONS: Array<{ key: TierFilter; label: string }> = [
  { key: "all", label: "Tous les paliers" },
  { key: "s", label: "Moments majeurs" },
  { key: "a", label: "Gros buzz" },
  { key: "b", label: "Veille" },
];

const TONE_META: Record<CommentOpportunityTone, { label: string; marker: string }> = {
  funny: { label: "Drôle", marker: "☺" },
  smart: { label: "Smart", marker: "✦" },
  complice: { label: "Complice", marker: "↳" },
};

const STATUS_META: Record<CommentOpportunity["status"], { label: string; className: string }> = {
  surging: { label: "Accélère", className: "surging" },
  hot: { label: "À saisir", className: "hot" },
  watch: { label: "À surveiller", className: "watch" },
};

const VELOCITY_METRIC_LABELS: Record<"views" | "likes" | "comments", string> = {
  views: "vues",
  likes: "likes",
  comments: "comm.",
};

export function CommentOpportunitiesView({
  feed,
  loading,
  error,
}: {
  feed: CommentOpportunityFeed | null;
  loading: boolean;
  error: string;
}) {
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [sort, setSort] = useState<OpportunitySort>("urgency");
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("pending");
  const [queueStates, setQueueStates] = useState<Record<string, QueueState>>({});
  const [queueReady, setQueueReady] = useState(false);
  const [nowIso, setNowIso] = useState(() => feed?.capturedAt ?? new Date().toISOString());

  useEffect(() => {
    const syncClock = () => setNowIso(new Date().toISOString());
    syncClock();
    const ticker = window.setInterval(syncClock, CLOCK_TICK_MS);
    return () => window.clearInterval(ticker);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = window.localStorage.getItem(COMMENT_QUEUE_STORAGE_KEY);
        const value = stored ? JSON.parse(stored) as Record<string, unknown> : {};
        const next: Record<string, QueueState> = {};
        for (const [id, state] of Object.entries(value)) {
          if (state === "done" || state === "skipped") next[id] = state;
        }
        setQueueStates(next);
      } catch {
        setQueueStates({});
      } finally {
        setQueueReady(true);
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!queueReady) return;
    try {
      window.localStorage.setItem(COMMENT_QUEUE_STORAGE_KEY, JSON.stringify(queueStates));
    } catch {
      // The queue remains usable in memory when browser storage is unavailable.
    }
  }, [queueReady, queueStates]);

  const ranked = useMemo(
    () => rankCommentOpportunities(feed?.opportunities ?? [], feed?.capturedAt),
    [feed?.capturedAt, feed?.opportunities],
  );

  const windows = useMemo(() => {
    const map = new Map<string, CommentOpportunityGoldenWindow>();
    for (const opportunity of ranked) {
      map.set(opportunity.id, commentOpportunityGoldenWindow(opportunity, nowIso));
    }
    return map;
  }, [nowIso, ranked]);

  const availableCategories = useMemo(() => {
    const present = new Set<CommentOpportunityCategory>();
    for (const opportunity of ranked) present.add(opportunity.category);
    return (Object.keys(COMMENT_OPPORTUNITY_CATEGORY_LABELS) as CommentOpportunityCategory[])
      .filter((category) => present.has(category));
  }, [ranked]);

  /** The radar line: what is big and still open, right now. */
  const liveDrops = useMemo(
    () =>
      ranked.filter((opportunity) => {
        const window = windows.get(opportunity.id);
        return !(opportunity.id in queueStates) &&
          opportunity.momentTier !== "b" &&
          (window?.state === "open" || window?.state === "closing");
      }),
    [queueStates, ranked, windows],
  );

  const counts = useMemo(() => {
    const result = { pending: 0, done: 0, skipped: 0 };
    for (const opportunity of ranked) {
      const state = queueStates[opportunity.id] ?? "pending";
      result[state] += 1;
    }
    return result;
  }, [queueStates, ranked]);

  const visibleOpportunities = useMemo(() => {
    const filtered = ranked.filter((opportunity) => {
      const state = queueStates[opportunity.id] ?? "pending";
      return (platformFilter === "all" || opportunity.platform === platformFilter) &&
        (tierFilter === "all" || opportunity.momentTier === tierFilter) &&
        (categoryFilter === "all" || opportunity.category === categoryFilter) &&
        state === queueFilter;
    });
    if (sort === "recent") {
      return filtered.toSorted((left, right) => timestamp(right.publishedAt) - timestamp(left.publishedAt));
    }
    if (sort === "urgency") {
      // Still-open windows first, then the heaviest moment, then the least time
      // left. Weighing the window before the tier would put a minor post that
      // closes in ten minutes above a major drop that is still wide open.
      return filtered.toSorted((left, right) => {
        const leftWindow = windows.get(left.id);
        const rightWindow = windows.get(right.id);
        const openGap = windowGroup(leftWindow) - windowGroup(rightWindow);
        if (openGap !== 0) return openGap;
        const tierGap = TIER_URGENCY[left.momentTier] - TIER_URGENCY[right.momentTier];
        if (tierGap !== 0) return tierGap;
        const leftLeft = leftWindow?.remainingMinutes ?? Number.MAX_SAFE_INTEGER;
        const rightLeft = rightWindow?.remainingMinutes ?? Number.MAX_SAFE_INTEGER;
        if (leftLeft !== rightLeft) return leftLeft - rightLeft;
        return (
          commentOpportunityRankScore(right, feed?.capturedAt ?? right.capturedAt) -
          commentOpportunityRankScore(left, feed?.capturedAt ?? left.capturedAt)
        );
      });
    }
    return filtered;
  }, [categoryFilter, feed?.capturedAt, platformFilter, queueFilter, queueStates, ranked, sort, tierFilter, windows]);

  const updateQueue = (id: string, state: QueueState | "pending") => {
    setQueueStates((current) => {
      if (state === "pending") {
        const next = { ...current };
        delete next[id];
        return next;
      }
      return { ...current, [id]: state };
    });
  };

  const refreshLabel = feed ? formatRefreshDate(feed.capturedAt) : null;
  const coveredPlatforms = feed?.sourceChecks.filter((item) => item.status !== "failed").length ?? 0;
  const fastLaneLabel = feed?.fastLaneCheckedAt
    ? formatElapsed(feed.fastLaneCheckedAt, nowIso)
    : null;

  return (
    <div className="comment-opportunities-view">
      <header className="comment-feed-heading">
        <div>
          <span className="section-kicker">
            Veille drops · watchlist toutes les {feed?.fastLaneMinutes ?? 15} min · veille large toutes les {feed?.cadenceHours ?? 6} h
          </span>
          <h2>Commentaires à poster maintenant</h2>
          <p>
            Les contenus qui viennent de tomber, classés par temps qu’il reste pour être vu. Trois réactions
            Lofi Girl prêtes à copier. Rien n’est publié automatiquement.
          </p>
        </div>
        {feed && refreshLabel ? (
          <span className="comment-snapshot-pill">
            {refreshLabel} · {feed.opportunities.length} vidéos · {coveredPlatforms}/4 réseaux
            {feed.watchlistAccountCount > 0 ? ` · ${feed.watchlistAccountCount} comptes suivis` : ""}
            {fastLaneLabel ? ` · voie rapide ${fastLaneLabel}` : ""}
          </span>
        ) : null}
      </header>

      {liveDrops.length > 0 ? (
        <section className="comment-drops-strip" aria-label="Drops en cours">
          <div className="comment-drops-head">
            <span className="comment-drops-title">
              <span aria-hidden="true">◉</span> {liveDrops.length} {liveDrops.length > 1 ? "drops en cours" : "drop en cours"}
            </span>
            <span className="comment-drops-hint">Fenêtre encore ouverte pour être lu en haut de section</span>
          </div>
          <div className="comment-drops-rail">
            {liveDrops.slice(0, 6).map((opportunity) => (
              <DropChip
                opportunity={opportunity}
                window={windows.get(opportunity.id)}
                key={opportunity.id}
              />
            ))}
          </div>
        </section>
      ) : null}

      <div className="comment-feed-toolbar">
        <div className="comment-platform-tabs" role="group" aria-label="Filtrer les commentaires par plateforme">
          {PLATFORM_OPTIONS.map((option) => (
            <button
              className={platformFilter === option.key ? "active" : ""}
              type="button"
              aria-pressed={platformFilter === option.key}
              onClick={() => setPlatformFilter(option.key)}
              key={option.key}
            >
              {option.logo ? <img src={option.logo} alt="" /> : <span aria-hidden="true">◆</span>}
              {option.label}
            </button>
          ))}
        </div>
        <div className="comment-sort-tabs" role="group" aria-label="Trier les opportunités de commentaires">
          <button className={sort === "urgency" ? "active" : ""} type="button" aria-pressed={sort === "urgency"} onClick={() => setSort("urgency")}>Fenêtre</button>
          <button className={sort === "priority" ? "active" : ""} type="button" aria-pressed={sort === "priority"} onClick={() => setSort("priority")}>Potentiel</button>
          <button className={sort === "recent" ? "active" : ""} type="button" aria-pressed={sort === "recent"} onClick={() => setSort("recent")}>Plus récents</button>
        </div>
      </div>

      <div className="comment-facet-row">
        <div className="comment-tier-tabs" role="group" aria-label="Filtrer par palier de moment">
          {TIER_OPTIONS.map((option) => (
            <button
              className={tierFilter === option.key ? `active tier-${option.key}` : `tier-${option.key}`}
              type="button"
              aria-pressed={tierFilter === option.key}
              onClick={() => setTierFilter(option.key)}
              key={option.key}
            >
              {option.label}
            </button>
          ))}
        </div>
        {availableCategories.length > 1 ? (
          <div className="comment-category-tabs" role="group" aria-label="Filtrer par thème">
            <button className={categoryFilter === "all" ? "active" : ""} type="button" aria-pressed={categoryFilter === "all"} onClick={() => setCategoryFilter("all")}>Tous les thèmes</button>
            {availableCategories.map((category) => (
              <button
                className={categoryFilter === category ? "active" : ""}
                type="button"
                aria-pressed={categoryFilter === category}
                onClick={() => setCategoryFilter(category)}
                key={category}
              >
                {COMMENT_OPPORTUNITY_CATEGORY_LABELS[category]}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="comment-queue-tabs" role="tablist" aria-label="État de la file de commentaires">
        <button className={queueFilter === "pending" ? "active" : ""} type="button" role="tab" aria-selected={queueFilter === "pending"} onClick={() => setQueueFilter("pending")}>À commenter <b>{counts.pending}</b></button>
        <button className={queueFilter === "done" ? "active" : ""} type="button" role="tab" aria-selected={queueFilter === "done"} onClick={() => setQueueFilter("done")}>Faits <b>{counts.done}</b></button>
        <button className={queueFilter === "skipped" ? "active" : ""} type="button" role="tab" aria-selected={queueFilter === "skipped"} onClick={() => setQueueFilter("skipped")}>Passés <b>{counts.skipped}</b></button>
      </div>

      {error ? (
        <div className="trend-feed-notice" role="status">
          <span aria-hidden="true">⚠</span>
          <p>{feed ? "La dernière veille reste affichée ; l’actualisation a échoué." : error}</p>
        </div>
      ) : null}

      {loading && !feed ? (
        <div className="trend-feed-loading" role="status">
          <span aria-hidden="true">⏳</span>
          <div><b>Lecture des vidéos qui percent</b><p>Les opportunités les plus commentables sont en cours de classement.</p></div>
        </div>
      ) : visibleOpportunities.length ? (
        <div className="post-grid top-ranking-grid comment-opportunity-grid">
          {visibleOpportunities.map((opportunity, index) => (
            <CommentOpportunityCard
              opportunity={opportunity}
              rank={index + 1}
              referenceAt={feed?.capturedAt ?? opportunity.capturedAt}
              window={windows.get(opportunity.id)}
              queueState={queueStates[opportunity.id] ?? "pending"}
              onQueueChange={(state) => updateQueue(opportunity.id, state)}
              key={opportunity.id}
            />
          ))}
        </div>
      ) : feed ? (
        <div className="empty-state comment-feed-empty">
          <span aria-hidden="true">✓</span>
          <h3>{queueFilter === "pending" ? "La file est vide" : "Rien dans cette vue"}</h3>
          <p>{queueFilter === "pending" ? "Les prochaines opportunités arriveront au prochain scan." : "Change de filtre ou reviens à la file active."}</p>
          {queueFilter !== "pending" ? <button className="button secondary" type="button" onClick={() => setQueueFilter("pending")}>Voir les commentaires à faire</button> : null}
        </div>
      ) : null}
    </div>
  );
}

function DropChip({
  opportunity,
  window: goldenWindow,
}: {
  opportunity: CommentOpportunity;
  window: CommentOpportunityGoldenWindow | undefined;
}) {
  const thumbnail = commentOpportunityThumbnail(opportunity);
  return (
    <a
      className={`comment-drop-chip tier-${opportunity.momentTier} ${goldenWindow?.state === "closing" ? "is-closing" : ""}`}
      href={opportunity.url}
      target="_blank"
      rel="noreferrer"
    >
      <span className="comment-drop-thumb">
        {thumbnail ? <img src={thumbnail} alt="" loading="lazy" decoding="async" /> : <img src={`platforms/${opportunity.platform}.svg`} alt="" />}
      </span>
      <span className="comment-drop-body">
        <b>{opportunity.author}</b>
        <span className="comment-drop-title">{opportunity.title}</span>
        <span className="comment-drop-meta">
          <GoldenWindowLabel window={goldenWindow} />
          {opportunity.velocity ? (
            <em>+{formatCompactNumber(opportunity.velocity.perHour)} {VELOCITY_METRIC_LABELS[opportunity.velocity.metric]}/h</em>
          ) : null}
        </span>
      </span>
    </a>
  );
}

function GoldenWindowLabel({ window: goldenWindow }: { window: CommentOpportunityGoldenWindow | undefined }) {
  if (!goldenWindow || goldenWindow.state === "unknown") {
    return <span className="comment-window-pill unknown">Date non exposée</span>;
  }
  if (goldenWindow.state === "closed") {
    return <span className="comment-window-pill closed">Fenêtre passée</span>;
  }
  return (
    <span className={`comment-window-pill ${goldenWindow.state}`}>
      {goldenWindow.state === "closing" ? "Ferme dans " : "Encore "}
      {formatRemaining(goldenWindow.remainingMinutes ?? 0)}
    </span>
  );
}

function CommentOpportunityCard({
  opportunity,
  rank,
  referenceAt,
  window: goldenWindow,
  queueState,
  onQueueChange,
}: {
  opportunity: CommentOpportunity;
  rank: number;
  referenceAt: string;
  window: CommentOpportunityGoldenWindow | undefined;
  queueState: QueueFilter;
  onQueueChange: (state: QueueState | "pending") => void;
}) {
  const [activeTone, setActiveTone] = useState<CommentOpportunityTone>("funny");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const suggestion = opportunity.comments.find((comment) => comment.tone === activeTone) ?? opportunity.comments[0];
  const status = STATUS_META[opportunity.status];
  const metrics = opportunityMetrics(opportunity);
  const potentialScore = commentOpportunityRankScore(opportunity, referenceAt);

  const copySuggestion = async () => {
    const copied = suggestion ? await copyCommentText(suggestion.text) : false;
    setCopyState(copied ? "copied" : "error");
    window.setTimeout(() => setCopyState("idle"), 2200);
  };

  return (
    <article
      className={`social-post-card comment-opportunity-card has-media status-${status.className} tier-${opportunity.momentTier}${
        goldenWindow?.state === "closing" ? " is-closing" : ""
      }`}
    >
      <CommentOpportunityMedia opportunity={opportunity} rank={rank} />
      <div className="post-card-body comment-opportunity-body">
        <div className="comment-card-meta-line">
          <span><img src={`platforms/${opportunity.platform}.svg`} alt="" /> {opportunity.author}</span>
          <span className="comment-card-badges">
            {opportunity.risk.level === "medium" ? (
              <span className="comment-review-badge" title={opportunity.risk.note}>À relire</span>
            ) : null}
            <span className={`comment-hot-badge ${status.className}`}>{status.label}</span>
          </span>
        </div>

        <div className="comment-signal-row">
          <span className={`comment-tier-badge tier-${opportunity.momentTier}`}>
            {COMMENT_OPPORTUNITY_MOMENT_TIER_LABELS[opportunity.momentTier]}
          </span>
          <span className="comment-category-badge">
            {COMMENT_OPPORTUNITY_CATEGORY_LABELS[opportunity.category]}
          </span>
          <GoldenWindowLabel window={goldenWindow} />
          {opportunity.velocity ? (
            <span className="comment-velocity-badge" title={`Mesuré sur ${opportunity.velocity.windowHours} h`}>
              ↑ {formatCompactNumber(opportunity.velocity.perHour)} {VELOCITY_METRIC_LABELS[opportunity.velocity.metric]}/h
            </span>
          ) : null}
        </div>

        <div className="post-card-title comment-source-title">
          <div>
            <span>Potentiel {potentialScore}/100</span>
            <h3><a href={opportunity.url} target="_blank" rel="noreferrer">{opportunity.title || opportunity.caption}</a></h3>
          </div>
        </div>

        <p className="comment-why-now">{opportunity.whyNow}</p>

        <div className="comment-tone-tabs" role="group" aria-label={`Choisir un ton pour ${opportunity.title}`}>
          {opportunity.comments.map((comment) => {
            const tone = TONE_META[comment.tone];
            const isActive = comment.tone === suggestion?.tone;
            return (
              <button className={isActive ? "active" : ""} type="button" aria-pressed={isActive} onClick={() => { setActiveTone(comment.tone); setCopyState("idle"); }} key={comment.tone}>
                <span aria-hidden="true">{tone.marker}</span> {comment.label || tone.label}
              </button>
            );
          })}
        </div>

        {suggestion ? <blockquote className="comment-suggestion">{suggestion.text}</blockquote> : null}
        {opportunity.commentsSource === "fallback" ? (
          <p className="comment-source-warning">
            Propositions génériques : la voix n’a pas encore tourné sur cette vidéo, à réécrire avant de poster.
          </p>
        ) : null}

        <button className="comment-copy-button" type="button" onClick={() => void copySuggestion()} aria-live="polite">
          {copyState === "copied" ? "✓ Commentaire copié" : copyState === "error" ? "Copie impossible" : "Copier le commentaire"}
        </button>

        <footer>
          <span className="post-card-footer-metrics" aria-label="Performances visibles">
            {metrics.map((metric) => <span key={metric.label} title={metric.label}>{metric.icon} <b>{formatCompactNumber(metric.value)}</b></span>)}
          </span>
          {opportunity.publishedAt ? <time className="post-published-date" dateTime={opportunity.publishedAt}>{formatCardDate(opportunity.publishedAt)}</time> : <span />}
          <span className="post-card-actions comment-card-actions">
            <a href={opportunity.url} target="_blank" rel="noreferrer">Ouvrir ↗</a>
            {queueState === "pending" ? (
              <>
                <button className="comment-done-button" type="button" onClick={() => onQueueChange("done")}>✓ Fait</button>
                <button className="comment-skip-button" type="button" onClick={() => onQueueChange("skipped")}>Passer</button>
              </>
            ) : <button type="button" onClick={() => onQueueChange("pending")}>Remettre</button>}
          </span>
        </footer>
      </div>
    </article>
  );
}

function CommentOpportunityMedia({ opportunity, rank }: { opportunity: CommentOpportunity; rank: number }) {
  const [playing, setPlaying] = useState(false);
  const embedUrl = commentOpportunityEmbedUrl(opportunity);
  const thumbnail = commentOpportunityThumbnail(opportunity);

  return (
    <div className={`post-visual comment-opportunity-visual platform-${opportunity.platform} ${playing ? "is-playing" : "is-playable"}`}>
      {playing && embedUrl ? (
        <div className="inline-video-frame">
          <iframe
            src={embedUrl}
            title={`Vidéo de ${opportunity.author}`}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
          <button className="inline-player-close" type="button" aria-label="Fermer la vidéo" onClick={() => setPlaying(false)}>×</button>
        </div>
      ) : (
        <button className="post-visual-trigger" type="button" onClick={() => embedUrl ? setPlaying(true) : window.open(opportunity.url, "_blank", "noopener,noreferrer")} aria-label={`Lire la vidéo de ${opportunity.author}`}>
          {thumbnail ? <img src={thumbnail} alt="" loading="lazy" decoding="async" /> : (
            <span className="comment-preview-placeholder" aria-hidden="true">
              <img src={`platforms/${opportunity.platform}.svg`} alt="" />
              <small>Voir la vidéo</small>
            </span>
          )}
          <span className="media-play-mark" aria-hidden="true">▶</span>
        </button>
      )}
      <span className="post-rank">#{rank}</span>
      {opportunity.durationSeconds !== null ? <span className="trend-duration-badge">{formatDuration(opportunity.durationSeconds)}</span> : null}
    </div>
  );
}

const TIER_URGENCY: Record<CommentOpportunityMomentTier, number> = { s: 0, a: 1, b: 2 };

function windowGroup(goldenWindow: CommentOpportunityGoldenWindow | undefined) {
  if (goldenWindow?.state === "closing" || goldenWindow?.state === "open") return 0;
  if (goldenWindow?.state === "unknown") return 1;
  return 2;
}

function commentOpportunityEmbedUrl(opportunity: CommentOpportunity) {
  try {
    const url = new URL(opportunity.url);
    const path = url.pathname.replace(/\/+$/, "");
    if (opportunity.platform === "instagram") {
      const match = path.match(/^\/(?:reel|reels)\/([^/]+)$/i);
      return match ? `https://www.instagram.com/reel/${match[1]}/embed/` : null;
    }
    if (opportunity.platform === "tiktok") {
      const match = path.match(/^\/@[^/]+\/video\/(\d{12,24})$/i);
      return match ? `https://www.tiktok.com/player/v1/${match[1]}?autoplay=0&controls=1&description=0&music_info=0&rel=0` : null;
    }
    if (opportunity.platform === "youtube") {
      const shorts = path.match(/^\/shorts\/([A-Za-z0-9_-]{11})$/i);
      const watchId = url.searchParams.get("v");
      const id = shorts?.[1] ?? watchId;
      return id ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=0&playsinline=1&rel=0` : null;
    }
    const match = path.match(/^\/[^/]+\/status\/(\d+)$/i);
    return match ? `https://platform.twitter.com/embed/Tweet.html?id=${match[1]}&theme=dark&dnt=true` : null;
  } catch {
    return null;
  }
}

function commentOpportunityThumbnail(opportunity: CommentOpportunity) {
  if (opportunity.thumbnailUrl) return opportunity.thumbnailUrl;
  if (opportunity.platform !== "youtube") return null;
  try {
    const url = new URL(opportunity.url);
    const id = url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/i)?.[1] ?? url.searchParams.get("v");
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  } catch {
    return null;
  }
}

function opportunityMetrics(opportunity: CommentOpportunity) {
  return [
    opportunity.metrics.views !== null ? { icon: "▶", label: "vues", value: opportunity.metrics.views } : null,
    opportunity.metrics.likes !== null ? { icon: opportunity.platform === "youtube" ? "👍" : "♥", label: "likes", value: opportunity.metrics.likes } : null,
    opportunity.metrics.comments !== null ? { icon: "💬", label: "commentaires", value: opportunity.metrics.comments } : null,
  ].filter(Boolean) as Array<{ icon: string; label: string; value: number }>;
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatRemaining(minutes: number) {
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest.toString().padStart(2, "0")}`;
}

function formatElapsed(from: string, to: string) {
  const minutes = Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 1) return "à l’instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  return `il y a ${Math.round(minutes / 60)} h`;
}

function formatCardDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function formatRefreshDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatDuration(value: number) {
  if (value < 60) return `${Math.round(value)} s`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function timestamp(value: string | null) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

async function copyCommentText(value: string) {
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
