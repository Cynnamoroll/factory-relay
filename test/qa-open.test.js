import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { autoOpenWindowPane } from '../src/qa-pane.js';

test('only a window run in a Factory project opens a pane, once per launcher', () => {
  const calls = [], env = {}, launch = (...args) => { calls.push(args); return Object.assign(new EventEmitter(), { unref() {} }); };
  const open = autoOpenWindowPane('/private/agent.json', { env, launch });
  open({ windowId: 2 });
  Object.assign(env, { FACTORY_DESKTOP_CDP_PORT: '12345', AGENT_BROWSER_CDP: 'fixture' });
  open({ kind: 'desktop', displayId: 1 }); open(null);
  assert.equal(calls.length, 0);
  for (let windowId = 1; windowId <= 4; windowId++) open({ windowId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.match(calls[0][1][0], /scripts\/qa-open\.js$/);
  assert.deepEqual(calls[0][1].slice(1), ['/private/agent.json']);
});

test('QA launcher refuses unbound browser endpoints and profile overrides before spawning', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pane-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/qa-open.js', import.meta.url));
  const creds = path.join(root, 'agent.json'), log = path.join(root, 'calls');
  fs.writeFileSync(creds, JSON.stringify({ token: 'a'.repeat(64), origin: 'http://127.0.0.1:43180' }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'browser-code'), 'b'.repeat(64), { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'agent-browser'), '#!/bin/sh\nprintf "%s\\n" "$1 $2 $3" >> "$CALLS"\n', { mode: 0o700 });
  const endpoint = 'ws://127.0.0.1:12345/devtools/browser/test?session=fake';
  const invoke = overrides => spawnSync(process.execPath, [script, creds], { encoding: 'utf8',
    env: { PATH: root, HOME: root, CALLS: log, FACTORY_DESKTOP_CDP_PORT: '12345',
      AGENT_BROWSER_CDP: endpoint, AGENT_BROWSER_SESSION: 'fixture', ...overrides } });
  for (const unsafe of [{ AGENT_BROWSER_CDP: '' }, { FACTORY_DESKTOP_CDP_PORT: '' },
    { AGENT_BROWSER_CDP: '9222' }, { AGENT_BROWSER_CDP: 'ws://127.0.0.1:9222' },
    { AGENT_BROWSER_CDP: 'ws://example.test:12345' }, { AGENT_BROWSER_PROFILE: '/example/profile' }]) {
    assert.notEqual(invoke(unsafe).status, 0);
    assert.equal(fs.existsSync(log), false, 'Refusal must precede every browser command');
  }
  assert.equal(invoke({}).status, 0);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['open', 'eval', 'wait'].map(c => `--cdp ${endpoint} ${c}`));
});
