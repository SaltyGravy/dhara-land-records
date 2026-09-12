CREATE TABLE `citizen_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`tracking_hash` text NOT NULL,
	`request_type` text NOT NULL,
	`record_id` text,
	`applicant_name` text NOT NULL,
	`contact_cipher` text NOT NULL,
	`details_cipher` text NOT NULL,
	`status` text DEFAULT 'Submitted' NOT NULL,
	`assigned_to` text,
	`resolution` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_citizen_requests_status` ON `citizen_requests` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `integration_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`integration_key` text NOT NULL,
	`operation` text NOT NULL,
	`document_id` text,
	`status` text NOT NULL,
	`response_code` integer,
	`message` text DEFAULT '' NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_integration_runs` ON `integration_runs` (`integration_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `learning_dictionary` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`field_label` text NOT NULL,
	`language` text NOT NULL,
	`predicted_value` text NOT NULL,
	`corrected_value` text NOT NULL,
	`occurrences` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_learning_pattern` ON `learning_dictionary` (`field_label`,`language`,`predicted_value`,`corrected_value`);--> statement-breakpoint
CREATE TABLE `login_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oidc_states` (
	`state` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`verifier` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
