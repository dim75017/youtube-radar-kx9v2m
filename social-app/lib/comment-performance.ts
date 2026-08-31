import type { SocialDurationFilter } from "./social-duration";

const DAY_MS = 86_400_000;

const PERIOD_DAYS: Record<SocialDurationFilter, number | null> = {
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "365d": 365,
  all: null,
};

export type CommentPerformanceMetricPoint = {
  captured_at?: string | null;
  capturedAt?: string | null;
  likes?: number | null;
  comments?: number | null;
};

export type CommentPerformancePost = {
  id?: string;
  external_post_id?: string;
  platform?: string;
  format?: string;
  url?: string;
  title?: string;
  text?: string;
  published_at?: string | null;
  published_at_precision?: "exact" | "approximate" | "unknown";
  likes?: number | null;
  comments?: number | null;
  raw_json?: string | null;
  metric_history?: readonly CommentPerformanceMetricPoint[] | null;
};

export type CommentPerformanceBucket = {
  key: string;
  label: string;
  startDate: string;
  endDate: string;
  commentsPublished: number;
  repliesPublished: number;
  measuredCount: number;
  engagedCount: number;
  likesReceived: number;
  repliesReceived: number;
  interactionsReceived: number;
  engagedShare: number | null;
  medianInteractions: number | null;
  cumulativePublished: number;
};

export type CommentEngagementTrackingPoint = {
  key: string;
  label: string;
  startDate: string;
  endDate: string;
  likesNetChange: number;
  repliesNetChange: number;
  comparedCount: number;
  firstComparedAt: string | null;
  lastComparedAt: string | null;
};

export type YoutubeCommentRefreshStatus = {
  status?: string | null;
  inventoryStatus?: string | null;
  inventoryObservedAt?: string | null;
  lastRealObservationAt?: string | null;
  metricCoverage?: {
    observed?: number | null;
    published?: number | null;
    total?: number | null;
  } | null;
  error?: string | null;
};

export type OwnerCommentRefreshStatus = {
  generatedAt?: string | null;
  platforms?: {
    youtube?: YoutubeCommentRefreshStatus | null;
  } | null;
};

export type CommentPerformanceSummary = {
  period: SocialDurationFilter;
  rangeStartDate: string;
  rangeEndDate: string;
  totalPublished: number;
  commentsPublished: number;
  repliesPublished: number;
  measuredCount: number;
  coverageShare: number;
  engagedCount: number;
  engagedShare: number | null;
  likesReceived: number;
  repliesReceived: number;
  interactionsReceived: number;
  medianInteractions: number | null;
  oldestPublishedAt: string | null;
  latestPublishedAt: string | null;
  latestMetricAt: string | null;
  inventoryTotal: number;
  inventoryMeasured: number;
  inventoryExactDates: number;
  inventoryApproximateDates: number;
  selectedApproximateDates: number;
  buckets: CommentPerformanceBucket[];
  tracking: {
    comparedCount: number;
    likesNetChange: number;
    repliesNetChange: number;
    firstComparedAt: string | null;
    lastComparedAt: string | null;
    points: CommentEngagementTrackingPoint[];
  };
  bestComment: {
    id: string;
    url: string;
    title: string;
    text: string;
    publishedAt: string;
    likes: number;
    replies: number;
    interactions: number;
  } | null;
};

type BucketUnit = "day" | "week" | "month" | "year";

type MutableBucket = CommentPerformanceBucket & {
  interactions: number[];
};

