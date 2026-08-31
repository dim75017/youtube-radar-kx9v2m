"use client";

import { useMemo } from "react";

import {
  buildYoutubeExternalCommentMonthlyImpact,
  type CommentPerformancePost,
  type YoutubeCommentRefreshStatus,
} from "../lib/comment-performance";

const MONTH_COUNT = 36;
const WIDTH = 1200;
const HEIGHT = 360;
const LEFT = 58;
const RIGHT = 78;
const TOP = 34;
const BOTTOM = 54;
const VIRAL_THRESHOLD = 10_000;
const TICKS = [0, 0.25, 0.5, 0.75, 1] as const;

function formatInteger(value: number): string {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function niceMaximum(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function compactText(value: string, maximum = 90): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

export function YoutubeCommentAnalyticsChart({
  generatedAt,
  posts,
  refreshStatus,
}: {
  generatedAt: string;
  posts: readonly CommentPerformancePost[];
  refreshStatus: YoutubeCommentRefreshStatus | null;
}) {
  const summary = useMemo(
    () => buildYoutubeExternalCommentMonthlyImpact(posts, generatedAt, MONTH_COUNT),
    [generatedAt, posts],
  );
  if (summary.commentsPublished === 0) return null;

  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const step = plotWidth / summary.points.length;
  const barWidth = Math.max(8, Math.min(22, step * 0.58));
  const commentMaximum = niceMaximum(Math.max(
    1,
    ...summary.points.map((point) => point.commentsPublished),
  ));
  const interactionMaximum = niceMaximum(Math.max(
    1,
    ...summary.points.map((point) => point.interactionsReceived),
  ));
  const xAt = (index: number) => LEFT + step * (index + 0.5);
  const commentY = (value: number) => TOP + plotHeight - (value / commentMaximum) * plotHeight;
  const interactionY = (value: number) => TOP + plotHeight - (value / interactionMaximum) * plotHeight;
  const interactionPath = summary.points.map((point, index) => (
    `${index === 0 ? "M" : "L"} ${xAt(index).toFixed(2)} ${interactionY(point.interactionsReceived).toFixed(2)}`
  )).join(" ");
  const inventoryObservedAt = refreshStatus?.inventoryObservedAt ?? summary.latestPublishedAt;
  const partialMonthKey = refreshStatus?.inventoryStatus === "stale" && inventoryObservedAt
    ? inventoryObservedAt.slice(0, 7)
    : null;
  const partialMonth = partialMonthKey
    ? summary.points.find((point) => point.key === partialMonthKey) ?? null
    : null;

  return (
    <section
      className="youtube-comment-analytics"
      aria-labelledby="youtube-comment-analytics-title"
    >
      <header className="youtube-comment-analytics-header">
        <div>
          <span className="section-kicker">Impact des commentaires externes</span>
          <h3 id="youtube-comment-analytics-title">Commentaires publiés par mois</h3>
        </div>
        <div className="youtube-comment-analytics-legend" aria-label="Légende">
          <span><i className="comments" />Commentaires publiés</span>
          <span><i className="interactions" />Interactions reçues</span>
          <span><i className="viral" />Commentaire à +10 k</span>
        </div>
      </header>

      <div className="youtube-comment-analytics-viewport">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`Sur les ${MONTH_COUNT} derniers mois, ${formatInteger(summary.commentsPublished)} commentaires ont été publiés sur des vidéos externes et ont reçu ${formatInteger(summary.interactionsReceived)} interactions observées.`}
        >
          <defs>
            <linearGradient id="youtube-comment-bars" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#ff9aaa" />
              <stop offset="100%" stopColor="#fb7185" />
            </linearGradient>
            <pattern id="youtube-comment-partial" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="8" height="8" fill="#fb7185" opacity="0.52" />
              <rect width="3" height="8" fill="#ffd1d8" opacity="0.78" />
            </pattern>
            <filter id="youtube-comment-viral-glow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {TICKS.map((ratio) => {
            const y = TOP + plotHeight - ratio * plotHeight;
            return (
              <g className="youtube-comment-analytics-grid" key={ratio}>
                <line x1={LEFT} x2={WIDTH - RIGHT} y1={y} y2={y} />
                <text x={LEFT - 10} y={y + 4} textAnchor="end">
                  {formatCompact(Math.round(commentMaximum * ratio))}
                </text>
                <text x={WIDTH - RIGHT + 10} y={y + 4} textAnchor="start">
                  {formatCompact(Math.round(interactionMaximum * ratio))}
                </text>
              </g>
            );
          })}

          <text className="youtube-comment-analytics-axis-title" x={LEFT} y={15}>
            Commentaires
          </text>
          <text
            className="youtube-comment-analytics-axis-title"
            x={WIDTH - RIGHT}
            y={15}
            textAnchor="end"
          >
            Interactions
          </text>

          {summary.points.map((point, index) => {
            const x = xAt(index);
            const y = commentY(point.commentsPublished);
            const height = TOP + plotHeight - y;
            const isPartial = point.key === partialMonthKey;
            const topComment = point.topComment;
            const tooltip = [
              `${point.label} · ${formatInteger(point.commentsPublished)} commentaire${point.commentsPublished > 1 ? "s" : ""} externe${point.commentsPublished > 1 ? "s" : ""}`,
              `${formatInteger(point.interactionsReceived)} interactions actuellement observées`,
              topComment
                ? `Meilleur commentaire : ${compactText(topComment.text || topComment.title)} · ${formatInteger(topComment.likes)} likes · ${formatInteger(topComment.replies)} réponses`
                : "Aucun compteur disponible ce mois-ci",
              isPartial ? `Mois partiel · inventaire arrêté au ${formatDate(inventoryObservedAt)}` : "",
            ].filter(Boolean).join("\n");

            return (
              <g
                className={`youtube-comment-analytics-month ${isPartial ? "partial" : ""}`}
                aria-label={tooltip}
                tabIndex={0}
                key={point.key}
              >
                <title>{tooltip}</title>
                <rect
                  x={x - barWidth / 2}
                  y={y}
                  width={barWidth}
                  height={Math.max(point.commentsPublished ? 2 : 0, height)}
                  rx="4"
                  fill={isPartial ? "url(#youtube-comment-partial)" : "url(#youtube-comment-bars)"}
                />
                {(index % 3 === 0 || index === summary.points.length - 1) ? (
                  <text
                    className="youtube-comment-analytics-month-label"
                    x={x}
                    y={HEIGHT - 25}
                    textAnchor="middle"
                  >
                    {point.label}
                  </text>
                ) : null}
              </g>
            );
          })}

          <path className="youtube-comment-analytics-line" d={interactionPath} />
          {summary.points.map((point, index) => {
            const viral = (point.topComment?.interactions ?? 0) >= VIRAL_THRESHOLD;
            const tooltip = point.topComment
              ? `${point.label} · ${formatInteger(point.interactionsReceived)} interactions · meilleur commentaire : ${compactText(point.topComment.text || point.topComment.title)} (${formatInteger(point.topComment.likes)} likes, ${formatInteger(point.topComment.replies)} réponses)`
              : `${point.label} · ${formatInteger(point.interactionsReceived)} interactions`;
            return (
              <circle
                className={viral ? "youtube-comment-analytics-point viral" : "youtube-comment-analytics-point"}
                cx={xAt(index)}
                cy={interactionY(point.interactionsReceived)}
                r={viral ? 5.5 : 2.8}
                filter={viral ? "url(#youtube-comment-viral-glow)" : undefined}
                key={`interaction-${point.key}`}
              >
                <title>{tooltip}</title>
              </circle>
            );
          })}
        </svg>
      </div>

      <footer className="youtube-comment-analytics-caption">
        <p>
          Barres : commentaires de Lofi Girl sur les vidéos d’autres créateurs. Courbe : likes + réponses actuellement observés sur les commentaires publiés chaque mois.
        </p>
        <p>
          YouTube ne fournit pas les visites de chaîne ni les abonnements attribuables à un commentaire : aucune causalité n’est inventée.
        </p>
        {partialMonth ? (
          <span>
            {partialMonth.label} partiel · inventaire arrêté au {formatDate(inventoryObservedAt)}
          </span>
        ) : null}
      </footer>
    </section>
  );
}
