PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pending_server_requests` (
	`instance_id` text PRIMARY KEY,
	`generation` integer NOT NULL,
	`request_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text,
	`item_id` text,
	`method` text NOT NULL,
	`params_json` text NOT NULL,
	`status` text NOT NULL,
	`resolved_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer,
	`failure_reason` text
);
--> statement-breakpoint
INSERT INTO `__new_pending_server_requests`("instance_id", "generation", "request_id", "thread_id", "turn_id", "item_id", "method", "params_json", "status", "resolved_by", "created_at", "updated_at", "resolved_at", "failure_reason") SELECT "instance_id", "generation", "request_id", "thread_id", "turn_id", "item_id", "method", "params_json", "status", "resolved_by", "created_at", "updated_at", "resolved_at", "failure_reason" FROM `pending_server_requests`;--> statement-breakpoint
DROP TABLE `pending_server_requests`;--> statement-breakpoint
ALTER TABLE `__new_pending_server_requests` RENAME TO `pending_server_requests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_pending_requests_origin` ON `pending_server_requests` (`generation`,`request_id`);--> statement-breakpoint
CREATE INDEX `idx_pending_requests_thread_status` ON `pending_server_requests` (`thread_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_pending_requests_status_updated` ON `pending_server_requests` (`status`,`updated_at`);