export function buildYoutubeCommentPerformance(
  posts: readonly CommentPerformancePost[],
  referenceDate: string,
  period: SocialDurationFilter,
): CommentPerformanceSummary {
  const referenceTime = validTime(referenceDate) ?? Date.now();
  const referenceDay = startOfUtcDay(referenceTime);
  const inventory = posts
    .filter(isYoutubeAuthoredComment)
    .filter((post) => validTime(post.published_at) !== null)
    .sort((left, right) =>
      (validTime(left.published_at) ?? 0) - (validTime(right.published_at) ?? 0),
    );
  const inventoryStart = inventory.length
    ? startOfUtcDay(validTime(inventory[0].published_at) ?? referenceDay)
    : referenceDay;
  const days = PERIOD_DAYS[period];
  const rangeStart = days === null
    ? inventoryStart
    : startOfUtcDay(referenceDay - (days - 1) * DAY_MS);
  const rangeEnd = referenceDay + DAY_MS - 1;
  const selected = inventory.filter((post) => {
    const publishedAt = validTime(post.published_at);
    return publishedAt !== null && publishedAt >= rangeStart && publishedAt <= rangeEnd;
  });
  const unit = bucketUnit(period);
  const buckets = buildEmptyBuckets(rangeStart, rangeEnd, unit);
  const bucketsByKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  const selectedRows = selected.map(commentRow);

  let cumulative = 0;
  for (const row of selectedRows) {
    const bucket = bucketsByKey.get(bucketKey(row.publishedAtTime, unit));
    if (!bucket) continue;
    if (row.kind === "reply") bucket.repliesPublished += 1;
    else bucket.commentsPublished += 1;
    if (row.measured) {
      bucket.measuredCount += 1;
      bucket.likesReceived += row.likes;
      bucket.repliesReceived += row.repliesReceived;
      bucket.interactionsReceived += row.interactions;
      bucket.interactions.push(row.interactions);
      if (row.interactions > 0) bucket.engagedCount += 1;
    }
  }
  for (const bucket of buckets) {
    cumulative += bucket.commentsPublished + bucket.repliesPublished;
    bucket.cumulativePublished = cumulative;
    bucket.engagedShare = bucket.measuredCount
      ? bucket.engagedCount / bucket.measuredCount
      : null;
    bucket.medianInteractions = median(bucket.interactions);
  }

  const measuredRows = selectedRows.filter((row) => row.measured);
  const engagedCount = measuredRows.filter((row) => row.interactions > 0).length;
  const oldestPublishedAt = selected.at(0)?.published_at ?? null;
  const latestPublishedAt = selected.at(-1)?.published_at ?? null;
  const latestMetricAt = latestIso(
    ...selected.flatMap((post) => metricHistory(post).map((point) => point.capturedAt)),
  );
  const tracking = trackingSummary(inventory, rangeStart, rangeEnd, unit);
  const best = [...selectedRows]
    .filter((row) => row.measured)
    .sort((left, right) => right.interactions - left.interactions)[0] ?? null;
  const inventoryMeasured = inventory.filter((post) => commentRow(post).measured).length;

  return {
    period,
    rangeStartDate: isoDay(rangeStart),
    rangeEndDate: isoDay(referenceDay),
    totalPublished: selected.length,
    commentsPublished: selectedRows.filter((row) => row.kind === "comment").length,
    repliesPublished: selectedRows.filter((row) => row.kind === "reply").length,
    measuredCount: measuredRows.length,
    coverageShare: selected.length ? measuredRows.length / selected.length : 0,
    engagedCount,
    engagedShare: measuredRows.length ? engagedCount / measuredRows.length : null,
    likesReceived: measuredRows.reduce((total, row) => total + row.likes, 0),
    repliesReceived: measuredRows.reduce(
      (total, row) => total + row.repliesReceived,
      0,
    ),
    interactionsReceived: measuredRows.reduce(
      (total, row) => total + row.interactions,
      0,
    ),
    medianInteractions: median(measuredRows.map((row) => row.interactions)),
    oldestPublishedAt,
    latestPublishedAt,
    latestMetricAt,
    inventoryTotal: inventory.length,
    inventoryMeasured,
    inventoryExactDates: inventory.filter(
      (post) => post.published_at_precision === "exact",
    ).length,
    inventoryApproximateDates: inventory.filter(
      (post) => post.published_at_precision !== "exact",
    ).length,
    selectedApproximateDates: selected.filter(
      (post) => post.published_at_precision !== "exact",
    ).length,
    buckets: buckets.map(({ interactions, ...bucket }) => {
      void interactions;
      return bucket;
    }),
    tracking,
    bestComment: best
      ? {
          id: best.id,
          url: best.url,
          title: best.title,
          text: best.text,
          publishedAt: best.publishedAt,
          likes: best.likes,
          replies: best.repliesReceived,
          interactions: best.interactions,
        }
      : null,
  };
}

