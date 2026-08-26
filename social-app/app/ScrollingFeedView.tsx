"use client";

/* eslint-disable @next/next/no-img-element -- observed social thumbnails are rendered lazily. */

import { useMemo, useState } from "react";

import {
  type ScrollingExplorationLens,
  type ScrollingFeed,
  type ScrollingItem,
  type ScrollingRun,
} from "../lib/scrolling";
import { SocialInlinePlayer } from "./SocialInlinePlayer";

type ThemeFilter = "all" | string;
type CharacterFilter = "all" | ScrollingItem["adaptation"]["cast"]["character"];
type FormatFilter = "all" | ScrollingItem["source"]["format"];
type RelevanceFilter = "all" | ScrollingItem["analysis"]["confidence"];

const CHARACTER_OPTIONS: Array<{ key: CharacterFilter; label: string }> = [
  { key: "all", label: "Tous" },
  { key: "lofi-girl", label: "Lofi Girl + chat" },
  { key: "lofi-boy", label: "Lofi Boy + chien" },
  { key: "both", label: "Duo" },
];

const FORMAT_OPTIONS: Array<{ key: FormatFilter; label: string }> = [
  { key: "all", label: "Tous" },
  { key: "reel", label: "Reel" },
  { key: "carousel", label: "Carrousel" },
  { key: "image", label: "Image" },
  { key: "video", label: "Vidéo" },
];

const RELEVANCE_OPTIONS: Array<{ key: RelevanceFilter; label: string }> = [
  { key: "all", label: "Toutes" },
  { key: "high", label: "Prioritaire" },
  { key: "medium", label: "Bonne piste" },
  { key: "watch", label: "À surveiller" },
];

const GROUP_LABELS: Record<ScrollingExplorationLens["group"], string> = {
  storytelling: "Récits & émotions",
  music: "Musique & performance",
  lifestyle: "Vie quotidienne & univers",
  community: "Communauté & moments collectifs",
};

const CONFIDENCE_LABELS: Record<ScrollingItem["analysis"]["confidence"], string> = {
  high: "Prioritaire",
  medium: "Bonne piste",
  watch: "À surveiller",
};

const FORMAT_LABELS: Record<ScrollingItem["source"]["format"], string> = {
  reel: "Reel",
  carousel: "Carrousel",
  image: "Image",
  video: "Vidéo",
};

const PLATFORM_LABELS: Record<ScrollingItem["source"]["platform"], string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
};

