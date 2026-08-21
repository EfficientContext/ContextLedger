ALTER TABLE reports
ALTER COLUMN template SET DEFAULT 'range';

UPDATE reports
SET template = 'range'
WHERE template = 'weekly';
