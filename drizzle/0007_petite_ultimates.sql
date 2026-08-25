ALTER TABLE `conversation_branch_edges` ADD `source` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation_branch_versions` ADD `source` text DEFAULT 'local' NOT NULL;