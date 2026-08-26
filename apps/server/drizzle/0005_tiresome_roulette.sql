CREATE TABLE `chat_shares` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`can_write` integer DEFAULT true NOT NULL,
	`shared_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chat_share_unique` ON `chat_shares` (`chat_id`,`user_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `sender_id` integer;