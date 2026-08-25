import { env } from "cloudflare:workers";
import {
  scanPlatform,
  type NormalizedPost,
  type SocialPlatform,
} from "../lib/social-scanner";
import { rankPosts } from "../lib/social-score";

type D1Result<T = Record<string, unknown>> = {
  results?: T[];
  success: boolean;
};

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};

export type SocialScanSummary = {
  runId: string;
  platform: SupportedSocialPlatform;
  status: "ready" | "limited" | "failed";
  sourceKind: string | null;
  coverage: string | null;
  followerCount: number | null;
  postCount: number;
  newPostCount: number;
  updatedPostCount: number;
  error: string | null;
};

export type SocialD1 = {
  prepare(query: string): D1Statement;
  batch<T = Record<string, unknown>>(
    statements: D1Statement[],
  ): Promise<D1Result<T>[]>;
};

export function getD1(): SocialD1 {
  const database = env.DB as unknown as SocialD1 | undefined;
  if (!database) {
    throw new Error(
      "La base partagée n’est pas disponible. Réessaie dans quelques instants ou utilise l’import manuel.",
    );
  }
  return database;
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS social_accounts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    handle TEXT NOT NULL,
    display_name TEXT NOT NULL,
    profile_url TEXT NOT NULL,
    external_account_id TEXT,
    verified INTEGER NOT NULL DEFAULT 1,
    follower_count INTEGER,
    source_kind TEXT,
    coverage TEXT,
    scan_status TEXT NOT NULL DEFAULT 'pending',
    scan_message TEXT,
    last_scanned_at TEXT,
    last_success_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_social_accounts_platform_handle
   ON social_accounts(platform, handle)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_social_accounts_platform_external
   ON social_accounts(platform, external_account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_social_accounts_status_scanned
   ON social_accounts(scan_status, last_scanned_at)`,
  `CREATE TABLE IF NOT EXISTS social_posts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES social_accounts(id),
    platform TEXT NOT NULL,
    external_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    text TEXT,
    format TEXT,
    thumbnail_url TEXT,
    published_at TEXT,
    views INTEGER,
    likes INTEGER,
    comments INTEGER,
    shares INTEGER,
    saves INTEGER,
    performance_score INTEGER,
    confidence TEXT,
    cohort_key TEXT,
    score_explanation TEXT,
    metric_coverage TEXT,
    rank INTEGER,
    platform_rank INTEGER,
    raw_json TEXT,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_social_posts_platform_external
   ON social_posts(platform, external_id)`,
  `CREATE INDEX IF NOT EXISTS idx_social_posts_account_published
   ON social_posts(account_id, published_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_social_posts_platform_score
   ON social_posts(platform, performance_score DESC)`,
  `CREATE TABLE IF NOT EXISTS scan_runs (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    actor_label TEXT NOT NULL,
    source_kind TEXT,
    coverage TEXT,
    post_count INTEGER NOT NULL DEFAULT 0,
    new_post_count INTEGER NOT NULL DEFAULT 0,
    updated_post_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scan_runs_platform_started
   ON scan_runs(platform, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scan_runs_status_started
   ON scan_runs(status, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS post_metric_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT NOT NULL REFERENCES social_posts(id),
    scan_run_id TEXT NOT NULL REFERENCES scan_runs(id),
    captured_at TEXT NOT NULL,
    views INTEGER,
    likes INTEGER,
    comments INTEGER,
    shares INTEGER,
    saves INTEGER,
    follower_count INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_snapshots_post_run
   ON post_metric_snapshots(post_id, scan_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_metric_snapshots_post_captured
   ON post_metric_snapshots(post_id, captured_at DESC)`,
  `CREATE TABLE IF NOT EXISTS trends (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    platform TEXT NOT NULL,
    source_label TEXT NOT NULL,
    source_url TEXT,
    first_detected_at TEXT NOT NULL,
    velocity_score INTEGER NOT NULL,
    maturity TEXT NOT NULL,
    saturation_risk INTEGER NOT NULL,
    brand_fit INTEGER NOT NULL,
    brand_risk INTEGER NOT NULL DEFAULT 0,
    recommendation TEXT NOT NULL,
    explanation TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trends_recommendation_fit
   ON trends(recommendation, brand_fit DESC)`,
  `CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY,
    trend_id TEXT REFERENCES trends(id),
    title TEXT NOT NULL,
    concept TEXT NOT NULL,
    objective TEXT NOT NULL,
    platform TEXT NOT NULL,
    format TEXT NOT NULL,
    character TEXT NOT NULL,
    hook TEXT NOT NULL,
    cta TEXT NOT NULL DEFAULT '',
    brand_score INTEGER NOT NULL,
    timing_score INTEGER NOT NULL,
    evidence_score INTEGER NOT NULL,
    feasibility_score INTEGER NOT NULL,
    priority_score INTEGER NOT NULL,
    confidence_label TEXT NOT NULL,
    score_explanation TEXT NOT NULL,
    prediction_version TEXT NOT NULL,
    prediction_snapshot TEXT NOT NULL,
    production_effort TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'review',
    decision_note TEXT,
    ideal_publish_at TEXT,
    origin TEXT NOT NULL DEFAULT 'manual',
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ideas_status_created
   ON ideas(status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS briefs (
    id TEXT PRIMARY KEY,
    idea_id TEXT NOT NULL UNIQUE REFERENCES ideas(id),
    objective TEXT NOT NULL,
    message TEXT NOT NULL,
    hook_variants TEXT NOT NULL,
    storyboard TEXT NOT NULL,
    asset_requirements TEXT NOT NULL,
    success_criteria TEXT NOT NULL,
    owner TEXT,
    deadline TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS decision_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT,
    actor_label TEXT NOT NULL,
    rationale TEXT,
    immutable_snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_decision_events_entity_created
   ON decision_events(entity_type, entity_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS editorial_idea_feedback (
    idea_id TEXT PRIMARY KEY,
    decision TEXT NOT NULL,
    primary_platform TEXT NOT NULL,
    pattern TEXT NOT NULL,
    format TEXT NOT NULL,
    title TEXT NOT NULL,
    hook TEXT NOT NULL,
    base_potential_score INTEGER NOT NULL,
    reason TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_editorial_feedback_decision_updated
   ON editorial_idea_feedback(decision, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_editorial_feedback_platform_pattern
   ON editorial_idea_feedback(primary_platform, pattern)`,
  `CREATE TABLE IF NOT EXISTS editorial_schedule (
    id TEXT PRIMARY KEY,
    idea_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    hook TEXT NOT NULL,
    platform TEXT NOT NULL,
    format TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_editorial_schedule_date_platform
   ON editorial_schedule(scheduled_for, platform)`,
  `CREATE INDEX IF NOT EXISTS idx_editorial_schedule_status_date
   ON editorial_schedule(status, scheduled_for)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_editorial_schedule_platform_date
   ON editorial_schedule(platform, scheduled_for)`,
];

export const SOCIAL_PLATFORMS = [
  "youtube",
  "instagram",
  "tiktok",
  "x",
] as const;

export type SupportedSocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const OFFICIAL_SOCIAL_ACCOUNTS = [
  {
    id: "lofigirl-youtube",
    platform: "youtube",
    handle: "LofiGirl",
    displayName: "Lofi Girl",
    profileUrl: "https://www.youtube.com/@LofiGirl",
    externalAccountId: "UCSJ4gkVC6NrvII8umztf0Ow",
  },
  {
    id: "lofigirl-instagram",
    platform: "instagram",
    handle: "lofigirl",
    displayName: "Lofi Girl",
    profileUrl: "https://www.instagram.com/lofigirl/",
    externalAccountId: null,
  },
  {
    id: "lofigirl-tiktok",
    platform: "tiktok",
    handle: "lofigirl",
    displayName: "Lofi Girl",
    profileUrl: "https://www.tiktok.com/@lofigirl",
    externalAccountId: null,
  },
  {
    id: "lofigirl-x",
    platform: "x",
    handle: "lofigirl",
    displayName: "Lofi Girl",
    profileUrl: "https://x.com/lofigirl",
    externalAccountId: null,
  },
] as const;

const demoCleanupStatements = [
  `DELETE FROM decision_events
   WHERE entity_type = 'trend'
     AND entity_id IN (SELECT id FROM trends WHERE origin = 'demo')`,
  `DELETE FROM decision_events
   WHERE entity_type = 'idea'
     AND entity_id IN (SELECT id FROM ideas WHERE origin = 'demo')`,
  `DELETE FROM briefs
   WHERE idea_id IN (SELECT id FROM ideas WHERE origin = 'demo')`,
  `DELETE FROM ideas WHERE origin = 'demo'`,
  `DELETE FROM trends WHERE origin = 'demo'`,
];

export async function ensureSocialSchema() {
  const db = getD1();
  await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
  await db.batch(
    demoCleanupStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    OFFICIAL_SOCIAL_ACCOUNTS.map((account) =>
      db
        .prepare(
          `INSERT INTO social_accounts (
            id, platform, handle, display_name, profile_url,
            external_account_id, verified
          ) VALUES (?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(id) DO UPDATE SET
            platform = excluded.platform,
            handle = excluded.handle,
            display_name = excluded.display_name,
            profile_url = excluded.profile_url,
            external_account_id = COALESCE(
              social_accounts.external_account_id,
              excluded.external_account_id
            ),
            verified = 1,
            updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(
          account.id,
          account.platform,
          account.handle,
          account.displayName,
          account.profileUrl,
          account.externalAccountId,
        ),
    ),
  );
  await db.prepare("PRAGMA optimize").run();
}

type PersistedPostRow = {
  platform: string;
  external_id: string;
  url: string;
  title: string | null;
  text: string | null;
  format: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  raw_json: string | null;
};

const activePlatformScans = new Map<
  SupportedSocialPlatform,
  Promise<SocialScanSummary>
>();

function accountForPlatform(platform: SupportedSocialPlatform) {
  const account = OFFICIAL_SOCIAL_ACCOUNTS.find(
    (candidate) => candidate.platform === platform,
  );
  if (!account) {
    throw new Error(`Compte officiel introuvable pour ${platform}.`);
  }
  return account;
}

function safeJson(value: unknown) {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseRawJson(value: string | null): NormalizedPost["raw"] {
  if (!value) return null;
  try {
    return JSON.parse(value) as NormalizedPost["raw"];
  } catch {
    return null;
  }
}

function nullableNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function runStatementBatches(
  db: SocialD1,
  statements: D1Statement[],
  size = 50,
) {
  for (let offset = 0; offset < statements.length; offset += size) {
    await db.batch(statements.slice(offset, offset + size));
  }
}

function persistedRowToNormalized(row: PersistedPostRow): NormalizedPost {
  return {
    platform: row.platform as SocialPlatform,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    text: row.text,
    format: row.format,
    thumbnailUrl: row.thumbnail_url,
    publishedAt: row.published_at,
    views: nullableNumber(row.views),
    likes: nullableNumber(row.likes),
    comments: nullableNumber(row.comments),
    shares: nullableNumber(row.shares),
    saves: nullableNumber(row.saves),
    raw: parseRawJson(row.raw_json),
  };
}

export async function recalculateSocialScores() {
  const db = getD1();
  const postResult = await db
    .prepare(
      `SELECT platform, external_id, url, title, text, format,
              thumbnail_url, published_at, views, likes, comments,
              shares, saves, raw_json
       FROM social_posts`,
    )
    .all<PersistedPostRow>();
  const rows = postResult.results ?? [];
  if (rows.length === 0) return [];

  const ranked = rankPosts(rows.map(persistedRowToNormalized));
  await runStatementBatches(
    db,
    ranked.map((post) =>
      db
        .prepare(
          `UPDATE social_posts
           SET performance_score = ?, confidence = ?, cohort_key = ?,
               score_explanation = ?, metric_coverage = ?, rank = ?,
               platform_rank = ?, updated_at = CURRENT_TIMESTAMP
           WHERE platform = ? AND external_id = ?`,
        )
        .bind(
          post.performanceScore,
          post.confidence,
          post.cohortKey,
          post.scoreExplanation,
          JSON.stringify(post.metricCoverage),
          post.rank,
          post.platformRank,
          post.platform,
          post.externalId,
        ),
    ),
  );
  return ranked;
}

async function performPlatformScan(
  platform: SupportedSocialPlatform,
  trigger: "auto" | "manual",
  actorLabel: string,
): Promise<SocialScanSummary> {
  const db = getD1();
  const account = accountForPlatform(platform);
  const runId = `scan_${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO scan_runs (
        id, platform, trigger, status, actor_label, started_at
      ) VALUES (?, ?, ?, 'running', ?, ?)`,
    )
    .bind(runId, platform, trigger, actorLabel, startedAt)
    .run();

  try {
    const result = await scanPlatform(platform as SocialPlatform);
    const capturedAt = new Date().toISOString();
    const posts = Array.from(
      new Map(
        result.posts
          .filter(
            (post) =>
              post.platform === platform &&
              Boolean(post.externalId) &&
              Boolean(post.url),
          )
          .map((post) => [post.externalId, post]),
      ).values(),
    );
    const existingResult = await db
      .prepare("SELECT external_id FROM social_posts WHERE platform = ?")
      .bind(platform)
      .all<{ external_id: string }>();
    const existingIds = new Set(
      (existingResult.results ?? []).map((row) => row.external_id),
    );
    const newPostCount = posts.filter(
      (post) => !existingIds.has(post.externalId),
    ).length;

    await runStatementBatches(
      db,
      posts.map((post) => {
        const postId = `${platform}:${post.externalId}`;
        return db
          .prepare(
            `INSERT INTO social_posts (
              id, account_id, platform, external_id, url, title, text,
              format, thumbnail_url, published_at, views, likes, comments,
              shares, saves, raw_json, first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(platform, external_id) DO UPDATE SET
              account_id = excluded.account_id,
              url = excluded.url,
              title = COALESCE(excluded.title, social_posts.title),
              text = COALESCE(excluded.text, social_posts.text),
              format = COALESCE(excluded.format, social_posts.format),
              thumbnail_url = COALESCE(
                excluded.thumbnail_url,
                social_posts.thumbnail_url
              ),
              published_at = COALESCE(
                excluded.published_at,
                social_posts.published_at
              ),
              views = COALESCE(excluded.views, social_posts.views),
              likes = COALESCE(excluded.likes, social_posts.likes),
              comments = COALESCE(excluded.comments, social_posts.comments),
              shares = COALESCE(excluded.shares, social_posts.shares),
              saves = COALESCE(excluded.saves, social_posts.saves),
              raw_json = COALESCE(excluded.raw_json, social_posts.raw_json),
              last_seen_at = excluded.last_seen_at,
              updated_at = CURRENT_TIMESTAMP`,
          )
          .bind(
            postId,
            account.id,
            platform,
            post.externalId,
            post.url,
            post.title,
            post.text,
            post.format,
            post.thumbnailUrl,
            post.publishedAt,
            nullableNumber(post.views),
            nullableNumber(post.likes),
            nullableNumber(post.comments),
            nullableNumber(post.shares),
            nullableNumber(post.saves),
            safeJson(post.raw),
            capturedAt,
            capturedAt,
          );
      }),
    );

    await runStatementBatches(
      db,
      posts.map((post) =>
        db
          .prepare(
            `INSERT INTO post_metric_snapshots (
              post_id, scan_run_id, captured_at, views, likes, comments,
              shares, saves, follower_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(post_id, scan_run_id) DO UPDATE SET
              captured_at = excluded.captured_at,
              views = excluded.views,
              likes = excluded.likes,
              comments = excluded.comments,
              shares = excluded.shares,
              saves = excluded.saves,
              follower_count = excluded.follower_count`,
          )
          .bind(
            `${platform}:${post.externalId}`,
            runId,
            capturedAt,
            nullableNumber(post.views),
            nullableNumber(post.likes),
            nullableNumber(post.comments),
            nullableNumber(post.shares),
            nullableNumber(post.saves),
            nullableNumber(result.followerCount),
          ),
      ),
    );

    await db.batch([
      db
        .prepare(
          `UPDATE social_accounts
           SET external_account_id = COALESCE(?, external_account_id),
               follower_count = COALESCE(?, follower_count),
               source_kind = ?, coverage = ?, scan_status = ?,
               scan_message = NULL, last_scanned_at = ?,
               last_success_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(
          result.externalAccountId,
          nullableNumber(result.followerCount),
          result.sourceKind,
          result.coverage,
          result.status,
          capturedAt,
          capturedAt,
          account.id,
        ),
      db
        .prepare(
          `UPDATE scan_runs
           SET status = ?, source_kind = ?, coverage = ?, post_count = ?,
               new_post_count = ?, updated_post_count = ?, completed_at = ?
           WHERE id = ?`,
        )
        .bind(
          result.status,
          result.sourceKind,
          result.coverage,
          posts.length,
          newPostCount,
          posts.length - newPostCount,
          capturedAt,
          runId,
        ),
    ]);

    return {
      runId,
      platform,
      status: result.status,
      sourceKind: result.sourceKind,
      coverage: result.coverage,
      followerCount: nullableNumber(result.followerCount),
      postCount: posts.length,
      newPostCount,
      updatedPostCount: posts.length - newPostCount,
      error: null,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const message =
      error instanceof Error ? error.message : "Échec inattendu du scan.";
    await db.batch([
      db
        .prepare(
          `UPDATE social_accounts
           SET scan_status = 'error', scan_message = ?, last_scanned_at = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(message, completedAt, account.id),
      db
        .prepare(
          `UPDATE scan_runs
           SET status = 'failed', error_message = ?, completed_at = ?
           WHERE id = ?`,
        )
        .bind(message, completedAt, runId),
    ]);
    return {
      runId,
      platform,
      status: "failed",
      sourceKind: null,
      coverage: null,
      followerCount: null,
      postCount: 0,
      newPostCount: 0,
      updatedPostCount: 0,
      error: message,
    };
  }
}

async function scanWithLock(
  platform: SupportedSocialPlatform,
  trigger: "auto" | "manual",
  actorLabel: string,
) {
  const active = activePlatformScans.get(platform);
  if (active) return active;

  const pending = performPlatformScan(platform, trigger, actorLabel);
  activePlatformScans.set(platform, pending);
  try {
    return await pending;
  } finally {
    if (activePlatformScans.get(platform) === pending) {
      activePlatformScans.delete(platform);
    }
  }
}

export async function runSocialScan(options?: {
  platform?: SupportedSocialPlatform;
  trigger?: "auto" | "manual";
  actorLabel?: string;
}) {
  await ensureSocialSchema();
  const platforms = options?.platform
    ? [options.platform]
    : [...SOCIAL_PLATFORMS];
  const trigger = options?.trigger ?? "manual";
  const actorLabel = options?.actorLabel ?? "Lofi Social Radar";
  const results: SocialScanSummary[] = [];

  for (const platform of platforms) {
    results.push(await scanWithLock(platform, trigger, actorLabel));
  }
  await recalculateSocialScores();
  return results;
}

export async function socialDataNeedsScan(maxAgeMs = 6 * 60 * 60 * 1000) {
  const db = getD1();
  const health = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM social_posts) AS post_count,
        COUNT(*) AS account_count,
        SUM(CASE WHEN last_scanned_at IS NOT NULL THEN 1 ELSE 0 END)
          AS scanned_account_count,
        MIN(last_scanned_at) AS oldest_scan
       FROM social_accounts`,
    )
    .first<{
      post_count: number;
      account_count: number;
      scanned_account_count: number;
      oldest_scan: string | null;
    }>();
  if (Number(health?.post_count ?? 0) === 0) return true;
  if (Number(health?.account_count ?? 0) < SOCIAL_PLATFORMS.length) return true;
  if (Number(health?.scanned_account_count ?? 0) < SOCIAL_PLATFORMS.length) {
    return true;
  }
  if (!health?.oldest_scan) return true;

  const oldestScan = Date.parse(health.oldest_scan);
  return !Number.isFinite(oldestScan) || Date.now() - oldestScan > maxAgeMs;
}

export function actorFromRequest(request: Request) {
  return (
    request.headers.get("oai-authenticated-user-full-name") ??
    request.headers.get("oai-authenticated-user-email") ??
    "Direction · aperçu local"
  );
}

export function routeError(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Une erreur inattendue est survenue.";
  return Response.json({ error: message }, { status: 500 });
}
