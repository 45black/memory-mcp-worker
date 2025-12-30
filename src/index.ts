import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';

// Types
interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  API_KEY: string;
}

interface Entity {
  id: number;
  name: string;
  entity_type: string;
  created_at: string;
  updated_at: string;
  observations?: string[];
}

interface Relation {
  id: number;
  from_entity_id: number;
  to_entity_id: number;
  relation_type: string;
  created_at: string;
}

// MCP Protocol Types
interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

// Create Hono app
const app = new Hono<{ Bindings: Env }>();

// CORS for API access
app.use('/api/*', cors());
app.use('/mcp/*', cors());

// API Key authentication middleware
// Supports: Authorization: Bearer <key> or X-API-Key: <key>
const apiKeyAuth = async (c: any, next: any) => {
  const authHeader = c.req.header('Authorization');
  const apiKeyHeader = c.req.header('X-API-Key');

  let providedKey: string | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    providedKey = authHeader.slice(7);
  } else if (apiKeyHeader) {
    providedKey = apiKeyHeader;
  }

  if (!providedKey || providedKey !== c.env.API_KEY) {
    return c.json({ error: 'Unauthorized', message: 'Invalid or missing API key' }, 401);
  }

  await next();
};

// Apply auth to protected routes
app.use('/api/*', apiKeyAuth);
app.use('/mcp/*', apiKeyAuth);

// Health check (public)
app.get('/', (c) => {
  return c.json({
    name: 'Memory MCP Worker',
    version: '1.0.0',
    endpoints: {
      mcp: '/mcp (SSE transport)',
      api: '/api/* (REST API)',
    },
  });
});

// =============================================================================
// REST API Endpoints (for mobile/desktop apps)
// =============================================================================

// Get all entities
app.get('/api/entities', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM entities ORDER BY updated_at DESC'
  ).all();
  return c.json(results);
});

// Get entity by name with observations
app.get('/api/entities/:name', async (c) => {
  const name = c.req.param('name');

  const entity = await c.env.DB.prepare(
    'SELECT * FROM entities WHERE name = ?'
  ).bind(name).first();

  if (!entity) {
    return c.json({ error: 'Entity not found' }, 404);
  }

  const { results: observations } = await c.env.DB.prepare(
    'SELECT content FROM observations WHERE entity_id = ?'
  ).bind(entity.id).all();

  return c.json({
    ...entity,
    observations: observations.map((o: { content: string }) => o.content),
  });
});

// Create entity
app.post('/api/entities', async (c) => {
  const { name, entityType, observations } = await c.req.json();

  try {
    // Insert entity
    const result = await c.env.DB.prepare(
      'INSERT INTO entities (name, entity_type) VALUES (?, ?) RETURNING id'
    ).bind(name, entityType).first();

    const entityId = result?.id;

    // Insert observations
    if (observations && observations.length > 0) {
      const stmt = c.env.DB.prepare(
        'INSERT INTO observations (entity_id, content) VALUES (?, ?)'
      );
      await c.env.DB.batch(
        observations.map((obs: string) => stmt.bind(entityId, obs))
      );
    }

    return c.json({ success: true, id: entityId });
  } catch (e: unknown) {
    const error = e as Error;
    return c.json({ error: error.message }, 400);
  }
});

// Add observations to entity
app.post('/api/entities/:name/observations', async (c) => {
  const name = c.req.param('name');
  const { contents } = await c.req.json();

  const entity = await c.env.DB.prepare(
    'SELECT id FROM entities WHERE name = ?'
  ).bind(name).first();

  if (!entity) {
    return c.json({ error: 'Entity not found' }, 404);
  }

  const stmt = c.env.DB.prepare(
    'INSERT INTO observations (entity_id, content) VALUES (?, ?)'
  );
  await c.env.DB.batch(
    contents.map((content: string) => stmt.bind(entity.id, content))
  );

  // Update entity timestamp
  await c.env.DB.prepare(
    "UPDATE entities SET updated_at = datetime('now') WHERE id = ?"
  ).bind(entity.id).run();

  return c.json({ success: true, added: contents.length });
});

