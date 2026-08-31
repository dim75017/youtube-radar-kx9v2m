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
import {
  FilterDropdown,
  type FilterDropdownOption,
} from "./FilterDropdown";

type CommentPost = AuthoredCommentLike & {
  id: string;
  external_post_id: string;
  url: string;
  title: string;
  text: string;
  format: string;
  published_at: string | null;
  published_at_precision?: "exact" | "approximate" | "unknown";
  likes: number | null;
  comments: number | null;
};

type CommentSort = "recent" | "popular";
type PlatformFilter = CommentPlatform | "all";
type CommentCategoryFilter = AuthoredCommentCategory | "all";

const DEFAULT_PAGE_SIZE = 60;
const INSTAGRAM_PAGE_SIZE = 120;
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

const COMMENT_SORT_OPTIONS: readonly FilterDropdownOption<CommentSort>[] = [
  { key: "recent", emoji: "🗓️", label: "Plus récent" },
  { key: "popular", emoji: "🏆", label: "Plus populaire" },
];

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

function commentDate(post: CommentPost): { label: string; title: string } {
  if (!post.published_at) {
    return { label: "—", title: "Date non fournie par la source" };
  }
  const formatted = formatShortDate(post.published_at);
  if (post.published_at_precision === "approximate") {
    return {
      label: `≈ ${formatted}`,
      title: "Date approximative calculée depuis l’âge relatif affiché par Instagram",
    };
  }
  return { label: formatted, title: "Date de publication du commentaire" };
}

function commentMetric(
  post: CommentPost,
  value: number | null,
): { label: string; title?: string } {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { label: formatCompact(value) };
  }
  if (post.platform === "instagram") {
    return {
      label: "Non fourni",
      title: "Ce compteur n’est pas présent dans l’historique Instagram actuellement importé",
    };
  }
  return { label: "—" };
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
  if (!target.url || target.unavailable) return null;
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
    if (target.thumbnailUrl || !tiktokId || !target.url) return;
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
  const threadUrl = target.unavailable
    ? null
    : (target.url ? externalHref(target.url) : null) ?? externalHref(post.url);
  const targetAccount =
    target.authorName ??
    (target.authorHandle ? `@${target.authorHandle}` : "Compte non fourni");
  const date = commentDate(post);
  const likes = commentMetric(post, post.likes);
  const replies = commentMetric(post, post.comments);

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
              <strong>{targetAccount}</strong>
              <span>{target.title}</span>
            </span>
          )}
        </a>
      ) : (
        <div
          className="authored-comment-thumbnail is-disabled"
          aria-label={`Contenu source non relié sur ${meta.label}`}
          title="Lien du contenu non fourni par l’historique natif"
        >
          {thumbnailUrl ? (
            <img src={thumbnailUrl} alt="" loading="lazy" />
          ) : (
            <span className="authored-comment-thumbnail-placeholder">
              <b aria-hidden="true">{meta.emoji}</b>
              <strong>{targetAccount}</strong>
              <span>{target.title}</span>
            </span>
          )}
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
          <time dateTime={post.published_at ?? undefined} title={date.title}>
            {date.label}
          </time>
        </div>
        <blockquote>
          <p>{post.text || "Commentaire non fourni"}</p>
          <div className="authored-comment-metrics" aria-label="Likes et réponses du commentaire">
            <span title={likes.title}>
              <b>❤️ {likes.label}</b>
              <small>Likes</small>
            </span>
            <span title={replies.title}>
              <b>↩️ {replies.label}</b>
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
  const [sort, setSort] = useState<CommentSort>(
    platform === "instagram" ? "recent" : "popular",
  );
  const pageSize = platform === "instagram" ? INSTAGRAM_PAGE_SIZE : DEFAULT_PAGE_SIZE;
  const [category, setCategory] = useState<CommentCategoryFilter>(
    platform === "instagram" ? "all" : "external",
  );
  const [pagination, setPagination] = useState({ key: "", count: pageSize });
  const activePlatformLabel = platform === "all"
    ? "Commentaires"
    : `Commentaires ${PLATFORM_META[platform].label}`;

  const allComments = useMemo(
    () => posts.filter((post) => isAuthoredComment(post)),
    [posts],
  );
  const platformComments = useMemo(
    () => allComments.filter(
      (post) => platform === "all" || post.platform === platform,
    ),
    [allComments, platform],
  );
  const datedComments = useMemo(
    () => platformComments.filter(
      (post) => matchesSocialDuration(post, duration, generatedAt),
    ),
    [duration, generatedAt, platformComments],
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
      ...(["external", "owned", "community"] as const)
        .filter((key) => categoryCounts[key] > 0)
        .map((key) => ({
          key,
          ...COMMENT_CATEGORY_META[key],
          label: categoryLabel(key, platform),
          count: categoryCounts[key],
        })),
      {
        key: "all" as const,
        ...COMMENT_CATEGORY_META.all,
        label: categoryLabel("all", platform),
        count: datedComments.length,
      },
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
    pagination.key === paginationKey ? pagination.count : pageSize;
  const visibleComments = filteredComments.slice(0, visibleCount);

  return (
    <div className="view-stack authored-comments-view">
      <section
        className={`category-results tone-${platform === "all" ? "all" : PLATFORM_META[platform].tone}`}
        aria-label={activePlatformLabel}
      >
        <header className="category-results-header category-results-toolbar">
          <div className="category-results-adjacent-filters">
            <FilterDropdown
              id={`comment-category-filter-${platform}`}
              label="Catégorie"
              value={activeCategory}
              options={categoryOptions}
              onChange={setCategory}
            />
            <FilterDropdown
              id={`comment-duration-filter-${platform}`}
              label="Date de publication"
              value={duration}
              options={SOCIAL_DURATION_FILTERS}
              onChange={setDuration}
            />
          </div>
          <div className="category-results-sort-filter">
            <FilterDropdown
              id={`comment-sort-filter-${platform}`}
              label="Trier"
              value={sort}
              options={COMMENT_SORT_OPTIONS}
              onChange={setSort}
            />
          </div>
        </header>

        <p className="authored-comments-result-count">
          {filteredComments.length} commentaire{filteredComments.length > 1 ? "s" : ""} dans ce filtre
          {platform === "instagram" && filteredComments.length !== platformComments.length
            ? ` · ${platformComments.length} présents dans le dashboard`
            : ""}
        </p>

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
                      count: visibleCount + pageSize,
                    })
                  }
                >
                  Afficher {Math.min(pageSize, filteredComments.length - visibleComments.length)} de plus ↓
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
