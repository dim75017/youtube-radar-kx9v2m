CREATE INDEX `idx_decision_events_entity_created` ON `decision_events` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ideas_status_created` ON `ideas` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_trends_recommendation_fit` ON `trends` (`recommendation`,`brand_fit`);