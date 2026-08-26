"use client";

/* eslint-disable @next/next/no-img-element -- snapshots are local public assets. */

import { useMemo, useState } from "react";

import {
  latestPlaylistPromoObservation,
  type PlaylistDestination,
  type PlaylistPromoCreativeFamily,
  type PlaylistPromoFeed,
  type PlaylistPromoItem,
  type PlaylistPromoPlatform,
} from "../lib/playlist-promos";
import { SocialInlinePlayer } from "./SocialInlinePlayer";

type PlatformFilter = PlaylistPromoPlatform | "all";
type DestinationFilter = PlaylistDestination | "all";
type Sort = "likes" | "views" | "recent";

const PLATFORM_OPTIONS: Array<{ key: PlatformFilter; label: string }> = [
  { key: "all", label: "Toutes" },
  { key: "instagram", label: "Instagram" },
  { key: "tiktok", label: "TikTok" },
  { key: "youtube", label: "YouTube" },
  { key: "facebook", label: "Facebook" },
  { key: "pinterest", label: "Pinterest" },
];

const DESTINATION_OPTIONS: Array<{ key: DestinationFilter; label: string }> = [
  { key: "all", label: "Toutes" },
  { key: "spotify", label: "Spotify" },
  { key: "apple-music", label: "Apple Music" },
  { key: "youtube-music", label: "YouTube Music" },
  { key: "deezer", label: "Deezer" },
  { key: "multi-dsp", label: "Multi-DSP" },
  { key: "unknown", label: "À confirmer" },
];

const DESTINATION_LABELS: Record<PlaylistDestination, string> = {
  spotify: "Spotify",
  "apple-music": "Apple Music",
  "youtube-music": "YouTube Music",
  deezer: "Deezer",
  "multi-dsp": "Multi-DSP",
  unknown: "Destination à confirmer",
};

const FAMILY_LABELS: Record<PlaylistPromoCreativeFamily, string> = {
  "problem-solution": "Problème → solution",
  "relatable-meme": "Mème relatable",
  "playlist-proof": "Preuve playlist",
  "mood-scene": "Scène d’ambiance",
  reaction: "Réaction",
  "direct-benefit": "Bénéfice direct",
};

const PLATFORM_EMOJI: Record<PlaylistPromoPlatform, string> = {
  instagram: "📸",
  tiktok: "🎵",
  youtube: "▶️",
  facebook: "📘",
  pinterest: "📌",
};

