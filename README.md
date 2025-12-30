# Memory MCP Worker

Cloudflare Worker implementing MCP protocol for cross-device memory/knowledge graph access.

## Features

- **MCP Protocol Support**: Works with Claude Code via HTTP transport
- **REST API**: Access from mobile apps, desktop apps, n8n workflows
- **D1 Database**: SQLite-based persistent storage
- **Full-text Search**: Search across all observations

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Create D1 Database

```bash
# Create the database
wrangler d1 create memory-graph

# Copy the database_id from output to wrangler.toml
```

### 3. Run Migrations

```bash
# Local development
npm run db:migrate:local

# Production
npm run db:migrate
```

### 4. Deploy

```bash
npm run deploy
```

### 5. Set API Key Secret

```bash
# Generate an API key
openssl rand -base64 32 | tr -d '/+=' | head -c 32

# Add as secret
echo "YOUR_API_KEY" | npx wrangler secret put API_KEY
```

### 6. Configure Claude Code

Add to your `~/.claude/settings.json` or `.mcp.json`:

```json
{
  "mcpServers": {
    "memory-remote": {
      "type": "http",
      "url": "https://memory-mcp.45black-limited.workers.dev/mcp",
      "headers": {
        "X-API-Key": "YOUR_API_KEY"
      }
    }
  }
}
```

## Migrating from Local Memory

1. Export your local memory:
   ```bash
   claude -p "Use mcp__memory__read_graph and output the raw JSON result" > scripts/local-memory.json
   ```

2. Run migration:
   ```bash
   npx ts-node scripts/migrate-local-memory.ts
   ```

## API Endpoints

### REST API (for apps)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/entities` | GET | List all entities |
| `/api/entities/:name` | GET | Get entity with observations |
| `/api/entities` | POST | Create entity |
| `/api/entities/:name/observations` | POST | Add observations |
| `/api/relations` | GET | List all relations |
| `/api/relations` | POST | Create relation |
| `/api/search?q=` | GET | Search entities and observations |
| `/api/graph` | GET | Get full graph |
| `/api/import` | POST | Bulk import |

### MCP Protocol

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC requests |
| `/mcp/sse` | GET | SSE connection for MCP |

## MCP Tools Available

- `create_entities` - Create new entities
- `create_relations` - Create relations between entities
- `add_observations` - Add observations to entities
- `read_graph` - Read entire knowledge graph
- `search_nodes` - Search by query
- `open_nodes` - Get specific nodes by name
- `delete_entities` - Delete entities
- `delete_relations` - Delete relations

## Authentication

All `/api/*` and `/mcp/*` endpoints require authentication via API key.

**Headers supported:**
- `X-API-Key: YOUR_API_KEY`
- `Authorization: Bearer YOUR_API_KEY`

The health check endpoint (`/`) is public.

## Mobile App Integration

Example fetch from a mobile app:

```typescript
const API_KEY = 'YOUR_API_KEY';
const BASE_URL = 'https://memory-mcp.45black-limited.workers.dev';

const headers = {
  'Content-Type': 'application/json',
  'X-API-Key': API_KEY,
};

// Search for a project
const response = await fetch(`${BASE_URL}/api/search?q=Household%20Planner`, { headers });
const data = await response.json();

// Add an observation
await fetch(`${BASE_URL}/api/entities/Household%20Planner/observations`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    contents: ['Added new budget category feature']
  })
});
```

## n8n Integration

An n8n workflow is included for querying the Memory API via webhooks.

### Setup

1. Import `n8n-workflow-memory-api.json` into n8n
2. Create a "Header Auth" credential:
   - Name: `Memory MCP API Key`
   - Header Name: `X-API-Key`
   - Header Value: `YOUR_API_KEY`
3. Assign the credential to all three HTTP Request nodes
4. Activate the workflow

### Endpoints

**Search** - POST to `/webhook/memory-search`:
```bash
curl -X POST https://your-n8n-instance/webhook/memory-search \
  -H "Content-Type: application/json" \
  -d '{"query": "Household Planner"}'
```

**Get Entity** - POST to `/webhook/memory-entity`:
```bash
curl -X POST https://your-n8n-instance/webhook/memory-entity \
  -H "Content-Type: application/json" \
  -d '{"name": "Household Planner"}'
```

**Get Full Graph** - POST to `/webhook/memory-graph`:
```bash
curl -X POST https://your-n8n-instance/webhook/memory-graph \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Development

```bash
# Start local dev server
npm run dev

# Typecheck
npm run typecheck
```

## Architecture

```
┌─────────────────────────────────────────┐
│         Cloudflare Worker               │
│      memory-mcp.45black.workers.dev     │
├─────────────────────────────────────────┤
│  Hono Framework                         │
│  ├── /api/* → REST API                  │
│  └── /mcp   → MCP Protocol              │
├─────────────────────────────────────────┤
│  Cloudflare D1 (SQLite)                 │
│  ├── entities                           │
│  ├── observations                       │
│  ├── relations                          │
│  └── observations_fts (full-text)       │
└─────────────────────────────────────────┘
```
