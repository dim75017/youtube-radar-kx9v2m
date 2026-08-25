import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const socialAccounts = sqliteTable(
  "social_accounts",
  {
    id: text("id").primaryKey(),
    platform: text("platform").notNull(),
    handle: text("handle").notNull(),
    displayName: text("display_name").notNull(),
    profileUrl: text("profile_url").notNull(),
    externalAccountId: text("external_account_id"),
    verified: integer("verified").notNull().default(1),
    followerCount: integer("follower_count"),
    sourceKind: text("source_kind"),
    coverage: text("coverage"),
    scanStatus: text("scan_status").notNull().default("pending"),
    scanMessage: text("scan_message"),
    lastScannedAt: text("last_scanned_at"),
    lastSuccessAt: text("last_success_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_social_accounts_platform_handle").on(
      table.platform,
      table.handle,
    ),
    uniqueIndex("idx_social_accounts_platform_external").on(
      table.platform,
      table.externalAccountId,
    ),
    index("idx_social_accounts_status_scanned").on(
      table.scanStatus,
      table.lastScannedAt,
    ),
  ],
);

export const socialPosts = sqliteTable(
  "social_posts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => socialAccounts.id),
    platform: text("platform").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    postText: text("text"),
    format: text("format"),
    thumbnailUrl: text("thumbnail_url"),
    publishedAt: text("published_at"),
    views: integer("views"),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    saves: integer("saves"),
    performanceScore: integer("performance_score"),
    confidence: text("confidence"),
    cohortKey: text("cohort_key"),
    scoreExplanation: text("score_explanation"),
    metricCoverage: text("metric_coverage"),
    rank: integer("rank"),
    platformRank: integer("platform_rank"),
    rawJson: text("raw_json"),
    firstSeenAt: text("first_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_social_posts_platform_external").on(
      table.platform,
      table.externalId,
    ),
    index("idx_social_posts_account_published").on(
      table.accountId,
      table.publishedAt,
    ),
    index("idx_social_posts_platform_score").on(
      table.platform,
      table.performanceScore,
    ),
  ],
);

export const scanRuns = sqliteTable(
  "scan_runs",
  {
    id: text("id").primaryKey(),
    platform: text("platform").notNull(),
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    actorLabel: text("actor_label").notNull(),
    sourceKind: text("source_kind"),
    coverage: text("coverage"),
    postCount: integer("post_count").notNull().default(0),
    newPostCount: integer("new_post_count").notNull().default(0),
    updatedPostCount: integer("updated_post_count").notNull().default(0),
    errorMessage: text("error_message"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_scan_runs_platform_started").on(
      table.platform,
      table.startedAt,
    ),
    index("idx_scan_runs_status_started").on(table.status, table.startedAt),
  ],
);

export const postMetricSnapshots = sqliteTable(
  "post_metric_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postId: text("post_id")
      .notNull()
      .references(() => socialPosts.id),
    scanRunId: text("scan_run_id")
      .notNull()
      .references(() => scanRuns.id),
    capturedAt: text("captured_at").notNull(),
    views: integer("views"),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    saves: integer("saves"),
    followerCount: integer("follower_count"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_metric_snapshots_post_run").on(
      table.postId,
      table.scanRunId,
    ),
    index("idx_metric_snapshots_post_captured").on(
      table.postId,
      table.capturedAt,
    ),
  ],
);

export const trends = sqliteTable(
  "trends",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    platform: text("platform").notNull(),
    sourceLabel: text("source_label").notNull(),
    sourceUrl: text("source_url"),
    firstDetectedAt: text("first_detected_at").notNull(),
    velocityScore: integer("velocity_score").notNull(),
    maturity: text("maturity").notNull(),
    saturationRisk: integer("saturation_risk").notNull(),
    brandFit: integer("brand_fit").notNull(),
    brandRisk: integer("brand_risk").notNull().default(0),
    recommendation: text("recommendation").notNull(),
    explanation: text("explanation").notNull(),
    origin: text("origin").notNull().default("manual"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_trends_recommendation_fit").on(
      table.recommendation,
      table.brandFit,
    ),
  ],
);

export const ideas = sqliteTable("ideas", {
  id: text("id").primaryKey(),
  trendId: text("trend_id").references(() => trends.id),
  title: text("title").notNull(),
  concept: text("concept").notNull(),
  objective: text("objective").notNull(),
  platform: text("platform").notNull(),
  format: text("format").notNull(),
  character: text("character").notNull(),
  hook: text("hook").notNull(),
  cta: text("cta").notNull().default(""),
  brandScore: integer("brand_score").notNull(),
  timingScore: integer("timing_score").notNull(),
  evidenceScore: integer("evidence_score").notNull(),
  feasibilityScore: integer("feasibility_score").notNull(),
  priorityScore: integer("priority_score").notNull(),
  confidenceLabel: text("confidence_label").notNull(),
  scoreExplanation: text("score_explanation").notNull(),
  predictionVersion: text("prediction_version").notNull(),
  predictionSnapshot: text("prediction_snapshot").notNull(),
  productionEffort: text("production_effort").notNull(),
  status: text("status").notNull().default("review"),
  decisionNote: text("decision_note"),
  idealPublishAt: text("ideal_publish_at"),
  origin: text("origin").notNull().default("manual"),
  rowVersion: integer("row_version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_ideas_status_created").on(table.status, table.createdAt),
]);

export const briefs = sqliteTable("briefs", {
  id: text("id").primaryKey(),
  ideaId: text("idea_id")
    .notNull()
    .unique()
    .references(() => ideas.id),
  objective: text("objective").notNull(),
  message: text("message").notNull(),
  hookVariants: text("hook_variants").notNull(),
  storyboard: text("storyboard").notNull(),
  assetRequirements: text("asset_requirements").notNull(),
  successCriteria: text("success_criteria").notNull(),
  owner: text("owner"),
  deadline: text("deadline"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const decisionEvents = sqliteTable("decision_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  actorLabel: text("actor_label").notNull(),
  rationale: text("rationale"),
  immutableSnapshot: text("immutable_snapshot").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_decision_events_entity_created").on(
    table.entityType,
    table.entityId,
    table.createdAt,
  ),
]);

export const editorialIdeaFeedback = sqliteTable(
  "editorial_idea_feedback",
  {
    ideaId: text("idea_id").primaryKey(),
    decision: text("decision").notNull(),
    primaryPlatform: text("primary_platform").notNull(),
    pattern: text("pattern").notNull(),
    format: text("format").notNull(),
    title: text("title").notNull(),
    hook: text("hook").notNull(),
    basePotentialScore: integer("base_potential_score").notNull(),
    reason: text("reason"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_editorial_feedback_decision_updated").on(
      table.decision,
      table.updatedAt,
    ),
    index("idx_editorial_feedback_platform_pattern").on(
      table.primaryPlatform,
      table.pattern,
    ),
  ],
);

export const editorialSchedule = sqliteTable(
  "editorial_schedule",
  {
    id: text("id").primaryKey(),
    ideaId: text("idea_id").notNull().unique(),
    title: text("title").notNull(),
    hook: text("hook").notNull(),
    platform: text("platform").notNull(),
    format: text("format").notNull(),
    scheduledFor: text("scheduled_for").notNull(),
    status: text("status").notNull().default("planned"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_editorial_schedule_date_platform").on(
      table.scheduledFor,
      table.platform,
    ),
    index("idx_editorial_schedule_status_date").on(
      table.status,
      table.scheduledFor,
    ),
    uniqueIndex("idx_editorial_schedule_platform_date").on(
      table.platform,
      table.scheduledFor,
    ),
  ],
);
