CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`type` text NOT NULL,
	`category` text NOT NULL,
	`description` text NOT NULL,
	`default_value` text NOT NULL,
	`constraints` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_settings_category` ON `settings` (`category`);