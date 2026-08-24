CREATE TABLE `conversation_branch_edges` (
	`child_thread_id` text PRIMARY KEY NOT NULL,
	`parent_thread_id` text NOT NULL,
	`tree_root_thread_id` text NOT NULL,
	`fork_before_turn_id` text NOT NULL,
	`common_prefix_turn_id` text NOT NULL,
	`inherited_turn_ids` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_branch_edges_parent` ON `conversation_branch_edges` (`parent_thread_id`);--> statement-breakpoint
CREATE INDEX `idx_branch_edges_root` ON `conversation_branch_edges` (`tree_root_thread_id`);--> statement-breakpoint
CREATE TABLE `conversation_branch_groups` (
	`group_id` text PRIMARY KEY NOT NULL,
	`tree_root_thread_id` text NOT NULL,
	`common_prefix_turn_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_branch_groups_root_prefix` ON `conversation_branch_groups` (`tree_root_thread_id`,`common_prefix_turn_id`);--> statement-breakpoint
CREATE INDEX `idx_branch_groups_root` ON `conversation_branch_groups` (`tree_root_thread_id`);--> statement-breakpoint
CREATE TABLE `conversation_branch_versions` (
	`version_id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`version_index` integer NOT NULL,
	`kind` text NOT NULL,
	`message_turn_id` text,
	`preview_text` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_branch_versions_group_thread` ON `conversation_branch_versions` (`group_id`,`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_branch_versions_group_index` ON `conversation_branch_versions` (`group_id`,`version_index`);--> statement-breakpoint
CREATE INDEX `idx_branch_versions_thread` ON `conversation_branch_versions` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_branch_versions_group` ON `conversation_branch_versions` (`group_id`);