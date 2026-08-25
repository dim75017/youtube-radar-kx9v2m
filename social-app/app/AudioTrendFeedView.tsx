"use client";

/* eslint-disable @next/next/no-img-element -- platform logos and social thumbnails are public assets. */

import { useEffect, useMemo, useState } from "react";

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
import { isTrendEditorialScanLate } from "../lib/trend-health";
import {
  isScanLate,
  type AudioTrendCandidateReference,
  type AudioTrendScanStatus,
} from "../lib/trend-scan-status";
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
  scanStatus,
  loading,
  error,
}: {
  feed: AudioTrendFeed | null;
  scanStatus: AudioTrendScanStatus | null;
  loading: boolean;
  error: string;
}) {
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);
  const [freshnessCheckedAt, setFreshnessCheckedAt] = useState(Date.now);
  const matchedAudioUrls = useMemo(
    () => new Set((scanStatus?.discoveryAudit.candidateAudioUrls ?? []).map(canonicalUrl)),
    [scanStatus?.discoveryAudit.candidateAudioUrls],
  );
  const visibleTrends = useMemo(() => {
    const freshnessCutoff = Date.parse(feed?.capturedAt ?? "") -
      Math.max(feed?.cadenceHours ?? 24, 24) * 2 * 60 * 60 * 1_000;
    return [...(feed?.trends ?? [])]
      .filter((trend) => platformFilter === "all" || trend.platform === platformFilter)
      .filter((trend) => typeFilter === "all" || trend.type === typeFilter)
      .sort((left, right) => {
        const leftMatched = matchedAudioUrls.has(canonicalUrl(left.audioUrl));
        const rightMatched = matchedAudioUrls.has(canonicalUrl(right.audioUrl));
        if (leftMatched !== rightMatched) return leftMatched ? -1 : 1;
        return compareAudioTrends(left, right, freshnessCutoff);
      });
  }, [feed?.cadenceHours, feed?.capturedAt, feed?.trends, matchedAudioUrls, platformFilter, typeFilter]);
  const editorialScanDate = feed ? formatRefreshDate(feed.capturedAt) : null;
  const editorialScanIsLate = isTrendEditorialScanLate(feed?.capturedAt, freshnessCheckedAt);
  const dailyScanDate = formatRefreshDate(
    scanStatus?.discoveryAudit.scannedAt ?? scanStatus?.attemptedAt ?? "",
  );
  const dailyScanIsLate = isScanLate(
    scanStatus?.discoveryAudit.scannedAt ?? scanStatus?.attemptedAt,
    freshnessCheckedAt,
  );

  useEffect(() => {
    const interval = window.setInterval(
      () => setFreshnessCheckedAt(Date.now()),
      60 * 60 * 1_000,
    );
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="trend-feed-view audio-trend-view">
      <header className="trend-feed-heading">
        <div>
          <span className="section-kicker">Veille éditoriale quotidienne · focus Lofi Girl</span>
          <h2>Trends audio</h2>
          <p>
            Les sons et musiques à reprendre maintenant, avec leur volume d’utilisation,
            leur vraie croissance et une vidéo de référence.
          </p>
        </div>
        {scanStatus && dailyScanDate ? (
          <span className={`trend-snapshot-pill ${dailyScanIsLate ? "is-late" : ""}`}>
            Scan 24 h : {scanStatus.discoveryAudit.candidateCount} sons · {scanStatus.discoveryAudit.qualifiedInventoryCount} carte retrouvée · {dailyScanDate}
          </span>
        ) : null}
      </header>

      {feed && editorialScanDate ? (
        <div className={`trend-scan-summary ${editorialScanIsLate ? "is-degraded" : ""}`} role="status">
          <div>
            <b>{dailyScanIsLate ? "Scan quotidien en retard" : "Scan quotidien effectué"}</b>
            <span>Dernier lot complet : {editorialScanDate} · {feed.trends.length} cartes</span>
          </div>
          <p>
            {editorialScanIsLate
              ? `${scanStatus?.discoveryAudit.qualifiedInventoryCount ?? 0}/50 cartes ont été reliées au scan du jour. Les ${scanStatus?.discoveryAudit.newCandidateCount ?? 0} nouveaux sons restent candidats tant que leurs reprises, likes et durée ne sont pas prouvés.`
              : "Le lot affiché a passé les contrôles multi-créateurs, métriques et durée."}
          </p>
        </div>
      ) : null}

      {scanStatus?.discoveryAudit.candidateReferences.length ? (
        <AudioCandidateLinks
          references={scanStatus.discoveryAudit.candidateReferences}
          total={scanStatus.discoveryAudit.candidateCount}
        />
      ) : null}

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
              scanMatched={matchedAudioUrls.has(canonicalUrl(trend.audioUrl))}
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

function AudioCandidateLinks({
  references,
  total,
}: {
  references: readonly AudioTrendCandidateReference[];
  total: number;
}) {
  const visibleReferences = references.slice(0, 12);
  return (
    <section className="trend-candidate-panel" aria-label="Nouveaux sons détectés au dernier scan">
      <div className="trend-candidate-panel-heading">
        <div>
          <b>Nouveaux sons détectés au dernier scan</b>
          <span>À qualifier : trois créateurs, métriques publiques et durée doivent encore être vérifiés.</span>
        </div>
        <span>{total} détectés</span>
      </div>
      <div className="trend-candidate-links">
        {visibleReferences.map((candidate, index) => {
          const platform = audioCandidatePlatform(candidate.referenceUrl);
          return (
            <a href={candidate.referenceUrl} target="_blank" rel="noreferrer" key={`${candidate.audioUrl}:${candidate.referenceUrl}`}>
              {platform ? (
                <img src={`platforms/${platform}.svg`} alt="" width="17" height="17" />
              ) : null}
              Son candidat {index + 1}
            </a>
          );
        })}
        {total > visibleReferences.length ? (
          <span className="trend-candidate-overflow">+{total - visibleReferences.length} autres</span>
        ) : null}
      </div>
    </section>
  );
}

function AudioTrendCard({
  trend,
  rank,
  active,
  onActivate,
  onClose,
  scanMatched,
  feedCapturedAt,
}: {
  trend: AudioTrend;
  rank: number;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  scanMatched: boolean;
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

        <span className={`trend-scan-card-state ${scanMatched ? "is-current" : "is-retained"}`}>
          {scanMatched ? "Retrouvé dans le scan du jour" : "Conservé du dernier lot complet"}
        </span>

        <div className="post-card-title audio-card-title">
          <div className="post-media-caption">
            <span className="trend-card-source-title">{trend.title} · {trend.author}</span>
            <span className="trend-proposal-title">{activeProposal.title}</span>
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

function canonicalUrl(candidate: string) {
  try {
    const url = new URL(candidate);
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString();
  } catch {
    return candidate;
  }
}

function audioCandidatePlatform(candidate: string): AudioTrendPlatform | null {
  try {
    const host = new URL(candidate).hostname.toLowerCase();
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok";
    if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return "youtube";
    return null;
  } catch {
    return null;
  }
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
  if (leftSignal.freshnessTimestamp !== rightSignal.freshnessTimestamp) {
    return rightSignal.freshnessTimestamp - leftSignal.freshnessTimestamp;
  }
  if (right.lofiFitScore !== left.lofiFitScore) {
    return right.lofiFitScore - left.lofiFitScore;
  }
  return left.title.localeCompare(right.title, "fr");
}

function audioTrendSortSignal(trend: AudioTrend, freshnessCutoff: number) {
  const growth = deriveAudioTrendGrowth(trend.usageObservations);
  const rank = latestRank(trend);
  const usage = latestUsageObservation(trend);
  const latestObservationTimestamp = Math.max(
    ...trend.usageObservations.map((observation) => Date.parse(observation.capturedAt)),
  );
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
    freshnessTimestamp: Number.isFinite(latestObservationTimestamp)
      ? latestObservationTimestamp
      : 0,
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

function formatRefreshDate(value: string) {
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
