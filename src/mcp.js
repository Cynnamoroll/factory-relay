#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { operations } from './schema.js';
import { loadConfig, run } from './transport.js';
import { readFile } from 'node:fs/promises';

try {
  if (process.argv.length !== 3) throw new Error('usage: node src/mcp.js CONFIG');
  const config = await loadConfig(process.argv[2]);
  const server = new McpServer({ name: 'factory-relay-backend', version: '0.1.0' });
  for (const [name, schema] of Object.entries(operations)) {
    server.registerTool(`factory_relay_${name}`, {
      description: `Remote Apple ${name}. Uses the configured SSH account and trusted caller identity. Mutations require a current host/account lease. No desktop streaming.`,
      inputSchema: schema,
      annotations: { readOnlyHint: ['preflight', 'simulators'].includes(name), destructiveHint: !['preflight', 'simulators'].includes(name), openWorldHint: true },
    }, async args => {
      try {
        const result = await run(config, name, args);
        return { content: [{ type: 'text', text: JSON.stringify(result) },
          ...(name === 'frame' ? [{ type: 'image', mimeType: 'image/png',
            data: (await readFile(result.localPath)).toString('base64') }] : [])] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({
          error: error.message, ...(error.warnings?.length ? { warnings: error.warnings } : {}),
        }) }] };
      }
    });
  }
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
