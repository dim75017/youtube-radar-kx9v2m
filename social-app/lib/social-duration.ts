export const SOCIAL_DURATION_FILTERS = [
  { key: "30d", label: "30 jours", emoji: "📅", days: 30 },
  { key: "90d", label: "3 mois", emoji: "🗓️", days: 90 },
  { key: "180d", label: "6 mois", emoji: "🌗", days: 180 },
  { key: "365d", label: "1 an", emoji: "📆", days: 365 },
  { key: "all", label: "All time", emoji: "♾️", days: null },
] as const;

export type SocialDurationFilter =
  (typeof SOCIAL_DURATION_FILTERS)[number]["key"];

export type DatedSocialPost = {
  published_at?: string | null;
  publishedAt?: string | null;
};

const DAY_MS = 86_400_000;

export function hasKnownSocialPublishedDate(post: DatedSocialPost): boolean {
  return socialPublishedTimestamp(post) !== null;
}

export function matchesSocialDuration(
  post: DatedSocialPost,
  filter: SocialDurationFilter,
  referenceDate: string | number | Date,
): boolean {
  if (filter === "all") return true;

  const publishedAt = socialPublishedTimestamp(post);
  const referenceAt = referenceTimestamp(referenceDate);
  if (publishedAt === null || referenceAt === null) return false;

  const option = SOCIAL_DURATION_FILTERS.find((item) => item.key === filter);
  if (!option || option.days === null) return true;
  const cutoff = referenceAt - option.days * DAY_MS;
  return publishedAt >= cutoff && publishedAt <= referenceAt;
}

function socialPublishedTimestamp(post: DatedSocialPost): number | null {
  const value = post.published_at ?? post.publishedAt;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function referenceTimestamp(value: string | number | Date): number | null {
  const parsed =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
