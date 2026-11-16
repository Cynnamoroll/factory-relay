#!/usr/bin/env node
import { loadConfig, run } from './transport.js';
import { operations } from './schema.js';

const [configFile, operation, input = '{}', ...extra] = process.argv.slice(2);
if (!configFile || !operation || extra.length || configFile === '--help') {
  console.log('Usage: node src/cli.js CONFIG OPERATION [JSON]\nOperations: ' + Object.keys(operations).join(', '));
  process.exitCode = configFile === '--help' ? 0 : 2;
} else {
  try {
    if (input.length > 16384) throw new Error('invalid_arguments');
    let args;
    try { args = JSON.parse(input); } catch { throw new Error('invalid_arguments'); }
    console.log(JSON.stringify(await run(await loadConfig(configFile), operation, args)));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, ...(error.warnings?.length ? { warnings: error.warnings } : {}) }));
    process.exitCode = 1;
  }
}
