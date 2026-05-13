CREATE TABLE `token_usage_snapshots` (
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`total_tokens` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`cached_input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`reasoning_output_tokens` integer NOT NULL,
	`last_total_tokens` integer NOT NULL,
	`last_input_tokens` integer NOT NULL,
	`last_cached_input_tokens` integer NOT NULL,
	`last_output_tokens` integer NOT NULL,
	`last_reasoning_output_tokens` integer NOT NULL,
	`model_context_window` integer,
	`raw_payload` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `turn_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_token_usage_thread_updated` ON `token_usage_snapshots` (`thread_id`,`updated_at`);