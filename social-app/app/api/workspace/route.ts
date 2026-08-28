import {
  actorFromRequest,
  ensureSocialSchema,
  getD1,
  routeError,
  runSocialScan,
  socialDataNeedsScan,
} from "../../../db/runtime";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import publicHistory from "../../../data/public-history.json";
import {
  mergeWorkspaceWithPublicHistory,
  type PublicHistorySnapshot,
} from "../../../lib/public-history";
import { attachLiveMetricHistory } from "../../../lib/live-metric-history";

export const dynamic = "force-dynamic";

type AuthorizedYouTubeActivity = {
  dateLabel?: unknown;
  time?: unknown;
  comment?: unknown;
  action?: unknown;
  url?: unknown;
  target?: unknown;
};

type AuthorizedYouTubeMetric = {
  likes?: unknown;
  replies?: unknown;
};

const FRENCH_MONTHS: Record<string, number> = {
  "janv.": 0,
  "févr.": 1,
  mars: 2,
  "avr.": 3,
  mai: 4,
  juin: 5,
  juillet: 6,
  "août": 7,
  "sept.": 8,
  "oct.": 9,
  "nov.": 10,
  "déc.": 11,
};

function activityDateToIso(dateLabel: unknown, time: unknown) {
  if (typeof dateLabel !== "string") return null;
  const [hours = 0, minutes = 0] =
    typeof time === "string" ? time.split(":").map(Number) : [];
  const reference = new Date();
  if (dateLabel === "Aujourd'hui") {
    return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate(), hours, minutes).toISOString();
  }
  if (dateLabel === "Hier") {
    return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - 1, hours, minutes).toISOString();
  }
  const match = dateLabel.match(/^(\d{1,2})\s+([^\s]+)(?:\s+(\d{4}))?$/);
  if (!match || FRENCH_MONTHS[match[2]] === undefined) return null;
  const year = match[3] ? Number(match[3]) : reference.getFullYear();
  return new Date(year, FRENCH_MONTHS[match[2]], Number(match[1]), hours, minutes).toISOString();
}

function nonnegativeMetric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

async function authorizedYouTubeCommentMetrics() {
  const candidates = [
    join(process.cwd(), "data", "private-youtube-comment-metrics.json"),
    join(process.cwd(), "data", "youtube-comment-metrics.json"),
    join(process.cwd(), "dist", "data", "youtube-comment-metrics.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as { results?: Record<string, AuthorizedYouTubeMetric> };
      if (parsed.results && typeof parsed.results === "object") return parsed.results;
    } catch {
      // Metric collection is deliberately optional while the historical scan is running.
    }
  }
  return {} as Record<string, AuthorizedYouTubeMetric>;
}

