CREATE TABLE `editorial_idea_feedback` (
	`idea_id` text PRIMARY KEY NOT NULL,
	`decision` text NOT NULL,
	`primary_platform` text NOT NULL,
	`pattern` text NOT NULL,
	`format` text NOT NULL,
	`title` text NOT NULL,
	`hook` text NOT NULL,
	`base_potential_score` integer NOT NULL,
	`reason` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_editorial_feedback_decision_updated` ON `editorial_idea_feedback` (`decision`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_editorial_feedback_platform_pattern` ON `editorial_idea_feedback` (`primary_platform`,`pattern`);--> statement-breakpoint
CREATE TABLE `editorial_schedule` (
	`id` text PRIMARY KEY NOT NULL,
	`idea_id` text NOT NULL,
	`title` text NOT NULL,
	`hook` text NOT NULL,
	`platform` text NOT NULL,
	`format` text NOT NULL,
	`scheduled_for` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `editorial_schedule_idea_id_unique` ON `editorial_schedule` (`idea_id`);--> statement-breakpoint
CREATE INDEX `idx_editorial_schedule_date_platform` ON `editorial_schedule` (`scheduled_for`,`platform`);--> statement-breakpoint
CREATE INDEX `idx_editorial_schedule_status_date` ON `editorial_schedule` (`status`,`scheduled_for`);