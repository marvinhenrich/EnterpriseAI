CREATE TABLE `kb_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`filename` text NOT NULL,
	`stored_path` text NOT NULL,
	`mime` text,
	`size` integer DEFAULT 0 NOT NULL,
	`chunks` integer DEFAULT 0 NOT NULL,
	`uploaded_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_kb_created` ON `kb_documents` (`created_at`);