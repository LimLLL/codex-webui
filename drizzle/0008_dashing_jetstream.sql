CREATE TABLE `conversation_branch_active_members` (
	`tree_root_thread_id` text PRIMARY KEY NOT NULL,
	`active_thread_id` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_branch_active_members_active` ON `conversation_branch_active_members` (`active_thread_id`);