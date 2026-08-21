# Contributing

## Local development

```bash
npm install
cp .env.example .env
ctx start --no-open
```

Run all checks before opening a pull request:

```bash
npm run check
```

## Repository rules

- Keep domain logic free of HTTP, CLI, and PostgreSQL concerns.
- Put orchestration in `src/application`.
- Put external systems in `src/infrastructure` or `src/integrations`.
- Keep CLI, MCP, and HTTP code as thin adapters over application services.
- Add database changes as ordered files under `migrations`.
- Add a new versioned prompt directory rather than editing a released prompt.
- Do not commit `.env`, `.local`, `dist`, `node_modules`, session files, or credentials.
- Add or update tests for behavior changes.

## Pull request checklist

```bash
npm run typecheck
npm test
npm run build
```

For UI changes, also open `http://127.0.0.1:4318` and verify the affected workflow.