export function ScrollingFeedView({
  feed,
  loading,
  error,
}: {
  feed: ScrollingFeed | null;
  loading: boolean;
  error: string;
}) {
  const [theme, setTheme] = useState<ThemeFilter>("all");
  const [character, setCharacter] = useState<CharacterFilter>("all");
  const [format, setFormat] = useState<FormatFilter>("all");
  const [relevance, setRelevance] = useState<RelevanceFilter>("all");
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);

  const latestRun = useMemo(() => [...(feed?.runs ?? [])]
    .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))[0] ?? null, [feed?.runs]);
  const latestRunItemCount = useMemo(() => latestRun
    ? (feed?.items ?? []).filter((item) => item.runId === latestRun.id).length
    : 0, [feed?.items, latestRun]);

  const observedThemeOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of feed?.items ?? []) {
      for (const themeId of item.analysis.themeIds) {
        counts.set(themeId, (counts.get(themeId) ?? 0) + 1);
      }
    }
    return (feed?.explorationLenses ?? [])
      .filter((lens) => lens.observedInSnapshot || counts.has(lens.id))
      .map((lens) => ({
        key: lens.id,
        label: lens.label,
        count: counts.get(lens.id) ?? 0,
      }));
  }, [feed?.explorationLenses, feed?.items]);

  const visibleItems = useMemo(() => [...(feed?.items ?? [])]
    .filter((item) => theme === "all" || item.analysis.themeIds.includes(theme))
    .filter((item) => character === "all" || item.adaptation.cast.character === character)
    .filter((item) => format === "all" || item.source.format === format)
    .filter((item) => relevance === "all" || item.analysis.confidence === relevance)
    .sort(compareItems), [character, feed?.items, format, relevance, theme]);

  const qualifyingCount = useMemo(() => (feed?.items ?? []).filter((item) => {
    const likes = item.source.metrics.likes;
    return likes !== null && likes >= (feed?.minimumLikes ?? 10_000);
  }).length, [feed?.items, feed?.minimumLikes]);

  const resetFilters = () => {
    setTheme("all");
    setCharacter("all");
    setFormat("all");
    setRelevance("all");
    setActivePlayerId(null);
  };

  return (
    <div className="trend-feed-view scrolling-view">
      <header className="trend-feed-heading scrolling-heading">
        <div>
          <span className="scrolling-eyebrow">Inspiration observée</span>
          <h2>Scrolling</h2>
          <p>
            Idées repérées pendant un scroll délégué, puis adaptées à l’univers Lofi Girl.
            Ce feed est volontairement séparé des trends prouvées.
          </p>
        </div>
        {feed ? <span className="scrolling-snapshot">Test du {formatDate(feed.capturedAt)}</span> : null}
      </header>

      {feed && latestRun ? (
        <section className="scrolling-run-summary" aria-label="Résumé du dernier scroll">
          <header>
            <div>
              <span className="scrolling-private-badge">✓ Navigation privée déléguée</span>
              <b>{PLATFORM_LABELS[latestRun.platform]} · {surfaceLabel(latestRun.surface)}</b>
            </div>
            <time dateTime={latestRun.capturedAt}>{formatDate(latestRun.capturedAt)}</time>
          </header>
          <div className="scrolling-run-kpis">
            <Kpi value={String(latestRun.seenCount)} label="contenus observés" />
            <Kpi value={String(latestRun.qualifyingCount)} label={`compteurs ≥ ${formatCompact(feed.minimumLikes)}`} />
            <Kpi value={String(latestRunItemCount)} label="idées retenues" />
            <Kpi value={String(latestRun.themeIds.length)} label="thèmes touchés" />
          </div>
          <p className="scrolling-threshold-note">
            <b>{qualifyingCount} source{qualifyingCount === 1 ? "" : "s"} au seuil public.</b>{" "}
            Quand Instagram masque les likes, la carte reste une inspiration observée et n’est jamais présentée comme une performance prouvée.
          </p>
          <p className="scrolling-production-rule">
            <span aria-hidden="true">✏️</span>
            Adaptations à produire uniquement avec l’animation, la captation et les assets humains de Lofi Girl. Aucun visuel, son, morceau ni voix généré par IA.
          </p>
          {latestRun.limitations.length || feed.limitations.length ? (
            <div className="scrolling-run-limitations">
              <span>Limites du test</span>
              <p>{[...latestRun.limitations, ...feed.limitations].join(" ")}</p>
            </div>
          ) : null}
          <details className="scrolling-methodology">
            <summary>Méthode de sélection</summary>
            <p>{feed.methodology}</p>
          </details>
        </section>
      ) : null}

      <div className="scrolling-controls" aria-label="Filtres des inspirations observées">
        <div className="trend-filter-group scrolling-theme-filter">
          <span>Thème observé</span>
          <div className="trend-filter-tabs" role="group" aria-label="Filtrer par thème observé">
            <button
              className={theme === "all" ? "active" : ""}
              type="button"
              aria-pressed={theme === "all"}
              onClick={() => {
                setTheme("all");
                setActivePlayerId(null);
              }}
            >
              Tous
              <small>{feed?.items.length ?? 0}</small>
            </button>
            {observedThemeOptions.map((option) => (
              <button
                className={theme === option.key ? "active" : ""}
                type="button"
                aria-pressed={theme === option.key}
                onClick={() => {
                  setTheme(option.key);
                  setActivePlayerId(null);
                }}
                key={option.key}
              >
                {option.label}
                <small>{option.count}</small>
              </button>
            ))}
          </div>
        </div>
        <FilterGroup
          label="Personnage"
          value={character}
          options={CHARACTER_OPTIONS}
          onChange={(value) => {
            setCharacter(value);
            setActivePlayerId(null);
          }}
        />
        <FilterGroup
          label="Format"
          value={format}
          options={FORMAT_OPTIONS}
          onChange={(value) => {
            setFormat(value);
            setActivePlayerId(null);
          }}
        />
        <FilterGroup
          label="Pertinence"
          value={relevance}
          options={RELEVANCE_OPTIONS}
          onChange={(value) => {
            setRelevance(value);
            setActivePlayerId(null);
          }}
        />
      </div>

      {error ? (
        <div className="trend-feed-notice" role="status">
          <span aria-hidden="true">⚠️</span>
          <p>{feed ? "Le dernier test validé reste affiché." : error}</p>
        </div>
      ) : null}

      {loading && !feed ? (
        <div className="trend-feed-loading" role="status">
          <span aria-hidden="true">⏳</span>
          <div>
            <b>Chargement du scroll</b>
            <p>Les observations et leurs adaptations éditoriales sont en cours de lecture.</p>
          </div>
        </div>
      ) : feed && visibleItems.length ? (
        <div className="post-grid top-ranking-grid trend-shorts-grid scrolling-grid">
          {visibleItems.map((item, index) => (
            <ScrollingCard
              item={item}
              feed={feed}
              index={index + 1}
              active={activePlayerId === item.id}
              onActivate={() => setActivePlayerId(item.id)}
              onClose={() => setActivePlayerId(null)}
              key={`${item.id}:${feed.capturedAt}`}
            />
          ))}
        </div>
      ) : feed ? (
        <div className="empty-state trend-feed-empty">
          <span>🧭</span>
          <h3>Aucune idée dans ce croisement</h3>
          <p>Ce filtre ne contient rien dans le test observé. Les pistes non testées restent visibles plus bas.</p>
          <button className="button secondary" type="button" onClick={resetFilters}>Réinitialiser les filtres</button>
        </div>
      ) : null}

      {feed?.explorationLenses.length ? (
        <ExplorationPanel
          lenses={feed.explorationLenses}
          onSelectObserved={(lensId) => {
            setTheme(lensId);
            setCharacter("all");
            setFormat("all");
            setRelevance("all");
            setActivePlayerId(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ScrollingCard({
  item,
  feed,
  index,
  active,
  onActivate,
  onClose,
}: {
  item: ScrollingItem;
  feed: ScrollingFeed;
  index: number;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const likes = item.source.metrics.likes;
  const qualifies = likes !== null && likes >= feed.minimumLikes;
  const canPlay = item.source.format === "reel" || item.source.format === "video";
  const lensLabels = item.analysis.themeIds.map((themeId) => (
    feed.explorationLenses.find((lens) => lens.id === themeId)?.label ?? humanizeId(themeId)
  ));

  return (
    <article className={`social-post-card trend-reference-card scrolling-card scrolling-confidence-${item.analysis.confidence}`}>
      <div className={`trend-reference-visual audio-reference-visual scrolling-card-visual platform-${item.source.platform}`}>
        {active && canPlay ? (
          <SocialInlinePlayer
            active
            platform={item.source.platform}
            sourceUrl={item.source.url}
            title={`Publication observée de ${item.source.author ?? item.source.sourceLabel}`}
            onClose={onClose}
          />
        ) : (
          <button
            className="audio-reference-trigger scrolling-media-trigger"
            type="button"
            aria-label={canPlay
              ? `Lire la publication de ${item.source.author ?? item.source.sourceLabel}`
              : `Ouvrir la publication de ${item.source.author ?? item.source.sourceLabel}`}
            onClick={() => {
              if (canPlay) onActivate();
              else window.open(item.source.url, "_blank", "noopener,noreferrer");
            }}
          >
            {item.source.thumbnailUrl ? (
              <img className="is-loaded" src={item.source.thumbnailUrl} alt="" loading="lazy" />
            ) : (
              <span className="audio-reference-fallback scrolling-reference-fallback">
                <span aria-hidden="true">{item.source.platform === "instagram" ? "📸" : "🎵"}</span>
                <b>{item.source.sourceLabel}</b>
                <small>{FORMAT_LABELS[item.source.format]} observé</small>
              </span>
            )}
            <span className="audio-reference-play-overlay" aria-hidden="true">{canPlay ? "▶" : "↗"}</span>
          </button>
        )}
        <span className="scrolling-observed-badge">Observation {index}</span>
        <span className={`scrolling-source-status ${item.source.sponsored === true ? "is-sponsored" : ""}`}>
          {item.source.sponsored === true
            ? "Sponsorisé"
            : item.source.sponsored === false ? "Organique" : "Statut pub inconnu"}
        </span>
      </div>

      <div className="post-card-body scrolling-card-body">
        <div className="scrolling-source-line">
          <span>{item.source.platform === "instagram" ? "📸" : "🎵"} {item.source.author ?? item.source.sourceLabel}</span>
          <span>{FORMAT_LABELS[item.source.format]}</span>
        </div>

        <div className="scrolling-metrics" aria-label="Métriques publiques observées">
          <div className={qualifies ? "is-qualified" : likes === null ? "is-unavailable" : ""}>
            <strong>{likes === null ? "—" : formatCompact(likes)}</strong>
            <span>{likes === null ? "likes masqués" : "likes publics"}</span>
          </div>
          <div>
            <strong>{item.source.metrics.views === null ? "—" : formatCompact(item.source.metrics.views)}</strong>
            <span>vues</span>
          </div>
          <div className={`scrolling-threshold-cell ${qualifies ? "is-qualified" : ""}`}>
            <strong>{qualifies ? "✓ ≥10k" : likes === null ? "Non vérifié" : "Sous seuil"}</strong>
            <span>{item.source.metrics.precision === "platform-rounded" ? "compteur arrondi" : "seuil public"}</span>
          </div>
        </div>

        <div className="scrolling-card-tags" aria-label="Thèmes de l’observation">
          {lensLabels.map((label) => <span key={label}>{label}</span>)}
          <span>{castLabel(item.adaptation.cast)}</span>
          <b>{CONFIDENCE_LABELS[item.analysis.confidence]}</b>
        </div>

        <section className="scrolling-observation-copy">
          <span>Ce qui a retenu l’attention</span>
          <h3>{item.analysis.hook}</h3>
          <p>{item.analysis.mechanic}</p>
          <small>Signal visuel · {item.analysis.visualCue}</small>
        </section>

        <section className="scrolling-stop-reason">
          <span aria-hidden="true">👁</span>
          <div>
            <b>Pourquoi je me suis arrêté</b>
            <p>{item.analysis.reasonToStop}</p>
          </div>
        </section>

        <section className="scrolling-adaptation">
          <span>Adaptation Lofi Girl</span>
          <h3>{item.adaptation.title}</h3>
          <p>{item.adaptation.concept}</p>
          <blockquote>“{item.adaptation.openingText}”</blockquote>
          <small>{item.analysis.whyRelevant}</small>
        </section>

        <section className="scrolling-execution">
          <span>Exécution</span>
          <ol>
            {item.adaptation.sequence.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </section>

        <details className="scrolling-brief-details">
          <summary>Copy, audio et garde-fous</summary>
          <div>
            <section><b>Caption</b><p>{item.adaptation.caption}</p></section>
            <section><b>Direction audio</b><p>{item.adaptation.audioDirection}</p></section>
            <section>
              <b>Garde-fous de production</b>
              <ul>{item.adaptation.productionGuardrails.map((guardrail) => <li key={guardrail}>{guardrail}</li>)}</ul>
            </section>
          </div>
        </details>

        <footer className="scrolling-card-footer">
          <span>
            {item.source.publishedAt ? `Publié le ${formatDate(item.source.publishedAt)}` : `Observé le ${formatDate(item.source.capturedAt)}`}
          </span>
          <a href={item.source.url} target="_blank" rel="noreferrer">
            Voir sur {PLATFORM_LABELS[item.source.platform]} ↗
          </a>
        </footer>
      </div>
    </article>
  );
}

function ExplorationPanel({
  lenses,
  onSelectObserved,
}: {
  lenses: ScrollingExplorationLens[];
  onSelectObserved: (lensId: string) => void;
}) {
  const grouped = Object.entries(GROUP_LABELS).map(([group, label]) => ({
    group: group as ScrollingExplorationLens["group"],
    label,
    lenses: lenses.filter((lens) => lens.group === group),
  })).filter((entry) => entry.lenses.length);

  return (
    <section className="scrolling-exploration" aria-labelledby="scrolling-exploration-title">
      <header>
        <div>
          <span>Taxonomie évolutive</span>
          <h2 id="scrolling-exploration-title">Pistes à explorer</h2>
          <p>
            Les axes marqués « Observé au test » viennent du run actuel. Les autres sont des territoires à entraîner et à tester lors des prochains scrolls.
          </p>
        </div>
        <div className="scrolling-lens-legend" aria-label="Légende des axes">
          <span className="is-observed">● Observé au test</span>
          <span className="is-exploration">○ À explorer</span>
        </div>
      </header>
      <div className="scrolling-lens-groups">
        {grouped.map((entry) => (
          <section key={entry.group}>
            <h3>{entry.label}</h3>
            <div className="scrolling-lens-grid">
              {entry.lenses.map((lens) => (
                <article className={lens.observedInSnapshot ? "is-observed" : "is-exploration"} key={lens.id}>
                  <header>
                    <span>{lens.observedInSnapshot ? "Observé au test" : "À explorer"}</span>
                    <b>{lens.label}</b>
                  </header>
                  <p>{lens.description}</p>
                  <div>
                    <small>{lens.specialty}</small>
                    <small>{lens.discoverySignals.slice(0, 2).join(" · ")}</small>
                  </div>
                  <footer>
                    {lens.observedInSnapshot ? (
                      <button type="button" onClick={() => onSelectObserved(lens.id)}>Voir les idées</button>
                    ) : (
                      <span>Angle Lofi · {lens.adaptationAngles[0]}</span>
                    )}
                  </footer>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
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

function compareItems(left: ScrollingItem, right: ScrollingItem) {
  const relevanceRank = { high: 3, medium: 2, watch: 1 } as const;
  const relevanceDelta = relevanceRank[right.analysis.confidence] - relevanceRank[left.analysis.confidence];
  if (relevanceDelta) return relevanceDelta;
  const likesDelta = (right.source.metrics.likes ?? -1) - (left.source.metrics.likes ?? -1);
  if (likesDelta) return likesDelta;
  return Date.parse(right.source.capturedAt) - Date.parse(left.source.capturedAt);
}

function surfaceLabel(surface: ScrollingRun["surface"]) {
  if (surface === "home") return "Accueil";
  if (surface === "reels") return "Reels";
  if (surface === "explore") return "Explorer";
  if (surface === "following") return "Abonnements";
  return "Recherche";
}

function castLabel(cast: ScrollingItem["adaptation"]["cast"]) {
  if (cast.character === "lofi-boy") return "Lofi Boy + chien";
  if (cast.character === "both") return "Duo + chat & chien";
  return "Lofi Girl + chat";
}

function humanizeId(value: string) {
  return value
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("fr-FR", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDate(value: string) {
  const candidate = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T12:00:00` : value;
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}
