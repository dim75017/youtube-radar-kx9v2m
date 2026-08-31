"use client";

/* eslint-disable @next/next/no-img-element -- platform logos and social thumbnails are public assets. */

import { useMemo, useState } from "react";

import {
  deriveAudioTrendGrowth,
  isAudioTrendThumbnailExpired,
  type AudioTrend,
  type AudioTrendFeed,
  type AudioTrendPlatform,
  type AudioTrendProposalTone,
  type AudioTrendType,
} from "../lib/audio-trends";
import { dailyRotationIndex } from "../lib/daily-rotation";
import { SocialInlinePlayer } from "./SocialInlinePlayer";

type PlatformFilter = AudioTrendPlatform | "all";
type TypeFilter = AudioTrendType | "all";

const PLATFORM_FILTERS: Array<{ key: PlatformFilter; label: string }> = [
  { key: "all", label: "Toutes" },
  { key: "tiktok", label: "TikTok" },
  { key: "instagram", label: "Instagram" },
  { key: "youtube", label: "YouTube" },
];

const TYPE_FILTERS: Array<{ key: TypeFilter; label: string }> = [
  { key: "all", label: "Tous les audios" },
  { key: "spoken", label: "Audio parlé" },
  { key: "music", label: "Musique" },
  { key: "original", label: "Son original" },
];

const TYPE_LABELS: Record<AudioTrendType, string> = {
  music: "Musique",
  spoken: "Audio parlé",
  original: "Son original",
};

const PROPOSAL_TONE_LABELS: Record<AudioTrendProposalTone, string> = {
  cozy: "Cozy",
  funny: "Drôle",
  smart: "Smart",
  cinematic: "Ciné",
  relatable: "Relatable",
  cat: "Chat",
  gaming: "Gaming",
};

