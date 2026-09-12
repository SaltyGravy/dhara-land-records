CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`document_id` text,
	`details` text DEFAULT '' NOT NULL,
	`previous_hash` text DEFAULT '' NOT NULL,
	`event_hash` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_created_at` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_document_id` ON `audit_events` (`document_id`);--> statement-breakpoint
CREATE TABLE `corrections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`field_label` text NOT NULL,
	`predicted_value` text NOT NULL,
	`corrected_value` text NOT NULL,
	`source_excerpt` text NOT NULL,
	`language` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_corrections_field` ON `corrections` (`field_label`);--> statement-breakpoint
CREATE INDEX `idx_corrections_created_at` ON `corrections` (`created_at`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text DEFAULT 'Not detected' NOT NULL,
	`document` text NOT NULL,
	`filename` text NOT NULL,
	`location` text NOT NULL,
	`district` text NOT NULL,
	`survey` text DEFAULT '—' NOT NULL,
	`type` text NOT NULL,
	`language` text NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`file_key` text,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`checksum_sha256` text DEFAULT '' NOT NULL,
	`ocr_engine` text DEFAULT 'Hosted prototype intake' NOT NULL,
	`fields_json` text DEFAULT '[]' NOT NULL,
	`validation_issues` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_documents_status` ON `documents` (`status`);--> statement-breakpoint
CREATE INDEX `idx_documents_district` ON `documents` (`district`);--> statement-breakpoint
CREATE INDEX `idx_documents_created_at` ON `documents` (`created_at`);--> statement-breakpoint
CREATE TABLE `notification_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`notification_id` integer NOT NULL,
	`username` text NOT NULL,
	`read_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_receipt` ON `notification_receipts` (`notification_id`,`username`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`level` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `parcels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`khasra` text NOT NULL,
	`owner` text NOT NULL,
	`area` real NOT NULL,
	`classification` text NOT NULL,
	`status` text NOT NULL,
	`village` text NOT NULL,
	`tehsil` text NOT NULL,
	`district` text NOT NULL,
	`record_id` text,
	`geometry_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_parcels_khasra` ON `parcels` (`khasra`);--> statement-breakpoint
CREATE INDEX `idx_parcels_location` ON `parcels` (`district`,`village`);--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`version` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_revisions_document` ON `revisions` (`document_id`,`version`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_username` ON `users` (`username`);--> statement-breakpoint
CREATE INDEX `idx_users_role` ON `users` (`role`);