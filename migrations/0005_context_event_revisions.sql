CREATE TABLE IF NOT EXISTS context_event_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  context_event_id uuid NOT NULL REFERENCES context_events(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  title text,
  text_content text,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  visibility context_visibility NOT NULL,
  payload jsonb NOT NULL,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  edit_type text NOT NULL DEFAULT 'context_edit',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (context_event_id, revision)
);

CREATE INDEX IF NOT EXISTS context_event_revisions_event_idx
ON context_event_revisions (context_event_id, revision DESC);

ALTER TABLE context_event_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON context_event_revisions;
CREATE POLICY tenant_isolation ON context_event_revisions
USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE context_event_revisions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contextledger_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON context_event_revisions TO contextledger_app;
  END IF;
END
$$;