function isYoutubeAuthoredComment(post: CommentPerformancePost): boolean {
  if (post.platform !== "youtube") return false;
  const format = String(post.format ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return ["comment", "reply", "creator_reply", "channel_comment"].includes(format);
}

function commentRow(post: CommentPerformancePost) {
  const kind = commentKind(post);
  const likes = nonnegativeInteger(post.likes) ?? 0;
  const repliesReceived = kind === "comment"
    ? nonnegativeInteger(post.comments) ?? 0
    : 0;
  const measured = nonnegativeInteger(post.likes) !== null ||
    (kind === "comment" && nonnegativeInteger(post.comments) !== null);
  return {
    id: String(post.external_post_id ?? post.id ?? ""),
    url: safeHttpsUrl(post.url),
    title: String(post.title ?? "Commentaire YouTube").trim() || "Commentaire YouTube",
    text: String(post.text ?? "").trim(),
    publishedAt: String(post.published_at ?? ""),
    publishedAtTime: validTime(post.published_at) ?? 0,
    kind,
    likes,
    repliesReceived,
    interactions: likes + repliesReceived,
    measured,
  };
}

function commentKind(post: CommentPerformancePost): "comment" | "reply" {
  const raw = rawRecord(post.raw_json);
  const activityType = String(raw.activityType ?? raw.action ?? "").toLowerCase();
  const format = String(post.format ?? "").toLowerCase();
  const id = String(post.external_post_id ?? post.id ?? "");
  return activityType.includes("répondu") ||
    activityType.includes("replied") ||
    format.includes("reply") ||
    id.includes(".")
    ? "reply"
    : "comment";
}

function trackingSummary(
  posts: readonly CommentPerformancePost[],
  rangeStart: number,
  rangeEnd: number,
  unit: BucketUnit,
) {
  let likesNetChange = 0;
  let repliesNetChange = 0;
  let comparedCount = 0;
  const comparedDates: string[] = [];
  const points = buildEmptyBuckets(rangeStart, rangeEnd, unit).map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    startDate: bucket.startDate,
    endDate: bucket.endDate,
    likesNetChange: 0,
    repliesNetChange: 0,
    comparedPostIds: new Set<string>(),
    firstComparedAt: null as string | null,
    lastComparedAt: null as string | null,
  }));
  const pointsByKey = new Map(points.map((point) => [point.key, point]));

  for (const post of posts) {
    const kind = commentKind(post);
    const history = metricHistory(post);
    const postId = String(post.external_post_id ?? post.id ?? "");
    const likePoints = history.filter(
      (point): point is typeof point & { likes: number } =>
        nonnegativeInteger(point.likes) !== null,
    );
    const replyPoints = kind === "comment"
      ? history.filter(
          (point): point is typeof point & { comments: number } =>
            nonnegativeInteger(point.comments) !== null,
        )
      : [];
    let compared = false;
    for (let index = 1; index < likePoints.length; index += 1) {
      const previous = likePoints[index - 1];
      const current = likePoints[index];
      const previousTime = validTime(previous.capturedAt);
      const currentTime = validTime(current.capturedAt);
      if (
        previousTime === null ||
        currentTime === null ||
        previousTime < rangeStart ||
        currentTime > rangeEnd
      ) continue;
      const delta = current.likes - previous.likes;
      likesNetChange += delta;
      comparedDates.push(previous.capturedAt, current.capturedAt);
      const point = pointsByKey.get(bucketKey(currentTime, unit));
      if (point) {
        point.likesNetChange += delta;
        point.comparedPostIds.add(postId);
        point.firstComparedAt = earlierIso(point.firstComparedAt, previous.capturedAt);
        point.lastComparedAt = laterIso(point.lastComparedAt, current.capturedAt);
      }
      compared = true;
    }
    for (let index = 1; index < replyPoints.length; index += 1) {
      const previous = replyPoints[index - 1];
      const current = replyPoints[index];
      const previousTime = validTime(previous.capturedAt);
      const currentTime = validTime(current.capturedAt);
      if (
        previousTime === null ||
        currentTime === null ||
        previousTime < rangeStart ||
        currentTime > rangeEnd
      ) continue;
      const delta = current.comments - previous.comments;
      repliesNetChange += delta;
      comparedDates.push(previous.capturedAt, current.capturedAt);
      const point = pointsByKey.get(bucketKey(currentTime, unit));
      if (point) {
        point.repliesNetChange += delta;
        point.comparedPostIds.add(postId);
        point.firstComparedAt = earlierIso(point.firstComparedAt, previous.capturedAt);
        point.lastComparedAt = laterIso(point.lastComparedAt, current.capturedAt);
      }
      compared = true;
    }
    if (compared) comparedCount += 1;
  }

  const orderedDates = comparedDates.filter(validIso).sort();
  return {
    comparedCount,
    likesNetChange,
    repliesNetChange,
    firstComparedAt: orderedDates.at(0) ?? null,
    lastComparedAt: orderedDates.at(-1) ?? null,
    points: points.map(({ comparedPostIds, ...point }) => ({
      ...point,
      comparedCount: comparedPostIds.size,
    })),
  };
}

