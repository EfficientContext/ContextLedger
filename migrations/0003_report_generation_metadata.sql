ALTER TABLE reports
ADD COLUMN IF NOT EXISTS generation_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
