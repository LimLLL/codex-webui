CREATE TABLE `terminal_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`context_key` text NOT NULL,
	`cwd` text NOT NULL,
	`shell` text NOT NULL,
	`title` text NOT NULL,
	`session_id` text NOT NULL,
	`generation` integer NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	`automatic_attempts` text NOT NULL,
	`created_at` text NOT NULL
);