// Get relations
app.get('/api/relations', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT r.*, e1.name as from_name, e2.name as to_name
    FROM relations r
    JOIN entities e1 ON r.from_entity_id = e1.id
    JOIN entities e2 ON r.to_entity_id = e2.id
  `).all();
  return c.json(results);
});

// Create relation
app.post('/api/relations', async (c) => {
  const { from, to, relationType } = await c.req.json();

  const fromEntity = await c.env.DB.prepare(
    'SELECT id FROM entities WHERE name = ?'
  ).bind(from).first();

  const toEntity = await c.env.DB.prepare(
    'SELECT id FROM entities WHERE name = ?'
  ).bind(to).first();

  if (!fromEntity || !toEntity) {
    return c.json({ error: 'Entity not found' }, 404);
  }

  try {
    await c.env.DB.prepare(
      'INSERT INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)'
    ).bind(fromEntity.id, toEntity.id, relationType).run();

    return c.json({ success: true });
  } catch (e: unknown) {
    const error = e as Error;
    return c.json({ error: error.message }, 400);
  }
});

// Delete a relation
app.delete('/api/relations', async (c) => {
  const { from, to, relationType } = await c.req.json();

  const fromEntity = await c.env.DB.prepare(
    'SELECT id FROM entities WHERE name = ?'
  ).bind(from).first();

  const toEntity = await c.env.DB.prepare(
    'SELECT id FROM entities WHERE name = ?'
  ).bind(to).first();

  if (!fromEntity || !toEntity) {
    return c.json({ error: 'Entity not found' }, 404);
  }

  const result = await c.env.DB.prepare(
    'DELETE FROM relations WHERE from_entity_id = ? AND to_entity_id = ? AND relation_type = ?'
  ).bind(fromEntity.id, toEntity.id, relationType).run();

  return c.json({ success: true, deleted: result.meta.changes > 0 });
});

// Delete an entity and its observations/relations
app.delete('/api/entities/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));

  const entity = await c.env.DB.prepare(
    'SELECT id FROM entities WHERE name = ?'
  ).bind(name).first();

  if (!entity) {
    return c.json({ error: 'Entity not found' }, 404);
  }

  // Delete observations first (foreign key constraint)
  await c.env.DB.prepare(
    'DELETE FROM observations WHERE entity_id = ?'
  ).bind(entity.id).run();

  // Delete relations where this entity is involved
  await c.env.DB.prepare(
    'DELETE FROM relations WHERE from_entity_id = ? OR to_entity_id = ?'
  ).bind(entity.id, entity.id).run();

  // Delete the entity
  await c.env.DB.prepare(
    'DELETE FROM entities WHERE id = ?'
  ).bind(entity.id).run();

  return c.json({ success: true, deleted: name });
});

// Search entities and observations
app.get('/api/search', async (c) => {
  const query = c.req.query('q');

  if (!query) {
    return c.json({ error: 'Query required' }, 400);
  }

  // Search entity names
  const { results: entities } = await c.env.DB.prepare(
    "SELECT * FROM entities WHERE name LIKE ? OR entity_type LIKE ?"
  ).bind(`%${query}%`, `%${query}%`).all();

  // Search observations (FTS)
  const { results: obsResults } = await c.env.DB.prepare(`
    SELECT e.*, o.content as matched_observation
    FROM observations_fts fts
    JOIN observations o ON fts.rowid = o.id
    JOIN entities e ON o.entity_id = e.id
    WHERE observations_fts MATCH ?
    LIMIT 20
  `).bind(query).all();

  return c.json({
    entities,
    observations: obsResults,
  });
});

// Get full graph
app.get('/api/graph', async (c) => {
  const { results: entities } = await c.env.DB.prepare(
    'SELECT * FROM entities ORDER BY name'
  ).all();

  const { results: relations } = await c.env.DB.prepare(`
    SELECT r.*, e1.name as from_name, e2.name as to_name
    FROM relations r
    JOIN entities e1 ON r.from_entity_id = e1.id
    JOIN entities e2 ON r.to_entity_id = e2.id
  `).all();

  // Fetch observations for each entity
  const entitiesWithObs = await Promise.all(
    entities.map(async (entity: Entity) => {
      const { results: obs } = await c.env.DB.prepare(
        'SELECT content FROM observations WHERE entity_id = ?'
      ).bind(entity.id).all();
      return {
        ...entity,
        observations: obs.map((o: { content: string }) => o.content),
      };
    })
  );

  return c.json({
    entities: entitiesWithObs,
    relations: relations.map((r: Relation & { from_name: string; to_name: string }) => ({
      from: r.from_name,
      to: r.to_name,
      relationType: r.relation_type,
    })),
  });
});

// =============================================================================
// MCP Protocol Endpoints (for Claude Code)
// =============================================================================

// MCP tool definitions
const MCP_TOOLS = [
  {
    name: 'create_entities',
    description: 'Create multiple new entities in the knowledge graph',
    inputSchema: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              entityType: { type: 'string' },
              observations: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'entityType', 'observations'],
          },
        },
      },
      required: ['entities'],
    },
  },
  {
    name: 'create_relations',
    description: 'Create relations between entities',
    inputSchema: {
      type: 'object',
      properties: {
        relations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              relationType: { type: 'string' },
            },
            required: ['from', 'to', 'relationType'],
          },
        },
      },
      required: ['relations'],
    },
  },
  {
    name: 'add_observations',
    description: 'Add observations to existing entities',
    inputSchema: {
      type: 'object',
      properties: {
        observations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              entityName: { type: 'string' },
              contents: { type: 'array', items: { type: 'string' } },
            },
            required: ['entityName', 'contents'],
          },
        },
      },
      required: ['observations'],
    },
  },
  {
    name: 'read_graph',
    description: 'Read the entire knowledge graph',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_nodes',
    description: 'Search for nodes by query',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'open_nodes',
    description: 'Open specific nodes by name',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' } },
      },
      required: ['names'],
    },
  },
  {
    name: 'delete_entities',
    description: 'Delete entities from the graph',
    inputSchema: {
      type: 'object',
      properties: {
        entityNames: { type: 'array', items: { type: 'string' } },
      },
      required: ['entityNames'],
    },
  },
  {
    name: 'delete_relations',
    description: 'Delete relations from the graph',
    inputSchema: {
      type: 'object',
      properties: {
        relations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              relationType: { type: 'string' },
            },
            required: ['from', 'to', 'relationType'],
          },
        },
      },
      required: ['relations'],
    },
  },
];

// Handle MCP requests
async function handleMCPRequest(request: MCPRequest, db: D1Database): Promise<MCPResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'memory-mcp', version: '1.0.0' },
          },
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: MCP_TOOLS },
        };

      case 'tools/call': {
        const toolName = params?.name as string;
        const toolArgs = params?.arguments as Record<string, unknown>;
        const result = await executeToolCall(toolName, toolArgs, db);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
        };
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  } catch (e: unknown) {
    const error = e as Error;
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: error.message },
    };
  }
}

// Execute tool calls
async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  db: D1Database
): Promise<unknown> {
  switch (name) {
    case 'read_graph': {
      const { results: entities } = await db.prepare(
        'SELECT * FROM entities ORDER BY name'
      ).all();

      const { results: relations } = await db.prepare(`
        SELECT e1.name as from_name, e2.name as to_name, r.relation_type
        FROM relations r
        JOIN entities e1 ON r.from_entity_id = e1.id
        JOIN entities e2 ON r.to_entity_id = e2.id
      `).all();

      const entitiesWithObs = await Promise.all(
        entities.map(async (entity: Entity) => {
          const { results: obs } = await db.prepare(
            'SELECT content FROM observations WHERE entity_id = ?'
          ).bind(entity.id).all();
          return {
            name: entity.name,
            entityType: entity.entity_type,
            observations: obs.map((o: { content: string }) => o.content),
          };
        })
      );

      return {
        entities: entitiesWithObs,
        relations: relations.map((r: { from_name: string; to_name: string; relation_type: string }) => ({
          from: r.from_name,
          to: r.to_name,
          relationType: r.relation_type,
        })),
      };
    }

    case 'search_nodes': {
      const query = args.query as string;
      const { results: entities } = await db.prepare(
        "SELECT * FROM entities WHERE name LIKE ? OR entity_type LIKE ?"
      ).bind(`%${query}%`, `%${query}%`).all();

      const entitiesWithObs = await Promise.all(
        entities.map(async (entity: Entity) => {
          const { results: obs } = await db.prepare(
            'SELECT content FROM observations WHERE entity_id = ?'
          ).bind(entity.id).all();
          return {
            name: entity.name,
            entityType: entity.entity_type,
            observations: obs.map((o: { content: string }) => o.content),
          };
        })
      );

      return { entities: entitiesWithObs };
    }

    case 'open_nodes': {
      const names = args.names as string[];
      const placeholders = names.map(() => '?').join(',');
      const { results: entities } = await db.prepare(
        `SELECT * FROM entities WHERE name IN (${placeholders})`
      ).bind(...names).all();

      const entitiesWithObs = await Promise.all(
        entities.map(async (entity: Entity) => {
          const { results: obs } = await db.prepare(
            'SELECT content FROM observations WHERE entity_id = ?'
          ).bind(entity.id).all();
          return {
            name: entity.name,
            entityType: entity.entity_type,
            observations: obs.map((o: { content: string }) => o.content),
          };
        })
      );

      return { entities: entitiesWithObs };
    }

    case 'create_entities': {
      const entityList = args.entities as Array<{
        name: string;
        entityType: string;
        observations: string[];
      }>;

      for (const entity of entityList) {
        const result = await db.prepare(
          'INSERT OR IGNORE INTO entities (name, entity_type) VALUES (?, ?) RETURNING id'
        ).bind(entity.name, entity.entityType).first();

        let entityId = result?.id;

        if (!entityId) {
          const existing = await db.prepare(
            'SELECT id FROM entities WHERE name = ?'
          ).bind(entity.name).first();
          entityId = existing?.id;
        }

        if (entityId && entity.observations.length > 0) {
          const stmt = db.prepare(
            'INSERT INTO observations (entity_id, content) VALUES (?, ?)'
          );
          await db.batch(
            entity.observations.map((obs) => stmt.bind(entityId, obs))
          );
        }
      }

      return { success: true, created: entityList.length };
    }

    case 'create_relations': {
      const relationList = args.relations as Array<{
        from: string;
        to: string;
        relationType: string;
      }>;

      for (const rel of relationList) {
        const fromEntity = await db.prepare(
          'SELECT id FROM entities WHERE name = ?'
        ).bind(rel.from).first();

        const toEntity = await db.prepare(
          'SELECT id FROM entities WHERE name = ?'
        ).bind(rel.to).first();

        if (fromEntity && toEntity) {
          await db.prepare(
            'INSERT OR IGNORE INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)'
          ).bind(fromEntity.id, toEntity.id, rel.relationType).run();
        }
      }

      return { success: true, created: relationList.length };
    }

    case 'add_observations': {
      const observationList = args.observations as Array<{
        entityName: string;
        contents: string[];
      }>;

      let totalAdded = 0;

      for (const obs of observationList) {
        const entity = await db.prepare(
          'SELECT id FROM entities WHERE name = ?'
        ).bind(obs.entityName).first();

        if (entity) {
          const stmt = db.prepare(
            'INSERT INTO observations (entity_id, content) VALUES (?, ?)'
          );
          await db.batch(
            obs.contents.map((content) => stmt.bind(entity.id, content))
          );
          totalAdded += obs.contents.length;

          await db.prepare(
            "UPDATE entities SET updated_at = datetime('now') WHERE id = ?"
          ).bind(entity.id).run();
        }
      }

      return { success: true, added: totalAdded };
    }

    case 'delete_entities': {
      const names = args.entityNames as string[];
      for (const name of names) {
        await db.prepare('DELETE FROM entities WHERE name = ?').bind(name).run();
      }
      return { success: true, deleted: names.length };
    }

    case 'delete_relations': {
      const relations = args.relations as Array<{
        from: string;
        to: string;
        relationType: string;
      }>;

      for (const rel of relations) {
        await db.prepare(`
          DELETE FROM relations
          WHERE from_entity_id = (SELECT id FROM entities WHERE name = ?)
            AND to_entity_id = (SELECT id FROM entities WHERE name = ?)
            AND relation_type = ?
        `).bind(rel.from, rel.to, rel.relationType).run();
      }

      return { success: true, deleted: relations.length };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// MCP SSE endpoint
app.post('/mcp', async (c) => {
  const request = await c.req.json() as MCPRequest;
  const response = await handleMCPRequest(request, c.env.DB);
  return c.json(response);
});

// MCP SSE stream endpoint (for long-running connections)
app.get('/mcp/sse', async (c) => {
  // SSE transport for MCP
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial connection event
      const initEvent = `event: endpoint\ndata: /mcp\n\n`;
      controller.enqueue(encoder.encode(initEvent));
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// Bulk import endpoint (for migrating from local memory)
app.post('/api/import', async (c) => {
  const { entities, relations } = await c.req.json();

  // Import entities with observations
  for (const entity of entities) {
    const result = await c.env.DB.prepare(
      'INSERT OR IGNORE INTO entities (name, entity_type) VALUES (?, ?) RETURNING id'
    ).bind(entity.name, entity.entityType).first();

    let entityId = result?.id;

    if (!entityId) {
      const existing = await c.env.DB.prepare(
        'SELECT id FROM entities WHERE name = ?'
      ).bind(entity.name).first();
      entityId = existing?.id;
    }

    if (entityId && entity.observations?.length > 0) {
      const stmt = c.env.DB.prepare(
        'INSERT INTO observations (entity_id, content) VALUES (?, ?)'
      );
      await c.env.DB.batch(
        entity.observations.map((obs: string) => stmt.bind(entityId, obs))
      );
    }
  }

  // Import relations
  for (const rel of relations) {
    const fromEntity = await c.env.DB.prepare(
      'SELECT id FROM entities WHERE name = ?'
    ).bind(rel.from).first();

    const toEntity = await c.env.DB.prepare(
      'SELECT id FROM entities WHERE name = ?'
    ).bind(rel.to).first();

    if (fromEntity && toEntity) {
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)'
      ).bind(fromEntity.id, toEntity.id, rel.relationType).run();
    }
  }

  return c.json({
    success: true,
    imported: {
      entities: entities.length,
      relations: relations.length,
    },
  });
});

export default app;
