CREATE TABLE `post_metric_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` text NOT NULL,
	`scan_run_id` text NOT NULL,
	`captured_at` text NOT NULL,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`saves` integer,
	`follower_count` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `social_posts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scan_run_id`) REFERENCES `scan_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_metric_snapshots_post_run` ON `post_metric_snapshots` (`post_id`,`scan_run_id`);--> statement-breakpoint
CREATE INDEX `idx_metric_snapshots_post_captured` ON `post_metric_snapshots` (`post_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `scan_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`actor_label` text NOT NULL,
	`source_kind` text,
	`coverage` text,
	`post_count` integer DEFAULT 0 NOT NULL,
	`new_post_count` integer DEFAULT 0 NOT NULL,
	`updated_post_count` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scan_runs_platform_started` ON `scan_runs` (`platform`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_scan_runs_status_started` ON `scan_runs` (`status`,`started_at`);--> statement-breakpoint
CREATE TABLE `social_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`handle` text NOT NULL,
	`display_name` text NOT NULL,
	`profile_url` text NOT NULL,
	`external_account_id` text,
	`verified` integer DEFAULT 1 NOT NULL,
	`follower_count` integer,
	`source_kind` text,
	`coverage` text,
	`scan_status` text DEFAULT 'pending' NOT NULL,
	`scan_message` text,
	`last_scanned_at` text,
	`last_success_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_social_accounts_platform_handle` ON `social_accounts` (`platform`,`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_social_accounts_platform_external` ON `social_accounts` (`platform`,`external_account_id`);--> statement-breakpoint
CREATE INDEX `idx_social_accounts_status_scanned` ON `social_accounts` (`scan_status`,`last_scanned_at`);--> statement-breakpoint
CREATE TABLE `social_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`platform` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`text` text,
	`format` text,
	`thumbnail_url` text,
	`published_at` text,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`saves` integer,
	`performance_score` integer,
	`confidence` text,
	`cohort_key` text,
	`score_explanation` text,
	`metric_coverage` text,
	`rank` integer,
	`platform_rank` integer,
	`raw_json` text,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `social_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_social_posts_platform_external` ON `social_posts` (`platform`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_social_posts_account_published` ON `social_posts` (`account_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_social_posts_platform_score` ON `social_posts` (`platform`,`performance_score`);