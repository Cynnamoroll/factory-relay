#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { QAClient } from './qa-client.js';
import { tasks, descriptions, failure } from './qa-contract.js';

try {
  if (process.argv.length > 3) throw new Error('invalid_arguments');
  const client = new QAClient(process.argv[2]);
  const server = new McpServer({ name: 'factory-relay', version: '0.2.0' });
  for (const [name, schema] of Object.entries(tasks)) {
    if (name === 'qa_control') continue;
    server.registerTool(name, { description: descriptions[name], inputSchema: schema,
      annotations: { readOnlyHint: ['qa_status', 'qa_runs', 'qa_replay'].includes(name),
        destructiveHint: name === 'qa_act', openWorldHint: false } }, async args => {
      try {
        const reply = await client.task(name, args);
        const { image, ...data } = reply;
        if (image) data.imageMetadata = { version: image.version, ageMs: image.ageMs, receivedAt: image.receivedAt };
        return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) },
          ...(image ? [{ type: 'image', mimeType: image.mimeType, data: image.data }] : [])] };
      } catch (error) {
        const data = { error: error.failure ?? failure(error, name) };
        return { isError: true, structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
      }
    });
  }
  await server.connect(new StdioServerTransport());
} catch { console.error('qa_mcp_start_failed'); process.exitCode = 1; }
