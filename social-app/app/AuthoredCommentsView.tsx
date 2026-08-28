"use client";

/* eslint-disable @next/next/no-img-element -- thumbnails come from public social metadata with dynamic hosts. */

import { useEffect, useMemo, useState } from "react";

import {
  type AuthoredCommentCategory,
  type AuthoredCommentLike,
  type CommentPlatform,
  authoredCommentCategory,
  commentTarget,
  isAuthoredComment,
} from "../lib/authored-comments";
import {
  SOCIAL_DURATION_FILTERS,
  type SocialDurationFilter,
  matchesSocialDuration,
} from "../lib/social-duration";
import { parseTikTokThumbnailUrl } from "../lib/social-media";

type CommentPost = AuthoredCommentLike & {
  id: string;
  external_post_id: string;
  url: string;
  title: string;
  text: string;
  format: string;
  published_at: string | null;
  likes: number | null;
  comments: number | null;
};

type CommentSort = "recent" | "popular";
type PlatformFilter = CommentPlatform | "all";
type CommentCategoryFilter = AuthoredCommentCategory | "all";

const PAGE_SIZE = 60;
const TIKTOK_COMMENT_THUMBNAILS = new Map<string, string>();
const TIKTOK_COMMENT_THUMBNAIL_REQUESTS = new Map<
  string,
  Promise<string | null>
>();

const PLATFORM_META: Record<
  CommentPlatform,
  { emoji: string; label: string; tone: string }
> = {
  youtube: { emoji: "▶️", label: "YouTube", tone: "red" },
  instagram: { emoji: "📸", label: "Instagram", tone: "pink" },
  tiktok: { emoji: "🎵", label: "TikTok", tone: "cyan" },
  x: { emoji: "𝕏", label: "X", tone: "blue" },
};

const COMMENT_CATEGORY_META: Record<
  CommentCategoryFilter,
  { emoji: string; label: string }
> = {
  all: { emoji: "💬", label: "Toutes" },
  community: { emoji: "🖼️", label: "Posts Communauté" },
  owned: { emoji: "🏠", label: "Nos contenus" },
  external: { emoji: "🌍", label: "Autres créateurs" },
};

function formatCompact(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatShortDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).format(date);
}

function categoryLabel(
  category: CommentCategoryFilter,
  platform: PlatformFilter,
): string {
  if (category === "owned" && platform === "youtube") return "Nos vidéos";
  if (category === "external" && platform === "youtube") return "Vidéos externes";
  return COMMENT_CATEGORY_META[category].label;
}

function externalHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function popularity(post: CommentPost): number {
  return (post.likes ?? 0) + (post.comments ?? 0) * 2;
}

function audienceText(post: CommentPost): string {
  const target = commentTarget(post);
  if (target.audienceLabel) return target.audienceLabel;
  if (target.audienceValue !== null) {
    return `${formatCompact(target.audienceValue)} abonnés`;
  }
  return "Audience à enrichir";
}

