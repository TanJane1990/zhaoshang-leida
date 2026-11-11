ALTER TABLE `signals` ADD COLUMN `pipeline_stage` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE `signal_followups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`signal_id` integer NOT NULL,
	`kind` text DEFAULT '跟进' NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL
);