async function authorizedYouTubeCommentPosts() {
  let imported: { comments?: unknown };
  try {
    const candidates = [
      join(process.cwd(), "data", "private-youtube-comment-history.json"),
      join(process.cwd(), "dist", "data", "private-youtube-comment-history.json"),
    ];
    let raw: string | null = null;
    for (const candidate of candidates) {
      try {
        raw = await readFile(candidate, "utf8");
        break;
      } catch {
        // The authorized private import is intentionally optional in public builds.
      }
    }
    imported = raw ? (JSON.parse(raw) as { comments?: unknown }) : {};
  } catch {
    imported = {};
  }
  if (!Array.isArray(imported.comments)) return [];
  const metrics = await authorizedYouTubeCommentMetrics();
  return imported.comments.flatMap((activity) => {
    const entry = activity as AuthorizedYouTubeActivity;
    if (typeof entry.url !== "string" || typeof entry.comment !== "string") return [];
    let commentId: string | null = null;
    let targetUrl: string | null = null;
    let targetId: string | null = null;
    let thumbnailUrl: string | null = null;
    try {
      const url = new URL(entry.url);
      commentId = url.searchParams.get("lc");
      url.searchParams.delete("lc");
      targetUrl = url.toString();
      const videoId = url.searchParams.get("v");
      targetId = videoId ?? url.pathname.match(/^\/post\/([^/?#]+)/)?.[1] ?? null;
      thumbnailUrl = videoId
        ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`
        : null;
    } catch {
      return [];
    }
    if (!commentId) return [];
    const metric = metrics[commentId];
    const targetTitle =
      typeof entry.target === "string" && entry.target.trim()
        ? entry.target.trim()
        : "Contenu YouTube commenté";
    return [{
      id: `youtube:${commentId}`,
      account_id: "lofigirl-youtube",
      platform: "youtube",
      external_id: commentId,
      external_post_id: commentId,
      url: entry.url,
      title: targetTitle,
      text: entry.comment,
      format: "comment",
      thumbnail_url: thumbnailUrl,
      published_at: activityDateToIso(entry.dateLabel, entry.time),
      views: null,
      likes: nonnegativeMetric(metric?.likes),
      comments: nonnegativeMetric(metric?.replies),
      shares: null,
      saves: null,
      raw_json: JSON.stringify({
        collector: "authorized-google-my-activity",
        activityType: entry.action,
        target: entry.target,
        likesStatus: "À relever sur la page YouTube du commentaire.",
        commentTarget: {
          contentId: targetId,
          url: targetUrl,
          title: targetTitle,
          thumbnailUrl,
          authorHandle: null,
          authorName: null,
          authorProfileUrl: null,
          audienceValue: null,
          audienceLabel: null,
          audiencePrecision: "unknown",
          audienceObservedAt: null,
          source: "youtube-comment-permalink",
        },
      }),
      source_kind: "authorized-google-my-activity",
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      last_metric_at: new Date().toISOString(),
    }];
  });
}

export async function GET(request: Request) {
  try {
    await ensureSocialSchema();
    if (await socialDataNeedsScan()) {
      await runSocialScan({
        trigger: "auto",
        actorLabel: actorFromRequest(request),
      });
    }

    const db = getD1();
    const [accountResult, postResult, metricSnapshotResult, scanResult] =
      await Promise.all([
        db
          .prepare(
            `SELECT a.id, a.platform, a.handle, a.display_name,
                  a.profile_url, a.external_account_id, a.verified,
                  a.follower_count,
                  COALESCE(a.source_kind, 'pending') AS source_kind,
                  a.coverage, a.scan_status, a.scan_message,
                  a.last_scanned_at, a.last_success_at,
                  a.created_at, a.updated_at,
                  COALESCE(
                    a.coverage,
                    'Source officielle configurée · aucun relevé exploitable pour le moment.'
                  ) AS coverage_label,
                  CASE a.scan_status
                    WHEN 'pending' THEN 'idle'
                    ELSE a.scan_status
                  END AS status,
                  a.scan_message AS last_error,
                  a.last_scanned_at AS last_scan_at,
                  COUNT(p.id) AS post_count
           FROM social_accounts a
           LEFT JOIN social_posts p ON p.account_id = a.id
           GROUP BY a.id
           ORDER BY CASE a.platform
             WHEN 'youtube' THEN 1
             WHEN 'instagram' THEN 2
             WHEN 'tiktok' THEN 3
             ELSE 4
           END`,
          )
          .all(),
        db
          .prepare(
            `SELECT
             p.id, p.account_id, p.platform, p.external_id,
             p.external_id AS external_post_id, p.url,
             COALESCE(p.title, '') AS title,
             COALESCE(p.text, '') AS text,
             COALESCE(p.format, '') AS format,
             p.thumbnail_url, p.published_at, p.views, p.likes,
             p.comments, p.shares, p.saves, p.performance_score,
             p.confidence, p.confidence AS score_confidence,
             p.cohort_key, p.score_explanation, p.metric_coverage,
             p.rank, p.platform_rank, p.raw_json, p.first_seen_at,
             p.last_seen_at, p.created_at, p.updated_at,
             a.source_kind AS source_kind,
             NULL AS analysis_label
           FROM social_posts p
           JOIN social_accounts a ON a.id = p.account_id
           ORDER BY p.performance_score IS NULL ASC,
                    p.performance_score DESC,
                    p.published_at DESC`,
          )
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT post_id, scan_run_id, captured_at,
                  views, likes, comments, shares, saves
           FROM post_metric_snapshots
           ORDER BY post_id ASC, captured_at ASC, id ASC`,
          )
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT * FROM scan_runs
           ORDER BY started_at DESC
           LIMIT 40`,
          )
          .all(),
      ]);

    const livePosts = attachLiveMetricHistory(
      postResult.results ?? [],
      metricSnapshotResult.results ?? [],
    );

    const privateCommentPosts = await authorizedYouTubeCommentPosts();
    const workspace = mergeWorkspaceWithPublicHistory(
      {
        mode: "live",
        notice:
          "Données publiques des comptes officiels Lofi Girl. Les couvertures limitées sont signalées explicitement et aucune métrique manquante n’est inventée.",
        generatedAt: new Date().toISOString(),
        accounts: accountResult.results ?? [],
        posts: [...livePosts, ...privateCommentPosts],
        scans: scanResult.results ?? [],
      },
      publicHistory as PublicHistorySnapshot,
      "live",
    );

    return Response.json(workspace);
  } catch (error) {
    return routeError(error);
  }
}
