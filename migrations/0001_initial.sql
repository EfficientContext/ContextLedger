CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE context_visibility AS ENUM ('private', 'project', 'organization');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE context_source_kind AS ENUM ('intenttrace', 'codex', 'claude', 'git', 'iwiki', 'experiment', 'manual', 'mcp');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE claim_kind AS ENUM ('work', 'decision', 'result', 'metric', 'blocker', 'follow_up', 'definition');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE claim_status AS ENUM ('observed', 'stated', 'inferred', 'confirmed', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE causal_relation AS ENUM ('enabled', 'reduced', 'increased', 'blocked', 'contributed_to', 'correlated_with', 'caused');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE verification_status AS ENUM ('unverified', 'correlated', 'controlled', 'user_confirmed', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE report_block_state AS ENUM ('generated', 'user_edited', 'user_confirmed', 'needs_evidence', 'stale', 'locked');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  display_name text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  visibility context_visibility NOT NULL DEFAULT 'private',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS project_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  alias_type text NOT NULL CHECK (alias_type IN ('repo', 'path', 'keyword', 'iwiki_space', 'explicit')),
  alias_value text NOT NULL,
  weight numeric(4,3) NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, alias_type, alias_value)
);

CREATE TABLE IF NOT EXISTS context_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  source_kind context_source_kind NOT NULL,
  source_ref text NOT NULL,
  source_event_id text,
  observed_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,
  title text,
  text_content text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  project_hints text[] NOT NULL DEFAULT '{}',
  visibility context_visibility NOT NULL DEFAULT 'private',
  classifier_confidence numeric(4,3),
  classifier_reason text,
  classifier_version text,
  user_confirmed_project boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, content_hash)
);

CREATE INDEX IF NOT EXISTS context_events_tenant_observed_idx ON context_events (tenant_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS context_events_actor_observed_idx ON context_events (actor_user_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS context_events_project_observed_idx ON context_events (project_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS context_events_payload_gin_idx ON context_events USING gin (payload);
CREATE INDEX IF NOT EXISTS context_events_search_idx ON context_events USING gin (
  to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(text_content, ''))
);

CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  event_id uuid REFERENCES context_events(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('document', 'image', 'experiment', 'commit', 'pull_request', 'trace', 'link', 'log')),
  uri text,
  object_key text,
  content_hash text,
  title text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  visibility context_visibility NOT NULL DEFAULT 'private',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  event_id uuid REFERENCES context_events(id) ON DELETE SET NULL,
  kind claim_kind NOT NULL,
  status claim_status NOT NULL,
  subject text NOT NULL,
  predicate text NOT NULL,
  object_text text,
  summary text NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claims_owner_occurred_idx ON claims (owner_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS claims_project_occurred_idx ON claims (project_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS metric_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  metric_name text NOT NULL,
  metric_definition text,
  value numeric,
  unit text,
  baseline_value numeric,
  comparison_method text,
  sample_size integer,
  measured_from timestamptz,
  measured_to timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evidence_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  event_id uuid REFERENCES context_events(id) ON DELETE SET NULL,
  artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
  evidence_type text NOT NULL CHECK (evidence_type IN ('source_event', 'artifact', 'user_statement', 'experiment_result')),
  locator jsonb NOT NULL DEFAULT '{}'::jsonb,
  quote_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_id IS NOT NULL OR artifact_id IS NOT NULL OR evidence_type = 'user_statement')
);

CREATE TABLE IF NOT EXISTS causal_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cause_claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  effect_claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  relation causal_relation NOT NULL,
  mechanism text,
  confidence numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  verification_status verification_status NOT NULL DEFAULT 'unverified',
  alternative_explanations text[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cause_claim_id <> effect_claim_id)
);

CREATE TABLE IF NOT EXISTS causal_edge_evidence (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  causal_edge_id uuid NOT NULL REFERENCES causal_edges(id) ON DELETE CASCADE,
  evidence_ref_id uuid NOT NULL REFERENCES evidence_refs(id) ON DELETE CASCADE,
  PRIMARY KEY (causal_edge_id, evidence_ref_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  timezone text NOT NULL,
  template text NOT NULL DEFAULT 'weekly',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'published')),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS reports_owner_period_idx ON reports (owner_user_id, period_start DESC, period_end DESC);

CREATE TABLE IF NOT EXISTS report_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  section_key text NOT NULL,
  position integer NOT NULL,
  state report_block_state NOT NULL DEFAULT 'generated',
  generated_content text NOT NULL,
  edited_content text,
  content_hash text NOT NULL,
  claim_ids uuid[] NOT NULL DEFAULT '{}',
  missing_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, position)
);

CREATE TABLE IF NOT EXISTS report_block_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_block_id uuid NOT NULL REFERENCES report_blocks(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  generated_content text NOT NULL,
  edited_content text,
  state report_block_state NOT NULL,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  edit_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_block_id, revision)
);

CREATE TABLE IF NOT EXISTS feedback_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  rule_type text NOT NULL CHECK (rule_type IN ('project_route', 'terminology', 'style', 'causal_language', 'report_exclusion')),
  scope text NOT NULL CHECK (scope IN ('user', 'project', 'tenant')),
  matcher jsonb NOT NULL,
  action jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION context_ledger_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS projects_set_updated_at ON projects;
CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION context_ledger_set_updated_at();

DROP TRIGGER IF EXISTS claims_set_updated_at ON claims;
CREATE TRIGGER claims_set_updated_at BEFORE UPDATE ON claims
FOR EACH ROW EXECUTE FUNCTION context_ledger_set_updated_at();

DROP TRIGGER IF EXISTS reports_set_updated_at ON reports;
CREATE TRIGGER reports_set_updated_at BEFORE UPDATE ON reports
FOR EACH ROW EXECUTE FUNCTION context_ledger_set_updated_at();

DROP TRIGGER IF EXISTS report_blocks_set_updated_at ON report_blocks;
CREATE TRIGGER report_blocks_set_updated_at BEFORE UPDATE ON report_blocks
FOR EACH ROW EXECUTE FUNCTION context_ledger_set_updated_at();

DROP TRIGGER IF EXISTS feedback_rules_set_updated_at ON feedback_rules;
CREATE TRIGGER feedback_rules_set_updated_at BEFORE UPDATE ON feedback_rules
FOR EACH ROW EXECUTE FUNCTION context_ledger_set_updated_at();

-- The API opens a transaction and sets app.tenant_id/app.user_id for every request.
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE causal_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE causal_edge_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_block_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_rules ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'projects', 'project_aliases', 'context_events', 'artifacts', 'claims',
    'metric_observations', 'evidence_refs', 'causal_edges', 'causal_edge_evidence',
    'reports', 'report_blocks', 'report_block_revisions', 'feedback_rules'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contextledger_app') THEN
    GRANT USAGE ON SCHEMA public TO contextledger_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO contextledger_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO contextledger_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO contextledger_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO contextledger_app;
  END IF;
END
$$;
