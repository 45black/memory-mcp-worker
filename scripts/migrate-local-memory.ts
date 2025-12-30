/**
 * Migration script to import local Memory MCP data to Cloudflare Worker
 *
 * Usage:
 *   1. Export local memory: claude -p "Use mcp__memory__read_graph and output the result as JSON"
 *   2. Save to local-memory.json
 *   3. Run: npx ts-node scripts/migrate-local-memory.ts
 */

const WORKER_URL = 'https://memory-mcp.45black.workers.dev';

interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

interface Relation {
  from: string;
  to: string;
  relationType: string;
}

interface MemoryGraph {
  entities: Entity[];
  relations: Relation[];
}

async function migrateMemory() {
  // Read the local memory export
  const fs = await import('fs');
  const path = await import('path');

  const localMemoryPath = path.join(__dirname, 'local-memory.json');

  if (!fs.existsSync(localMemoryPath)) {
    console.log('No local-memory.json found.');
    console.log('');
    console.log('To export your local memory:');
    console.log('  claude -p "Use mcp__memory__read_graph and output the raw JSON result"');
    console.log('');
    console.log('Then save the output to: scripts/local-memory.json');
    process.exit(1);
  }

  const memoryData: MemoryGraph = JSON.parse(fs.readFileSync(localMemoryPath, 'utf8'));

  console.log(`Found ${memoryData.entities.length} entities and ${memoryData.relations.length} relations`);
  console.log('');
  console.log('Entities to import:');
  for (const entity of memoryData.entities) {
    console.log(`  - ${entity.name} (${entity.entityType}): ${entity.observations.length} observations`);
  }
  console.log('');

  // Import to worker
  console.log(`Importing to ${WORKER_URL}/api/import...`);

  const response = await fetch(`${WORKER_URL}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(memoryData),
  });

  if (!response.ok) {
    console.error('Import failed:', await response.text());
    process.exit(1);
  }

  const result = await response.json();
  console.log('Import successful:', result);
}

migrateMemory().catch(console.error);
