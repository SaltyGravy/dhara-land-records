CREATE TABLE `ocr_results` (
	`document_id` text PRIMARY KEY NOT NULL,
	`text_content` text DEFAULT '' NOT NULL,
	`language` text DEFAULT 'Unknown' NOT NULL,
	`engine` text DEFAULT '' NOT NULL,
	`page_count` integer DEFAULT 1 NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `processing_jobs` (
	`document_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'Queued' NOT NULL,
	`stage` text DEFAULT 'Awaiting OCR' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`engine` text DEFAULT '' NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_processing_jobs_status` ON `processing_jobs` (`status`,`updated_at`);