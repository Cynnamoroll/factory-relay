#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { QAClient } from './qa-client.js';
import { clickAndCheckTextSchema } from './qa-procedure.js';
import { tasks, descriptions, failure } from './qa-contract.js';
import { windowSessionFailure, windowSessionStart } from './qa-window-session-contract.js';

try {
  const scoped = process.argv[2] === '--window-session';
  const args = process.argv.slice(scoped ? 3 : 2);
  if (args.length > 1) throw new Error('invalid_arguments');
  const client = new QAClient(args[0]);
  const disconnect = new AbortController();
  let session, opening, closed = false;
  const task = async (name, input) => {
    if (!scoped) return client.task(name, input);
    if (closed) throw new Error('stale_control');
    if (session) return name === 'qa_click_and_check_text' ? session.clickAndCheckText(input) : session.task(name, input);
    if (name === 'qa_targets') {
      const found = await client.task(name);
      return { ...found, displays: [], windows: found.windows.filter(window => Number.isFinite(window.processStartedAt)),
        input: 'Window sessions accept only background accessibility actions; use an exact target and processStartedAt.' };
    }
    if (name === 'qa_status') return { connection: 'unbound', runId: null, desktopAllowed: false };
    if (name !== 'qa_start') throw new Error('start_run_first');
    if (opening) throw new Error('broker_busy');
    opening = client.openWindowSession(input, { signal: disconnect.signal });
    try {
      session = await opening;
      if (closed) throw new Error('stale_control');
      return session.started;
    } finally { opening = undefined; }
  };
  const server = new McpServer({ name: 'factory-relay', version: '0.2.0' });
  const projection = { compact: z.literal(true).optional().describe('Return only run outcome, replay link, and artifact paths/export states.') };
  const registered = scoped ? { ...tasks, qa_click_and_check_text: clickAndCheckTextSchema,
    qa_finish: tasks.qa_finish.extend(projection), qa_report: tasks.qa_report.extend(projection) } : tasks;
  for (const [name, schema] of Object.entries(registered)) {
    if (name === 'qa_control') continue;
    const scopedStart = scoped && name === 'qa_start';
    const description = scopedStart
      ? 'Start one private window run. To attach, pass the exact target and processStartedAt from qa_targets. To launch and clean up one new RelayMac fixture, pass managedFixture:true with neither target nor processStartedAt. This client cannot resume, retarget, or take over.'
      : name === 'qa_click_and_check_text'
        ? 'Bound window only: use fresh local English OCR to guard a single background left click at calibrated normalized x,y. Requires beforeText and rejects an already visible expectedText. Records a visual check from fresh post-click pixels. Lines are literal and case-sensitive. Never repeat uncertain input.'
        : descriptions[name];
    server.registerTool(name, { description, inputSchema: scopedStart ? windowSessionStart : schema,
      annotations: { readOnlyHint: ['qa_status', 'qa_runs', 'qa_replay'].includes(name),
        destructiveHint: ['qa_act', 'qa_click_and_check_text'].includes(name), openWorldHint: false } }, async args => {
      try {
        const reply = await task(name, args);
        const { image, ...data } = reply;
        if (image) data.imageMetadata = { version: image.version, ageMs: image.ageMs, receivedAt: image.receivedAt };
        return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) },
          ...(image ? [{ type: 'image', mimeType: image.mimeType, data: image.data }] : [])] };
      } catch (error) {
        const data = { error: error.failure ?? (scoped ? windowSessionFailure : failure)(error, name) };
        return { isError: true, structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
      }
    });
  }
  if (scoped) {
    const close = async () => {
      if (closed) return;
      closed = true;
      disconnect.abort();
      try { await (session ?? await opening?.catch(() => undefined))?.close(); }
      catch (error) { console.error(/^[a-z_]{1,64}$/.test(error.message) ? error.message : 'session_cleanup_unconfirmed'); }
      finally { await server.close(); }
    };
    process.stdin.once('end', close);
    process.stdin.once('close', close);
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }
  await server.connect(new StdioServerTransport());
} catch { console.error('qa_mcp_start_failed'); process.exitCode = 1; }
