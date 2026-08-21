# Team deployment

ContextLedger uses PostgreSQL as the shared ledger. Every developer runs the CLI and MCP
adapter locally, while all clients point to the same database.

## 1. Prepare PostgreSQL

Create one database and two roles:

- an administrator role for migrations and user provisioning;
- an application role for normal reads and writes.

The included local and Docker setup uses `contextledger_admin` and `contextledger_app`.

## 2. Configure the administrator

```bash
ctx configure \
  --database-url 'postgres://contextledger_app:...@db.internal/contextledger' \
  --migration-database-url 'postgres://contextledger_admin:...@db.internal/contextledger' \
  --tenant engineering \
  --email admin@example.com

ctx migrate
ctx team init engineering --name Engineering
ctx team add-user alice@example.com \
  --tenant engineering \
  --name Alice \
  --timezone Asia/Shanghai \
  --role member
```

## 3. Configure each developer

```bash
ctx setup \
  --database-url 'postgres://contextledger_app:...@db.internal/contextledger' \
  --tenant engineering \
  --email alice@example.com \
  --db-mode external
```

The application URL is enough for normal users. The setup command skips migrations when
no administrator URL is supplied.

## 4. Share selected work

```bash
ctx save --share "Completed the retry classifier and validated its tests."
ctx import-trace --share ...
```

Private capture remains the default.

## 5. Generate and read a team report

```bash
ctx weekly --team
ctx reports
ctx show latest
ctx tags
```

A team report aggregates only `project` and `organization` context from the configured
tenant. Members of the tenant can read the report and its tags. The report owner controls
deletion.

## Security boundary

The current implementation is suitable for trusted developer machines and an internal
PostgreSQL endpoint. It does not yet provide a public web authentication layer.

Before exposing it beyond a trusted network, add:

- HTTPS;
- SSO or OIDC;
- server-side session-to-user mapping;
- secret management;
- audit logging for administrative actions;
- object storage and signed URLs for shared artifacts.