export function PlaylistPromoFeedView({
  feed,
  loading,
  error,
}: {
  feed: PlaylistPromoFeed | null;
  loading: boolean;
  error: string;
}) {
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [destination, setDestination] = useState<DestinationFilter>("all");
  const [sort, setSort] = useState<Sort>("likes");
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);

  const visibleItems = useMemo(() => [...(feed?.items ?? [])]
    .filter((item) => platform === "all" || item.platform === platform)
    .filter((item) => destination === "all" || item.destination === destination)
    .sort((left, right) => compareItems(left, right, sort)), [destination, feed?.items, platform, sort]);

  const summary = useMemo(() => summarizeFeed(feed), [feed]);

  return (
    <div className="trend-feed-view playlist-promo-view">
      <header className="trend-feed-heading playlist-promo-heading">
        <div>
          <h2>Pubs playlists</h2>
          <p>Créations promotionnelles vérifiées, classées par signaux publics — pas par ROI supposé.</p>
        </div>
        {feed ? (
          <span className="playlist-promo-snapshot">
            Relevé du {formatDate(feed.capturedAt)}
          </span>
        ) : null}
      </header>

      {feed ? (
        <div className="playlist-promo-kpis" aria-label="Résumé du benchmark">
          <Kpi value={String(feed.items.length)} label="créations ≥ 10k likes" />
          <Kpi value={formatCompact(summary.totalViews)} label="vues cumulées" />
          <Kpi value={formatCompact(summary.medianLikes)} label="likes médians" />
          <Kpi value={`${summary.averageDuration.toFixed(1).replace(".", ",")} s`} label="durée moyenne" />
        </div>
      ) : null}

      <div className="audio-trend-controls playlist-promo-controls" aria-label="Filtres du benchmark publicitaire">
        <FilterGroup
          label="Plateforme"
          value={platform}
          options={PLATFORM_OPTIONS}
          onChange={(value) => {
            setActivePlayerId(null);
            setPlatform(value);
          }}
        />
        <FilterGroup
          label="Destination"
          value={destination}
          options={DESTINATION_OPTIONS}
          onChange={(value) => {
            setActivePlayerId(null);
            setDestination(value);
          }}
        />
        <FilterGroup
          label="Classement"
          value={sort}
          options={[
            { key: "likes", label: "Likes" },
            { key: "views", label: "Vues" },
            { key: "recent", label: "Récentes" },
          ]}
          onChange={setSort}
        />
      </div>

      {error ? (
        <div className="trend-feed-notice" role="status">
          <span aria-hidden="true">⚠️</span>
          <p>{feed ? "Le dernier snapshot vérifié reste affiché." : error}</p>
        </div>
      ) : null}

      {feed ? <CoverageNote feed={feed} /> : null}

      {loading && !feed ? (
        <div className="trend-feed-loading" role="status">
          <span aria-hidden="true">⏳</span>
          <div>
            <b>Chargement du benchmark</b>
            <p>Les compteurs publics et leurs sources sont en cours de validation.</p>
          </div>
        </div>
      ) : feed && visibleItems.length ? (
        <div className="post-grid top-ranking-grid trend-shorts-grid playlist-promo-grid">
          {visibleItems.map((item, index) => (
            <PlaylistPromoCard
              item={item}
              rank={index + 1}
              active={activePlayerId === item.id}
              onActivate={() => setActivePlayerId(item.id)}
              onClose={() => setActivePlayerId(null)}
              key={`${item.id}:${feed.capturedAt}`}
            />
          ))}
        </div>
      ) : feed ? (
        <div className="empty-state trend-feed-empty">
          <span>🎯</span>
          <h3>Aucune création dans ce filtre</h3>
          <p>Les exemples dont le compteur n’est pas vérifiable restent hors du feed.</p>
          <button
            className="button secondary"
            type="button"
            onClick={() => {
              setPlatform("all");
              setDestination("all");
              setActivePlayerId(null);
            }}
          >
            Réinitialiser les filtres
          </button>
        </div>
      ) : null}

      {feed?.assetBriefs.length ? (
        <section className="playlist-asset-section" aria-labelledby="playlist-asset-title">
          <header>
            <span>Adaptation Lofi Girl</span>
            <h2 id="playlist-asset-title">Assets vidéo à produire</h2>
            <p>Concepts originaux, réalisables par l’équipe créative sans reprendre les images ni les personnages des annonceurs observés.</p>
          </header>
          <div className="playlist-asset-grid">
            {[...feed.assetBriefs]
              .sort((left, right) => left.priority - right.priority)
              .map((brief) => (
                <article className="playlist-asset-card" key={brief.id}>
                  <div className="playlist-asset-meta">
                    <span>P{brief.priority}</span>
                    <span>{brief.durationSeconds} s</span>
                    <span>{characterLabel(brief.character)}</span>
                  </div>
                  <h3>{brief.title}</h3>
                  <p className="playlist-asset-hook">“{brief.hook}”</p>
                  <ol>
                    {brief.shotList.map((shot) => <li key={shot}>{shot}</li>)}
                  </ol>
                  <div className="playlist-asset-copy">
                    <b>Texte écran</b>
                    <p>{brief.onScreenCopy}</p>
                  </div>
                  <footer>
                    <span>{brief.playlistUseCase}</span>
                    <b>CTA · {brief.cta}</b>
                  </footer>
                </article>
              ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function PlaylistPromoCard({
  item,
  rank,
  active,
  onActivate,
  onClose,
}: {
  item: PlaylistPromoItem;
  rank: number;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const observation = latestPlaylistPromoObservation(item);
  const inlinePlatform = item.platform === "instagram" || item.platform === "tiktok" || item.platform === "youtube"
    ? item.platform
    : null;

  return (
    <article className="social-post-card trend-reference-card playlist-promo-card has-media">
      <div className={`trend-reference-visual audio-reference-visual platform-${item.platform}`}>
        {active && inlinePlatform ? (
          <SocialInlinePlayer
            active
            platform={inlinePlatform}
            sourceUrl={item.url}
            title={`Création de référence de ${item.author}`}
            onClose={onClose}
          />
        ) : (
          <button
            className="audio-reference-trigger playlist-promo-trigger"
            type="button"
            aria-label={inlinePlatform ? `Lire la création de ${item.author}` : `Ouvrir la création de ${item.author}`}
            onClick={() => {
              if (inlinePlatform) onActivate();
              else window.open(item.url, "_blank", "noopener,noreferrer");
            }}
          >
            {item.thumbnailUrl ? (
              <img className="is-loaded" src={item.thumbnailUrl} alt="" loading="lazy" />
            ) : (
              <span className="audio-reference-fallback"><b>{item.title}</b></span>
            )}
            <span className="audio-reference-play-overlay" aria-hidden="true">▶</span>
          </button>
        )}
        <span className="trend-rank-badge">#{rank}</span>
        {item.durationSeconds ? (
          <span className="trend-duration-badge">{formatDuration(item.durationSeconds)}</span>
        ) : null}
      </div>

      <div className="post-card-body trend-card-body playlist-promo-card-body">
        <div className="trend-card-meta-line">
          <span>{PLATFORM_EMOJI[item.platform]} {item.author}</span>
          <span className="status-badge tone-indigo">
            {item.paidStatus === "verified-paid" ? "Pub vérifiée" : item.paidStatus === "organic-only" ? "Promo organique" : "Statut à confirmer"}
          </span>
        </div>

        <div className="playlist-promo-metrics" aria-label="Métriques publiques">
          <strong>❤️ {formatCompact(observation?.likes ?? 0)}</strong>
          <span>▶ {observation?.views === null || observation?.views === undefined ? "—" : formatCompact(observation.views)}</span>
          <span>💬 {observation?.comments === null || observation?.comments === undefined ? "—" : formatCompact(observation.comments)}</span>
        </div>

        <div className="post-card-title playlist-promo-title">
          <div className="post-media-caption">
            <span className="trend-card-source-title">{FAMILY_LABELS[item.creative.family]} · {formatDate(item.publishedOn)}</span>
            <h3>{item.creative.hook}</h3>
            <p>{item.caption || item.title}</p>
          </div>
        </div>

        <div className="playlist-promo-learning">
          <b>À reprendre pour Lofi Girl</b>
          <p>{item.creative.lofiAdaptation}</p>
        </div>

        <footer className="playlist-promo-footer">
          <span>{DESTINATION_LABELS[item.destination]}</span>
          <a href={item.url} target="_blank" rel="noreferrer">Voir l’original ↗</a>
        </footer>
        {item.creative.riskNote ? <p className="trend-caveat">⚠ {item.creative.riskNote}</p> : null}
      </div>
    </article>
  );
}

function FilterGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ key: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="trend-filter-group">
      <span>{label}</span>
      <div className="trend-filter-tabs" role="group" aria-label={`Filtrer par ${label.toLowerCase()}`}>
        {options.map((option) => (
          <button
            className={value === option.key ? "active" : ""}
            type="button"
            aria-pressed={value === option.key}
            onClick={() => onChange(option.key)}
            key={option.key}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Kpi({ value, label }: { value: string; label: string }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function CoverageNote({ feed }: { feed: PlaylistPromoFeed }) {
  const limited = feed.sourceChecks.filter((source) => source.status !== "success");
  if (!limited.length) return null;
  return (
    <div className="trend-feed-notice playlist-promo-coverage" role="status">
      <span aria-hidden="true">🔎</span>
      <p>
        <b>Couverture qualifiée, pas exhaustive.</b>{" "}
        Instagram est initialisé avec les sources vérifiées. TikTok, YouTube et les bibliothèques publicitaires passent dans le feed dès qu’un compteur ou un signal public comparable est prouvé.
      </p>
    </div>
  );
}

function summarizeFeed(feed: PlaylistPromoFeed | null) {
  const items = feed?.items ?? [];
  const likes = items.map((item) => latestPlaylistPromoObservation(item)?.likes ?? 0).sort((a, b) => a - b);
  const views = items.map((item) => latestPlaylistPromoObservation(item)?.views ?? 0);
  const durations = items.map((item) => item.durationSeconds).filter((value): value is number => value !== null);
  const middle = Math.floor(likes.length / 2);
  const medianLikes = likes.length
    ? likes.length % 2 ? likes[middle] : Math.round((likes[middle - 1] + likes[middle]) / 2)
    : 0;
  return {
    totalViews: views.reduce((sum, value) => sum + value, 0),
    medianLikes,
    averageDuration: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0,
  };
}

function compareItems(left: PlaylistPromoItem, right: PlaylistPromoItem, sort: Sort) {
  if (sort === "recent") return Date.parse(right.publishedOn) - Date.parse(left.publishedOn);
  const leftMetric = latestPlaylistPromoObservation(left);
  const rightMetric = latestPlaylistPromoObservation(right);
  if (sort === "views") return (rightMetric?.views ?? -1) - (leftMetric?.views ?? -1);
  return (rightMetric?.likes ?? -1) - (leftMetric?.likes ?? -1);
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDuration(seconds: number) {
  const rounded = Math.round(seconds);
  return rounded < 60 ? `${rounded} s` : `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function characterLabel(character: "lofi-girl" | "lofi-boy" | "lofi-cafe") {
  if (character === "lofi-boy") return "Lofi Boy";
  if (character === "lofi-cafe") return "Lofi Café";
  return "Lofi Girl";
}
