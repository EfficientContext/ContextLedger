CREATE TABLE IF NOT EXISTS report_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  report_block_id uuid NOT NULL REFERENCES report_blocks(id) ON DELETE CASCADE,
  tag text NOT NULL,
  title text NOT NULL,
  position integer NOT NULL,
  state report_block_state NOT NULL DEFAULT 'generated',
  generated_content text NOT NULL,
  edited_content text,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, tag),
  UNIQUE (report_block_id, position),
  CHECK (tag ~ '^[a-z0-9][a-z0-9-]*$')
);

CREATE INDEX IF NOT EXISTS report_details_report_idx
ON report_details (report_id, position);

CREATE TABLE IF NOT EXISTS report_detail_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_detail_id uuid NOT NULL REFERENCES report_details(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  generated_content text NOT NULL,
  edited_content text,
  state report_block_state NOT NULL,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  edit_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_detail_id, revision)
);

DROP TRIGGER IF EXISTS report_details_set_updated_at ON report_details;
CREATE TRIGGER report_details_set_updated_at BEFORE UPDATE ON report_details
FOR EACH ROW EXECUTE FUNCTION context_ledger_set_updated_at();

ALTER TABLE report_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_detail_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON report_details;
CREATE POLICY tenant_isolation ON report_details
USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE report_details FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON report_detail_revisions;
CREATE POLICY tenant_isolation ON report_detail_revisions
USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE report_detail_revisions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contextledger_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON report_details, report_detail_revisions TO contextledger_app;
  END IF;
END
$$;
