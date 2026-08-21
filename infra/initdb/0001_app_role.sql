DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contextledger_app') THEN
    CREATE ROLE contextledger_app LOGIN PASSWORD 'contextledger_app' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE contextledger TO contextledger_app;
