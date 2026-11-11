ALTER TABLE signals ADD COLUMN deal_stage TEXT NOT NULL DEFAULT 'intent';
--> statement-breakpoint
ALTER TABLE signals ADD COLUMN landed_city TEXT NOT NULL DEFAULT '';