export function AudioTrendFeedView({
  feed,
  loading,
  error,
}: {
  feed: AudioTrendFeed | null;
  loading: boolean;
  error: string;
}) {
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);
  const visibleTrends = useMemo(() => {
    const freshnessCutoff = Date.parse(feed?.capturedAt ?? "") -
      Math.max(feed?.cadenceHours ?? 24, 24) * 2 * 60 * 60 * 1_000;
    return [...(feed?.trends ?? [])]
      .filter((trend) => platformFilter === "all" || trend.platform === platformFilter)
      .filter((trend) => typeFilter === "all" || trend.type === typeFilter)
      .sort((left, right) => compareAudioTrends(left, right, freshnessCutoff));
  }, [feed?.cadenceHours, feed?.capturedAt, feed?.trends, platformFilter, typeFilter]);
  return (
    <div className="trend-feed-view audio-trend-view">
      <header className="trend-feed-heading">
        <h2>Trends audio</h2>
      </header>

      <div className="audio-trend-controls" aria-label="Filtres des trends audio">
        <div className="trend-filter-group">
          <span>Plateforme</span>
          <div className="trend-filter-tabs" role="group" aria-label="Filtrer les audios par plateforme">
            {PLATFORM_FILTERS.map((option) => (
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
                {option.key !== "all" ? (
                  <img src={`platforms/${option.key}.svg`} alt="" width="17" height="17" />
                ) : null}
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="trend-filter-group">
          <span>Type</span>
          <div className="trend-filter-tabs" role="group" aria-label="Filtrer les audios par type">
            {TYPE_FILTERS.map((option) => (
              <button
                className={typeFilter === option.key ? "active" : ""}
                type="button"
                aria-pressed={typeFilter === option.key}
                onClick={() => {
                  setActivePlayerId(null);
                  setTypeFilter(option.key);
                }}
                key={option.key}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error ? (
        <div className="trend-feed-notice" role="status">
          <span aria-hidden="true">⚠️</span>
          <p>{feed ? "Le dernier snapshot vérifié reste affiché." : error}</p>
        </div>
      ) : null}

      {loading && !feed ? (
        <div className="trend-feed-loading" role="status">
          <span aria-hidden="true">⏳</span>
          <div>
            <b>Chargement des trends audio</b>
            <p>Les pages audio et leurs vidéos de référence sont en cours de validation.</p>
          </div>
        </div>
      ) : feed && visibleTrends.length ? (
        <div className="post-grid top-ranking-grid trend-shorts-grid audio-trend-grid">
          {visibleTrends.map((trend, index) => (
            <AudioTrendCard
              trend={trend}
              rank={index + 1}
              active={activePlayerId === trend.id}
              onActivate={() => setActivePlayerId(trend.id)}
              onClose={() => setActivePlayerId(null)}
              feedCapturedAt={feed.capturedAt}
              key={`${trend.id}:${feed.capturedAt.slice(0, 10)}`}
            />
          ))}
        </div>
      ) : feed ? (
        <div className="empty-state trend-feed-empty">
          <span>🎧</span>
          <h3>Aucun audio dans ce filtre</h3>
          <p>Les compteurs non vérifiables restent volontairement hors du feed.</p>
          <button
            className="button secondary"
            type="button"
            onClick={() => {
              setActivePlayerId(null);
              setPlatformFilter("all");
              setTypeFilter("all");
            }}
          >
            Voir tous les audios
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AudioTrendCard({
  trend,
  rank,
  active,
  onActivate,
  onClose,
  feedCapturedAt,
}: {
  trend: AudioTrend;
  rank: number;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  feedCapturedAt: string;
}) {
  const derivedGrowth = deriveAudioTrendGrowth(trend.usageObservations);
  const growthFreshnessCutoff = Date.parse(feedCapturedAt) - 48 * 60 * 60 * 1_000;
  const growth = derivedGrowth && Date.parse(derivedGrowth.toCapturedAt) >= growthFreshnessCutoff
    ? derivedGrowth
    : null;
  const uses = latestUses(trend);
  const rankSignal = latestRank(trend);
  const thumbnailUrl = trend.referenceVideo.thumbnailUrl &&
    !isAudioTrendThumbnailExpired(trend.referenceVideo.thumbnailUrl)
    ? trend.referenceVideo.thumbnailUrl
    : null;
  const [activeProposalIndex, setActiveProposalIndex] = useState(() =>
    dailyRotationIndex(trend.id, feedCapturedAt, trend.proposals.length),
  );
  const activeProposal = trend.proposals[activeProposalIndex] ?? trend.proposals[0];

  return (
    <article className="social-post-card trend-reference-card audio-trend-card has-media">
      <div className={`trend-reference-visual audio-reference-visual platform-${trend.platform}`}>
        {active ? (
          <SocialInlinePlayer
            active
            platform={trend.platform}
            playbackUrl={trend.referenceVideo.playbackUrl}
            playbackExpiresAt={trend.referenceVideo.playbackExpiresAt}
            sourceUrl={trend.referenceVideo.url}
            title={`Vidéo de référence pour ${trend.title}`}
            onClose={onClose}
          />
        ) : (
          <button
            className="audio-reference-trigger"
            type="button"
            aria-label={`Lire la vidéo de référence de ${trend.title}`}
            onClick={onActivate}
          >
            <AudioReferencePreview
              key={thumbnailUrl ?? "fallback"}
              thumbnailUrl={thumbnailUrl}
              title={trend.title}
            />
            <span className="audio-reference-play-overlay" aria-hidden="true">▶</span>
          </button>
        )}
        <span className="trend-rank-badge">#{rank}</span>
        {trend.referenceVideo.durationSeconds ? (
          <span className="trend-duration-badge">{formatDuration(trend.referenceVideo.durationSeconds)}</span>
        ) : null}
      </div>

      <div className="post-card-body trend-card-body audio-trend-card-body">
        <div className="trend-card-meta-line">
          <span className="audio-platform-line">
            <img src={`platforms/${trend.platform}.svg`} alt="" width="18" height="18" />
            {trend.referenceVideo.author}
          </span>
          <span className="status-badge tone-indigo">{TYPE_LABELS[trend.type]}</span>
        </div>

        <div className="audio-usage-row">
          <strong>{uses >= 0 ? `${formatCompact(uses)} vidéos` : "Volume non public"}</strong>
          {growth ? (
            <span className={growth.deltaUses >= 0 ? "is-growing" : "is-declining"}>
              {growth.deltaUses >= 0 ? "+" : ""}{formatCompact(growth.deltaUses)} · {formatPercent(growth.growthPercent)}
            </span>
          ) : rankSignal ? (
            <span>#{rankSignal.rank} · {rankSignal.window}</span>
          ) : (
            <span>Suivi démarré</span>
          )}
        </div>

        <div className="post-card-title audio-card-title">
          <div className="post-media-caption">
            <span className="trend-card-source-title">{trend.title} · {trend.author}</span>
            <h3>{activeProposal.concept}</h3>
            <p className="audio-proposal-copy">“{activeProposal.copy}”</p>
          </div>
        </div>

        <div className="trend-proposal-tabs audio-proposal-tabs" role="group" aria-label={`Choisir une proposition pour ${trend.title}`}>
          {trend.proposals.map((proposal, index) => (
            <button
              className={activeProposalIndex === index ? "active" : ""}
              type="button"
              aria-pressed={activeProposalIndex === index}
              onClick={() => setActiveProposalIndex(index)}
              key={proposal.id}
            >
              {PROPOSAL_TONE_LABELS[proposal.tone]}
            </button>
          ))}
        </div>

        <footer className="audio-trend-footer">
          <span className="audio-growth-detail">
            {growth
              ? `${formatCompact(Math.abs(growth.usesPerDay))} utilisations/jour`
              : "Croissance mesurée dès le prochain relevé comparable"}
          </span>
          <span className="audio-proposal-character">
            {activeProposal.character === "lofi-girl" ? "Lofi Girl" : "Lofi Boy"}
          </span>
        </footer>
      </div>
    </article>
  );
}

function AudioReferencePreview({
  thumbnailUrl,
  title,
}: {
  thumbnailUrl: string | null;
  title: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  const showImage = Boolean(thumbnailUrl) && !failed;
  return (
    <>
      <span className="audio-reference-fallback" aria-hidden={loaded && showImage}>
        <span className="audio-reference-waveform" aria-hidden="true">
          <i /><i /><i /><i /><i /><i /><i />
        </span>
        <b>{title}</b>
        <small>{showImage ? "Chargement de la frame" : "Frame momentanément indisponible"}</small>
      </span>
      {showImage ? (
        <img
          className={loaded ? "is-loaded" : ""}
          src={thumbnailUrl ?? undefined}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            setFailed(true);
          }}
        />
      ) : null}
    </>
  );
}

function latestUses(trend: AudioTrend) {
  const observation = latestUsageObservation(trend);
  return observation?.uses ?? -1;
}

function latestRank(trend: AudioTrend) {
  const observation = latestVerifiedObservation(
    trend,
    (candidate) => candidate.rank !== null && Boolean(candidate.rankWindow),
  );
  return observation?.rank && observation.rankWindow
    ? { rank: observation.rank, window: observation.rankWindow, capturedAt: observation.capturedAt }
    : null;
}

function latestUsageObservation(trend: AudioTrend) {
  return latestVerifiedObservation(trend, (candidate) => candidate.uses !== null);
}

function latestVerifiedObservation(
  trend: AudioTrend,
  predicate: (observation: AudioTrend["usageObservations"][number]) => boolean,
) {
  return [...trend.usageObservations]
    .filter(predicate)
    .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))[0] ?? null;
}

function compareAudioTrends(left: AudioTrend, right: AudioTrend, freshnessCutoff: number) {
  const leftSignal = audioTrendSortSignal(left, freshnessCutoff);
  const rightSignal = audioTrendSortSignal(right, freshnessCutoff);

  const recencyDelta = audioEditorialRecencyTimestamp(right) -
    audioEditorialRecencyTimestamp(left);
  if (recencyDelta !== 0) return recencyDelta;

  if (leftSignal.recentGrowth !== rightSignal.recentGrowth) {
    return leftSignal.recentGrowth ? -1 : 1;
  }
  if (leftSignal.recentGrowth && rightSignal.recentGrowth) {
    const paceDelta = rightSignal.growthUsesPerDay - leftSignal.growthUsesPerDay;
    if (paceDelta !== 0) return paceDelta;
  }
  if (leftSignal.currentRank !== null || rightSignal.currentRank !== null) {
    if (leftSignal.currentRank === null) return 1;
    if (rightSignal.currentRank === null) return -1;
    if (leftSignal.currentRank !== rightSignal.currentRank) {
      return leftSignal.currentRank - rightSignal.currentRank;
    }
  }
  if (leftSignal.currentUses !== rightSignal.currentUses) {
    return rightSignal.currentUses - leftSignal.currentUses;
  }
  if (right.lofiFitScore !== left.lofiFitScore) {
    return right.lofiFitScore - left.lofiFitScore;
  }
  return left.title.localeCompare(right.title, "fr");
}

function audioEditorialRecencyTimestamp(trend: AudioTrend) {
  return [
    trend.referenceVideo.publishedAt,
    trend.source.capturedAt,
  ].reduce((latest, value) => {
    const timestamp = Date.parse(value ?? "");
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, 0);
}

function audioTrendSortSignal(trend: AudioTrend, freshnessCutoff: number) {
  const growth = deriveAudioTrendGrowth(trend.usageObservations);
  const rank = latestRank(trend);
  const usage = latestUsageObservation(trend);
  const recentGrowth = Boolean(
    growth && growth.usesPerDay > 0 && Date.parse(growth.toCapturedAt) >= freshnessCutoff,
  );
  const currentRank = rank && Date.parse(rank.capturedAt) >= freshnessCutoff
    ? rank.rank
    : null;
  const currentUses = usage && Date.parse(usage.capturedAt) >= freshnessCutoff
    ? usage.uses ?? -1
    : -1;

  return {
    recentGrowth,
    growthUsesPerDay: recentGrowth && growth ? growth.usesPerDay : 0,
    currentRank,
    currentUses,
  };
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("fr-FR", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatPercent(value: number | null) {
  if (value === null) return "nouveau";
  return new Intl.NumberFormat("fr-FR", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value / 100);
}

function formatDuration(seconds: number) {
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remaining = rounded % 60;
  return minutes ? `${minutes}:${String(remaining).padStart(2, "0")}` : `0:${String(remaining).padStart(2, "0")}`;
}
