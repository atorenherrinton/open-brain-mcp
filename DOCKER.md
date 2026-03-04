# Docker Runbook

## 1) Prepare env

Copy your env file and set your real key values:

```bash
cd ~/open-brain-local
cp .env.docker.example .env
```

Set:
- `OPENROUTER_API_KEY`
- `MCP_ACCESS_KEY`

## 2) Start database + API

```bash
npm run docker:up
```

Then verify:

```bash
curl http://localhost:3333/health
```

## 3) Follow logs

```bash
npm run docker:logs
```

## 4) Stop services

```bash
npm run docker:down
```

## 5) Run MCP server in Docker (stdio)

Run it on demand for MCP clients:

```bash
npm run docker:mcp
```

Equivalent direct command:

```bash
docker compose run --rm -i mcp
```

## Notes

- Postgres data persists in the `pgdata` Docker volume.
- The schema auto-initializes from `schema.sql` on first DB startup.
- API runs on `http://localhost:3333`.
- Postgres is only exposed to other Docker services by default (no host port mapping).
- In Docker, DB host is `postgres` (already wired in compose `DATABASE_URL`).