function tiktokTargetId(post: CommentPost): string | null {
  if (post.platform !== "tiktok") return null;
  const target = commentTarget(post);
  try {
    const url = new URL(target.url);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "tiktok.com" && !url.hostname.endsWith(".tiktok.com"))
    ) {
      return null;
    }
    return url.pathname.match(/\/video\/(\d{12,24})(?:\/|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function requestTikTokCommentThumbnail(
  id: string,
  targetUrl: string,
): Promise<string | null> {
  const cached = TIKTOK_COMMENT_THUMBNAILS.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = TIKTOK_COMMENT_THUMBNAIL_REQUESTS.get(id);
  if (pending) return pending;

  const request = fetch(
    `https://www.tiktok.com/oembed?url=${encodeURIComponent(targetUrl)}`,
    { mode: "cors" },
  )
    .then(async (response) => {
      if (!response.ok) return null;
      const payload = (await response.json()) as { thumbnail_url?: unknown };
      const thumbnail = parseTikTokThumbnailUrl(payload.thumbnail_url);
      if (!thumbnail) return null;
      TIKTOK_COMMENT_THUMBNAILS.set(id, thumbnail.url);
      return thumbnail.url;
    })
    .catch(() => null)
    .finally(() => TIKTOK_COMMENT_THUMBNAIL_REQUESTS.delete(id));
  TIKTOK_COMMENT_THUMBNAIL_REQUESTS.set(id, request);
  return request;
}

function useCommentThumbnail(post: CommentPost): string | null {
  const target = commentTarget(post);
  const tiktokId = tiktokTargetId(post);
  const [loaded, setLoaded] = useState<{ id: string; url: string } | null>(null);

  useEffect(() => {
    if (target.thumbnailUrl || !tiktokId) return;
    let cancelled = false;
    void requestTikTokCommentThumbnail(tiktokId, target.url).then((url) => {
      if (!cancelled && url) setLoaded({ id: tiktokId, url });
    });
    return () => {
      cancelled = true;
    };
  }, [target.thumbnailUrl, target.url, tiktokId]);

  if (target.thumbnailUrl) return target.thumbnailUrl;
  if (!tiktokId) return null;
  return loaded?.id === tiktokId
    ? loaded.url
    : (TIKTOK_COMMENT_THUMBNAILS.get(tiktokId) ?? null);
}

function CommentCard({ post }: { post: CommentPost }) {
  const meta = PLATFORM_META[post.platform];
  const target = commentTarget(post);
  const thumbnailUrl = useCommentThumbnail(post);
  const threadUrl = externalHref(post.url) ?? externalHref(target.url);
  const targetAccount =
    target.authorName ??
    (target.authorHandle ? `@${target.authorHandle}` : "Compte non fourni");

  return (
    <article className={`authored-comment-card tone-${meta.tone}`}>
      {threadUrl ? (
        <a
          className="authored-comment-thumbnail"
          href={threadUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Ouvrir le contenu et son fil de commentaires sur ${meta.label}`}
        >
          {thumbnailUrl ? (
            <img src={thumbnailUrl} alt="" loading="lazy" />
          ) : (
            <span className="authored-comment-thumbnail-placeholder">
              <b aria-hidden="true">{meta.emoji}</b>
              <strong>{target.authorHandle ? `@${target.authorHandle}` : meta.label}</strong>
              <span>{target.title}</span>
            </span>
          )}
          <span className="authored-comment-platform-badge">
            {meta.emoji} {meta.label}
          </span>
          <span className="authored-comment-open-mark" aria-hidden="true">↗</span>
        </a>
      ) : (
        <div className="authored-comment-thumbnail is-disabled">
          <span className="authored-comment-thumbnail-placeholder">
            <b aria-hidden="true">{meta.emoji}</b>
            <strong>{target.authorHandle ? `@${target.authorHandle}` : meta.label}</strong>
            <span>{target.title}</span>
          </span>
        </div>
      )}

      <div className="authored-comment-body">
        <h3>{target.title}</h3>
        <div className="authored-comment-target-strip">
          <div className="authored-comment-target-summary">
            {target.authorProfileUrl ? (
              <a href={target.authorProfileUrl} target="_blank" rel="noreferrer">
                {targetAccount}
              </a>
            ) : (
              <strong>{targetAccount}</strong>
            )}
            <span aria-hidden="true">·</span>
            <b title={target.audienceObservedAt ? `Relevé le ${formatShortDate(target.audienceObservedAt)}` : undefined}>
              👥 {audienceText(post)}
            </b>
          </div>
          <time dateTime={post.published_at ?? undefined} title={post.published_at ?? "Date non fournie"}>
            {formatShortDate(post.published_at)}
          </time>
        </div>
        <blockquote>
          <p>{post.text || "Commentaire non fourni"}</p>
          <div className="authored-comment-metrics" aria-label="Likes et réponses du commentaire">
            <span>
              <b>❤️ {post.likes === null ? "—" : formatCompact(post.likes)}</b>
              <small>Likes</small>
            </span>
            <span>
              <b>↩️ {post.comments === null ? "—" : formatCompact(post.comments)}</b>
              <small>Réponses</small>
            </span>
          </div>
        </blockquote>
      </div>
    </article>
  );
}

export function AuthoredCommentsView({
  posts,
  generatedAt,
  platform,
}: {
  posts: readonly CommentPost[];
  generatedAt: string;
  platform: PlatformFilter;
}) {
  const [duration, setDuration] = useState<SocialDurationFilter>("all");
  const [sort, setSort] = useState<CommentSort>("recent");
  const [category, setCategory] = useState<CommentCategoryFilter>("all");
  const [pagination, setPagination] = useState({ key: "", count: PAGE_SIZE });
  const activePlatformLabel = platform === "all"
    ? "Commentaires"
    : `Commentaires ${PLATFORM_META[platform].label}`;

  const allComments = useMemo(
    () => posts.filter((post) => isAuthoredComment(post)),
    [posts],
  );
  const datedComments = useMemo(
    () => allComments.filter(
      (post) =>
        (platform === "all" || post.platform === platform) &&
        matchesSocialDuration(post, duration, generatedAt),
    ),
    [allComments, duration, generatedAt, platform],
  );
  const categoryCounts = useMemo(() => {
    const counts: Record<AuthoredCommentCategory, number> = {
      community: 0,
      owned: 0,
      external: 0,
    };
    for (const post of datedComments) counts[authoredCommentCategory(post)] += 1;
    return counts;
  }, [datedComments]);
  const categoryOptions = useMemo(
    () => ([
      {
        key: "all" as const,
        ...COMMENT_CATEGORY_META.all,
        label: categoryLabel("all", platform),
        count: datedComments.length,
      },
      ...(["community", "owned", "external"] as const)
        .filter((key) => categoryCounts[key] > 0)
        .map((key) => ({
          key,
          ...COMMENT_CATEGORY_META[key],
          label: categoryLabel(key, platform),
          count: categoryCounts[key],
        })),
    ]),
    [categoryCounts, datedComments.length, platform],
  );

  const activeCategory = categoryOptions.some((option) => option.key === category)
    ? category
    : "all";

  const filteredComments = useMemo(() => {
    const next = activeCategory === "all"
      ? datedComments
      : datedComments.filter((post) => authoredCommentCategory(post) === activeCategory);
    return [...next].sort((left, right) => {
      if (sort === "popular") {
        const scoreOrder = popularity(right) - popularity(left);
        if (scoreOrder) return scoreOrder;
      }
      return String(right.published_at ?? "").localeCompare(
        String(left.published_at ?? ""),
      );
    });
  }, [activeCategory, datedComments, sort]);
  const paginationKey = `${platform}:${duration}:${activeCategory}:${sort}`;
  const visibleCount =
    pagination.key === paginationKey ? pagination.count : PAGE_SIZE;
  const visibleComments = filteredComments.slice(0, visibleCount);

  return (
    <div className="view-stack authored-comments-view">
      <section className="top-ranking-controls tone-all authored-comments-controls" aria-label="Contrôles des commentaires">
        <div className="all-posts-heading">
          <span className="section-kicker">Commentaires publiés par Lofi Girl</span>
          <h2>💬 {activePlatformLabel}</h2>
        </div>

        <div className="authored-comment-filter-row">
          <label>
            <span>Catégorie</span>
            <select value={activeCategory} onChange={(event) => setCategory(event.target.value as CommentCategoryFilter)}>
              {categoryOptions.map((option) => (
                <option value={option.key} key={option.key}>
                  {option.emoji} {option.label} · {formatCompact(option.count)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Date de publication</span>
            <select value={duration} onChange={(event) => setDuration(event.target.value as SocialDurationFilter)}>
              {SOCIAL_DURATION_FILTERS.map((option) => (
                <option value={option.key} key={option.key}>{option.emoji} {option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Trier</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as CommentSort)}>
              <option value="recent">🗓️ Plus récent</option>
              <option value="popular">🏆 Plus populaire</option>
            </select>
          </label>
        </div>

      </section>

      <section className="category-results tone-all" aria-labelledby="all-comments-title">
        <header className="category-results-header">
          <div>
            <span className="section-kicker">Historique propriétaire</span>
            <h2 id="all-comments-title">💬 Conversations engagées</h2>
          </div>
          <span>{formatCompact(filteredComments.length)} commentaires</span>
        </header>

        {filteredComments.length ? (
          <>
            <div className="authored-comment-grid">
              {visibleComments.map((post) => <CommentCard post={post} key={post.id} />)}
            </div>
            {visibleComments.length < filteredComments.length ? (
              <div className="progressive-pagination">
                <span>{visibleComments.length} sur {filteredComments.length} commentaires affichés</span>
                <button
                  className="button ghost"
                  type="button"
                  onClick={() =>
                    setPagination({
                      key: paginationKey,
                      count: visibleCount + PAGE_SIZE,
                    })
                  }
                >
                  Afficher {Math.min(PAGE_SIZE, filteredComments.length - visibleComments.length)} de plus ↓
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="empty-state">
            <span>💬</span>
            <h3>Aucun commentaire importé pour ce filtre</h3>
            <p>Les scans propriétaires ajoutent uniquement les commentaires réellement observés.</p>
          </div>
        )}
      </section>
    </div>
  );
}
