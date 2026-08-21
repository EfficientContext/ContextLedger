# Team deployment

ContextLedger team mode uses one shared PostgreSQL database. Every member runs the CLI,
MCP adapter, and optional web UI on their own machine.

Members do not visit one shared `localhost` page. Their local ContextLedger process uses
their configured email as its identity and connects to the same tenant in PostgreSQL.

## Values used in this guide

```text
APP_DATABASE_URL     Normal application connection shared with members
ADMIN_DATABASE_URL   Administrator connection kept by the workspace admin
TENANT_SLUG          engineering
```

The application database role needs normal access to the ContextLedger schema. The
administrator role needs permission to apply migrations and provision tenants and users.

## 1. Administrator: initialize the database

```bash
ctx configure \
  --database-url "$APP_DATABASE_URL" \
  --migration-database-url "$ADMIN_DATABASE_URL" \
  --tenant engineering \
  --email admin@example.com

ctx migrate
ctx team init engineering --name Engineering
```

Add the administrator if setup did not already create the account:

```bash
ctx team add-user admin@example.com \
  --tenant engineering \
  --name Admin \
  --timezone Asia/Shanghai \
  --role owner
```

## 2. Administrator: add members

Create the user before the member connects:

```bash
ctx team add-user alice@example.com \
  --tenant engineering \
  --name Alice \
  --timezone Asia/Shanghai \
  --role member
```

Check the workspace:

```bash
ctx team users --tenant engineering
```

Send Alice only:

```text
APP_DATABASE_URL
tenant: engineering
email: alice@example.com
```

Keep `ADMIN_DATABASE_URL` private.

## 3. Member: connect a local installation

On Alice's machine:

```bash
ctx setup \
  --database-url "$APP_DATABASE_URL" \
  --tenant engineering \
  --email alice@example.com \
  --db-mode external

ctx connect all
ctx doctor
ctx whoami
```

`ctx whoami` should show Alice's identity and the shared tenant. Normal members do not run
migrations and do not need the administrator URL.

## 4. Member: use CLI, agents, and the local web UI

Alice can use ContextLedger normally:

```bash
ctx sync --source all --since 7d
ctx save "Private investigation note."
ctx open
```

`ctx open` opens Alice's local web process, normally at `http://127.0.0.1:4318`. The data
is read from the shared PostgreSQL database.

Codex and Claude Code access the same workspace through the local MCP process registered
by `ctx connect all`.

## 5. Choose what enters team reports

Private is the default:

```bash
ctx save "Private investigation note."
ctx sync --source codex --since 7d
```

Share selected work:

```bash
ctx save --share "Completed the retry classifier and validated its tests."
ctx sync --source codex --since 7d --share
```

The web sync panel can also set visibility to team or organization.

Visibility controls report inclusion:

| Visibility     | Personal report | Team report |
| -------------- | --------------- | ----------- |
| `private`      | Yes             | No          |
| `project`      | Yes             | Yes         |
| `organization` | Yes             | Yes         |

## 6. Read a team report

Any configured member in the same tenant can run:

```bash
ctx report --since 7d --team
ctx reports
ctx show latest
ctx tags
ctx tag TAG
```

Team reports and detail tags are also available through MCP and each member's local web
UI. Only the report owner can delete the report.

## Security boundary

The current implementation is for trusted developer machines and an internal PostgreSQL
endpoint. The HTTP server uses the identity configured in the local `.env`; it is not a
public multi-user login server.

Before exposing ContextLedger beyond a trusted network, add:

- TLS for PostgreSQL and HTTPS for any shared HTTP deployment;
- SSO or OIDC;
- server-side session-to-user mapping;
- secret management for database credentials;
- audit logging for administrative changes;
- object storage and signed URLs for shared artifacts.
