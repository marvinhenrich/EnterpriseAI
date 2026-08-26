CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`chat_id` text,
	`filename` text NOT NULL,
	`stored_path` text NOT NULL,
	`mime` text,
	`size` integer DEFAULT 0 NOT NULL,
	`kind` text DEFAULT 'document' NOT NULL,
	`extracted_text` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_files_user` ON `files` (`user_id`);