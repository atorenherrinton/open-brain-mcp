# Supabase Setup

The Open Brain MCP server runs as a Supabase Edge Function at `supabase/functions/open-brain`. It speaks both MCP-over-HTTP (for Claude / Gemini / other agents) and a small REST API (for the Apple Shortcut and similar clients).

## 1. Prerequisites

Install the Supabase CLI and authenticate once:

```bash
brew install supabase/tap/supabase
supabase login
```

## 2. Configure env

```bash
cp .env.example .env
```

Fill in:

- `SUPABASE_DB_URL`: pooled connection string from Supabase (used by `supabase db push`)
- `SUPABASE_URL`: project URL
- `SUPABASE_SECRET_KEY`: optional custom name for the Edge Function service-role key
- `OPENROUTER_API_KEY`
- `MCP_ACCESS_KEY`

The Edge Function accepts either `SUPABASE_SECRET_KEY` or Supabase's built-in `SUPABASE_SERVICE_ROLE_KEY`.

## 3. Link the repo to your project

```bash
supabase init
supabase link --project-ref your-project-ref
```

## 4. Push the schema

```bash
npm run supabase:db:push
```

If you prefer the SQL editor, run [supabase/migrations/202603130001_open_brain.sql](supabase/migrations/202603130001_open_brain.sql).

## 5. Deploy the Edge Function

```bash
npm run supabase:functions:deploy
```

This exposes:

- `GET /functions/v1/open-brain/health`
- `POST /functions/v1/open-brain/capture`
- `POST /functions/v1/open-brain/search`
- `GET /functions/v1/open-brain/thoughts`
- `GET /functions/v1/open-brain/stats`
- `POST /functions/v1/open-brain/mcp` — MCP-over-HTTP endpoint for AI agents

`capture`, `search`, `thoughts`, and `stats` require the same `x-brain-key` header if `MCP_ACCESS_KEY` is set.

## 6. Gemini CLI configuration

Gemini CLI can connect directly to the deployed Edge Function over HTTP MCP.

```bash
gemini mcp add --transport http open-brain-mcp https://your-project-ref.supabase.co/functions/v1/open-brain/mcp \
	--scope user \
	--description "Open Brain MCP over Supabase Edge Function" \
	--trust \
	-H "x-brain-key: YOUR_MCP_ACCESS_KEY"
```

Or copy [gemini-settings.example.json](./gemini-settings.example.json) into `~/.gemini/settings.json` and replace the placeholders.