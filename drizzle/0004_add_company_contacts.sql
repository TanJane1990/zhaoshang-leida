CREATE TABLE `company_contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`signal_id` integer NOT NULL,
	`company` text DEFAULT '' NOT NULL,
	`contact_label` text DEFAULT '' NOT NULL,
	`contact_name` text DEFAULT '' NOT NULL,
	`contact_title` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`source_name` text DEFAULT '' NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`source_type` text DEFAULT '' NOT NULL,
	`verify_status` text DEFAULT 'unverified' NOT NULL,
	`is_manual` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
