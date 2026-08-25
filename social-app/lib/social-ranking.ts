export type PublicRankingMetric = "likes" | "views" | "poll_votes" | null;

export type PublicMetricPost = {
  external_post_id: string;
  format: string;
  likes: number | null;
  views: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  poll_votes: number | null;
};

export type PublicMetricRanking<T> = {
  metric: PublicRankingMetric;
  posts: T[];
};

export function rankPostsByPublicMetric<T extends PublicMetricPost>(
  source: readonly T[],
): PublicMetricRanking<T> {
  const metric = primaryMetric(source);
  return {
    metric,
    posts: [...source].sort((left, right) => comparePosts(left, right, metric)),
  };
}

export function publicRankingLabel(metric: PublicRankingMetric): string {
  if (metric === "likes") return "Likes décroissants";
  if (metric === "views") return "Vues décroissantes · likes indisponibles";
  if (metric === "poll_votes") return "Votes décroissants · likes indisponibles";
  return "Non classé · likes indisponibles";
}

function primaryMetric(posts: readonly PublicMetricPost[]): PublicRankingMetric {
  if (posts.some((post) => post.likes !== null)) return "likes";
  if (posts.some((post) => post.views !== null)) return "views";
  if (posts.some((post) => post.poll_votes !== null)) return "poll_votes";
  return null;
}

function comparePosts(
  left: PublicMetricPost,
  right: PublicMetricPost,
  primary: PublicRankingMetric,
): number {
  if (primary) {
    const primaryDifference = compareNullableDescending(left[primary], right[primary]);
    if (primaryDifference !== 0) return primaryDifference;
  }

  const pollFirst = /poll|sondage/i.test(left.format) || /poll|sondage/i.test(right.format);
  const secondaryMetrics: Array<Exclude<PublicRankingMetric, null>> = pollFirst
    ? ["poll_votes", "views", "likes"]
    : ["views", "poll_votes", "likes"];

  for (const metric of secondaryMetrics) {
    if (metric === primary) continue;
    const difference = compareNullableDescending(left[metric], right[metric]);
    if (difference !== 0) return difference;
  }

  for (const metric of ["comments", "shares", "saves"] as const) {
    const difference = compareNullableDescending(left[metric], right[metric]);
    if (difference !== 0) return difference;
  }

  return left.external_post_id.localeCompare(right.external_post_id);
}

function compareNullableDescending(
  left: number | null,
  right: number | null,
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}
