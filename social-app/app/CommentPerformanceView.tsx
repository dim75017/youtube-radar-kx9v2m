"use client";

import { useMemo, useState, type CSSProperties } from "react";

import {
  buildYoutubeCommentPerformance,
  type CommentPerformanceBucket,
  type CommentEngagementTrackingPoint,
  type CommentPerformancePost,
  type YoutubeCommentRefreshStatus,
} from "../lib/comment-performance";
import {
  SOCIAL_DURATION_FILTERS,
  type SocialDurationFilter,
} from "../lib/social-duration";
import { FilterDropdown } from "./FilterDropdown";

function formatInteger(value: number): string {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDecimal(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
  }).format(value);
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("fr-FR", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatSigned(value: number): string {
  const formatted = formatInteger(Math.abs(value));
  return value > 0 ? `+${formatted}` : value < 0 ? `−${formatted}` : "0";
}

function formatTrackingInterval(point: CommentEngagementTrackingPoint): string {
  if (!point.firstComparedAt || !point.lastComparedAt) return point.label;
  const first = new Date(point.firstComparedAt);
  const last = new Date(point.lastComparedAt);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return point.label;
  const day = new Intl.DateTimeFormat("fr-FR", { day: "numeric", timeZone: "UTC" });
  const dayMonth = new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return first.getUTCMonth() === last.getUTCMonth() &&
    first.getUTCFullYear() === last.getUTCFullYear()
    ? `${day.format(first)}→${dayMonth.format(last)}`
    : `${dayMonth.format(first)}→${dayMonth.format(last)}`;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function visibleTick(index: number, total: number): boolean {
  if (index === total - 1) return true;
  const step = Math.max(1, Math.ceil(total / 8));
  return index % step === 0;
}

function ActivityChart({ buckets }: { buckets: readonly CommentPerformanceBucket[] }) {
  const maximum = Math.max(
    1,
    ...buckets.map((bucket) => bucket.commentsPublished + bucket.repliesPublished),
  );

  return (
    <div
      className="comment-performance-chart"
      role="img"
      aria-label="Nombre de commentaires et de réponses publiés au fil du temps"
    >
      <div
        className="comment-performance-chart-columns"
        style={{ "--bucket-count": buckets.length } as CSSProperties}
      >
        {buckets.map((bucket, index) => {
          const commentHeight = bucket.commentsPublished
            ? Math.max(2, (bucket.commentsPublished / maximum) * 100)
            : 0;
          const replyHeight = bucket.repliesPublished
            ? Math.max(2, (bucket.repliesPublished / maximum) * 100)
            : 0;
          const total = bucket.commentsPublished + bucket.repliesPublished;
          return (
            <div
              className="comment-performance-chart-column"
              title={`${bucket.label} · ${formatInteger(total)} intervention${total > 1 ? "s" : ""} · ${formatInteger(bucket.commentsPublished)} commentaires · ${formatInteger(bucket.repliesPublished)} réponses`}
              key={bucket.key}
            >
              <span className="comment-performance-bar-value">
                {total && visibleTick(index, buckets.length) ? formatCompact(total) : ""}
              </span>
              <div className="comment-performance-bar-stack" aria-hidden="true">
                <span
                  className="comment-performance-bar replies"
                  style={{ height: `${replyHeight}%` }}
                />
                <span
                  className="comment-performance-bar comments"
                  style={{ height: `${commentHeight}%` }}
                />
              </div>
              <span className="comment-performance-axis-label">
                {visibleTick(index, buckets.length) ? bucket.label : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EngagementEvolutionChart({
  points,
}: {
  points: readonly CommentEngagementTrackingPoint[];
}) {
  const maximum = Math.max(
    1,
    ...points.map((point) =>
      Math.abs(point.likesNetChange + point.repliesNetChange),
    ),
  );

  return (
    <div
      className="comment-performance-chart engagement-evolution-chart"
      role="img"
      aria-label="Évolution réellement mesurée des interactions reçues"
    >
      <div
        className="comment-performance-chart-columns"
        style={{ "--bucket-count": points.length } as CSSProperties}
      >
        {points.map((point, index) => {
          const value = point.likesNetChange + point.repliesNetChange;
          const height = value ? Math.max(2, (Math.abs(value) / maximum) * 100) : 0;
          const interval = formatTrackingInterval(point);
          return (
            <div
              className="comment-performance-chart-column"
              title={`${interval} · ${formatSigned(value)} interactions · ${formatSigned(point.likesNetChange)} likes · ${formatSigned(point.repliesNetChange)} réponses · ${formatInteger(point.comparedCount)} commentaires comparés`}
              key={point.key}
            >
              <span className="comment-performance-bar-value">
                {value && visibleTick(index, points.length) ? formatCompact(value) : ""}
              </span>
              <div className="comment-performance-delta-track" aria-hidden="true">
                <span
                  className={value < 0 ? "negative" : "positive"}
                  style={{ height: `${height}%` }}
                />
              </div>
              <span className="comment-performance-axis-label">
                {value ? interval : visibleTick(index, points.length) ? point.label : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CommentPerformanceView({
  posts,
  generatedAt,
  refreshStatus,
}: {
  posts: readonly CommentPerformancePost[];
  generatedAt: string;
  refreshStatus: YoutubeCommentRefreshStatus | null;
}) {
  const [period, setPeriod] = useState<SocialDurationFilter>("365d");
  const summary = useMemo(
    () => buildYoutubeCommentPerformance(posts, generatedAt, period),
    [generatedAt, period, posts],
  );
  const metricCoverage = summary.inventoryTotal
    ? summary.inventoryMeasured / summary.inventoryTotal
    : 0;
  const best = summary.bestComment;
  const inventoryObservedAt = refreshStatus?.inventoryObservedAt ?? summary.latestPublishedAt;
  const metricObservedAt = refreshStatus?.lastRealObservationAt ?? summary.latestMetricAt;
  const inventoryIsStale = refreshStatus?.inventoryStatus === "stale";

  return (
    <section className="comment-performance-view" aria-labelledby="comment-performance-title">
      <header className="comment-performance-heading">
        <div>
          <span className="section-kicker">YouTube · Commentaires & réponses</span>
          <h2 id="comment-performance-title">Performance des commentaires</h2>
          <p>
            Volume publié, interactions reçues et progression réellement observée.
            Les compteurs absents restent exclus des calculs.
          </p>
        </div>
        <FilterDropdown
          id="comment-performance-period"
          label="Période"
          value={period}
          options={SOCIAL_DURATION_FILTERS}
          onChange={setPeriod}
        />
      </header>

      <div className={`comment-performance-data-status ${inventoryIsStale ? "stale" : ""}`}>
        <span aria-hidden="true">{inventoryIsStale ? "⚠️" : "✓"}</span>
        <div>
          <strong>Inventaire connu au {formatDate(inventoryObservedAt)}</strong>
          <p>
            {inventoryIsStale
              ? "Les métriques des commentaires déjà connus sont relues, mais les nouveaux commentaires ne sont pas ajoutés automatiquement tant qu’un nouvel export propriétaire n’est pas importé."
              : "L’inventaire et ses compteurs affichent les dernières observations disponibles."}
          </p>
        </div>
        <small>Métriques relues le {formatDate(metricObservedAt)}</small>
      </div>

      <div className="comment-performance-kpis">
        <article>
          <span>Interventions publiées</span>
          <strong>{formatInteger(summary.totalPublished)}</strong>
          <small>
            {formatInteger(summary.commentsPublished)} commentaires · {formatInteger(summary.repliesPublished)} réponses
          </small>
        </article>
        <article>
          <span>Interactions reçues</span>
          <strong>{formatCompact(summary.interactionsReceived)}</strong>
          <small>
            {formatCompact(summary.likesReceived)} likes · {formatCompact(summary.repliesReceived)} réponses reçues
          </small>
        </article>
        <article>
          <span>Avec au moins 1 interaction</span>
          <strong>{formatPercent(summary.engagedShare)}</strong>
          <small>
            médiane {formatDecimal(summary.medianInteractions)} interaction par intervention
          </small>
        </article>
        <article className="comment-attribution-kpi">
          <span>Abonnés attribués aux commentaires</span>
          <strong>Non attribuable</strong>
          <small>YouTube ne fournit pas cette attribution</small>
        </article>
      </div>

      <div className="comment-performance-chart-grid">
        <article className="comment-performance-panel">
          <header>
            <div>
              <span className="section-kicker">Cadence</span>
              <h3>Activité publiée</h3>
            </div>
            <div className="comment-performance-legend" aria-label="Légende">
              <span><i className="comments" />Commentaires</span>
              <span><i className="replies" />Réponses</span>
            </div>
          </header>
          <ActivityChart buckets={summary.buckets} />
          <p className="comment-performance-caption">
            Commentaires de premier niveau et réponses écrites par Lofi Girl, regroupés par date de publication.
          </p>
        </article>

        <article className="comment-performance-panel">
          <header>
            <div>
              <span className="section-kicker">Progression observée</span>
              <h3>Évolution des interactions reçues</h3>
            </div>
            <span className="comment-performance-coverage">
              {formatInteger(summary.tracking.comparedCount)} comparés
            </span>
          </header>
          <EngagementEvolutionChart points={summary.tracking.points} />
          <p className="comment-performance-caption">
            Chaque barre couvre l’intervalle affiché entre deux relevés du même commentaire. Les gains ne sont jamais répartis artificiellement entre ces deux dates.
          </p>
        </article>
      </div>

      <div className="comment-performance-proof-grid">
        <article className="comment-performance-proof">
          <span aria-hidden="true">↗</span>
          <div>
            <small>Progression réellement observée</small>
            <strong>
              {summary.tracking.comparedCount
                ? `${formatSigned(summary.tracking.likesNetChange)} likes · ${formatSigned(summary.tracking.repliesNetChange)} réponses`
                : "Pas encore deux relevés comparables"}
            </strong>
            <p>
              {summary.tracking.comparedCount
                ? `${formatInteger(summary.tracking.comparedCount)} commentaires relus entre le ${formatDate(summary.tracking.firstComparedAt)} et le ${formatDate(summary.tracking.lastComparedAt)}.`
                : "La progression apparaîtra après un second relevé du même commentaire."}
            </p>
          </div>
        </article>

        <article className="comment-performance-proof top-comment-proof">
          <span aria-hidden="true">🏆</span>
          <div>
            <small>Meilleure intervention de la période</small>
            {best ? (
              <>
                <strong>{formatCompact(best.likes)} likes · {formatCompact(best.replies)} réponses</strong>
                <p>{best.text || best.title}</p>
                {best.url ? (
                  <a href={best.url} target="_blank" rel="noreferrer">
                    Ouvrir le commentaire ↗
                  </a>
                ) : null}
              </>
            ) : (
              <p>Aucun commentaire mesurable sur cette période.</p>
            )}
          </div>
        </article>
      </div>

      <div className="comment-performance-method">
        <span aria-hidden="true">ℹ️</span>
        <div>
          <p>
            Les likes et réponses sont les compteurs actuels des commentaires publiés pendant la période.
            Leur évolution suit tout l’inventaire connu et n’est calculée qu’entre deux relevés réels du même commentaire dans la période, jamais reconstruite rétroactivement.
          </p>
          <p>
            {summary.inventoryExactDates
              ? `${formatInteger(summary.inventoryExactDates)} dates sont exactes et ${formatInteger(summary.inventoryApproximateDates)} conservent l’année inférée par l’import My Activity.`
              : "Les dates historiques conservent la précision fournie par l’import My Activity."}
          </p>
          <p>
            YouTube ne relie aucun abonnement à un commentaire précis. Même le total de la chaîne ne montrerait qu’une coïncidence temporelle : il n’est donc pas utilisé ici comme résultat des commentaires.
          </p>
        </div>
        <span className="comment-performance-freshness">
          Inventaire observé le {formatDate(inventoryObservedAt)} · engagement relevé le {formatDate(metricObservedAt)} · {formatInteger(summary.inventoryMeasured)}/{formatInteger(summary.inventoryTotal)} mesurés ({formatPercent(metricCoverage)})
        </span>
      </div>
    </section>
  );
}
