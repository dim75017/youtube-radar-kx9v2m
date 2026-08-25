CREATE TABLE `briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`idea_id` text NOT NULL,
	`objective` text NOT NULL,
	`message` text NOT NULL,
	`hook_variants` text NOT NULL,
	`storyboard` text NOT NULL,
	`asset_requirements` text NOT NULL,
	`success_criteria` text NOT NULL,
	`owner` text,
	`deadline` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`idea_id`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `briefs_idea_id_unique` ON `briefs` (`idea_id`);--> statement-breakpoint
CREATE TABLE `decision_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`actor_label` text NOT NULL,
	`rationale` text,
	`immutable_snapshot` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ideas` (
	`id` text PRIMARY KEY NOT NULL,
	`trend_id` text,
	`title` text NOT NULL,
	`concept` text NOT NULL,
	`objective` text NOT NULL,
	`platform` text NOT NULL,
	`format` text NOT NULL,
	`character` text NOT NULL,
	`hook` text NOT NULL,
	`cta` text DEFAULT '' NOT NULL,
	`brand_score` integer NOT NULL,
	`timing_score` integer NOT NULL,
	`evidence_score` integer NOT NULL,
	`feasibility_score` integer NOT NULL,
	`priority_score` integer NOT NULL,
	`confidence_label` text NOT NULL,
	`score_explanation` text NOT NULL,
	`prediction_version` text NOT NULL,
	`prediction_snapshot` text NOT NULL,
	`production_effort` text NOT NULL,
	`status` text DEFAULT 'review' NOT NULL,
	`decision_note` text,
	`ideal_publish_at` text,
	`origin` text DEFAULT 'manual' NOT NULL,
	`row_version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`trend_id`) REFERENCES `trends`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `trends` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`platform` text NOT NULL,
	`source_label` text NOT NULL,
	`source_url` text,
	`first_detected_at` text NOT NULL,
	`velocity_score` integer NOT NULL,
	`maturity` text NOT NULL,
	`saturation_risk` integer NOT NULL,
	`brand_fit` integer NOT NULL,
	`brand_risk` integer DEFAULT 0 NOT NULL,
	`recommendation` text NOT NULL,
	`explanation` text NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