function metricHistory(post: CommentPerformancePost) {
  return (post.metric_history ?? [])
    .flatMap((point) => {
      const capturedAt = point.captured_at ?? point.capturedAt;
      if (!validIso(capturedAt)) return [];
      return [{
        capturedAt,
        likes: nonnegativeInteger(point.likes),
        comments: nonnegativeInteger(point.comments),
      }];
    })
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
}

function buildEmptyBuckets(
  rangeStart: number,
  rangeEnd: number,
  unit: BucketUnit,
): MutableBucket[] {
  const first = bucketStart(rangeStart, unit);
  const output: MutableBucket[] = [];
  for (let cursor = first; cursor <= rangeEnd; cursor = nextBucket(cursor, unit)) {
    const next = nextBucket(cursor, unit);
    output.push({
      key: bucketKey(cursor, unit),
      label: bucketLabel(cursor, unit),
      startDate: isoDay(Math.max(cursor, rangeStart)),
      endDate: isoDay(Math.min(next - 1, rangeEnd)),
      commentsPublished: 0,
      repliesPublished: 0,
      measuredCount: 0,
      engagedCount: 0,
      likesReceived: 0,
      repliesReceived: 0,
      interactionsReceived: 0,
      engagedShare: null,
      medianInteractions: null,
      cumulativePublished: 0,
      interactions: [],
    });
  }
  return output;
}

function bucketUnit(period: SocialDurationFilter): BucketUnit {
  if (period === "30d") return "day";
  if (period === "90d" || period === "180d") return "week";
  if (period === "365d") return "month";
  return "year";
}

function bucketStart(value: number, unit: BucketUnit): number {
  const date = new Date(value);
  if (unit === "day") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (unit === "week") {
    const day = date.getUTCDay() || 7;
    return Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() - day + 1,
    );
  }
  if (unit === "month") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return Date.UTC(date.getUTCFullYear(), 0, 1);
}

function nextBucket(value: number, unit: BucketUnit): number {
  const date = new Date(value);
  if (unit === "day") return value + DAY_MS;
  if (unit === "week") return value + 7 * DAY_MS;
  if (unit === "month") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return Date.UTC(date.getUTCFullYear() + 1, 0, 1);
}

function bucketKey(value: number, unit: BucketUnit): string {
  const date = new Date(bucketStart(value, unit));
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  if (unit === "year") return String(year);
  if (unit === "month") return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

function bucketLabel(value: number, unit: BucketUnit): string {
  const date = new Date(value);
  if (unit === "year") return String(date.getUTCFullYear());
  if (unit === "month") {
    return new Intl.DateTimeFormat("fr-FR", {
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    }).format(date);
  }
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function rawRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function safeHttpsUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function validTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function latestIso(...values: Array<string | null | undefined>): string | null {
  return values.filter(validIso).sort().at(-1) ?? null;
}

function earlierIso(current: string | null, candidate: string): string {
  return !current || candidate.localeCompare(current) < 0 ? candidate : current;
}

function laterIso(current: string | null, candidate: string): string {
  return !current || candidate.localeCompare(current) > 0 ? candidate : current;
}

function startOfUtcDay(value: number): number {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isoDay(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}
