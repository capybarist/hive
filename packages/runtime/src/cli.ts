// `hive` CLI entry. There is no interactive wizard — configuration is done
// via the Settings panel in the web UI once the node is running.
//
// Subcommands:
//   hive            → bootstrap config if needed, then start
//   hive run [role] → start with optional role override (queen|bee|hive)
//   hive help       → usage

import { existsSync } from 'node:fs';
import { runWizard } from './wizard.js';
import { runNode } from './runner.js';
import { envFilePath } from './paths.js';

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  switch (cmd) {
    case undefined:
    case 'start': {
      const cfg = await runWizard();
      runNode(cfg);
      return;
    }
    case 'run': {
      const cfg = await runWizard();
      const role = rest[0] as 'queen' | 'bee' | 'hive' | undefined;
      if (role && ['queen', 'bee', 'hive'].includes(role)) cfg.role = role;
      runNode(cfg);
      return;
    }
    case '--help':
    case '-h':
    case 'help': {
      printHelp();
      return;
    }
    default: {
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
    }
  }
}

function printHelp(): void {
  console.log(`
HIVE — decentralized verifiable knowledge base for LLMs

Usage:
  hive                          Start the node (bootstrap config on first run)
  hive run [queen|bee|hive]     Start with a specific role override
  hive help                     This message

On first run, a default config is generated and the node starts.
Open http://localhost:8080 to configure sources, topic, and LLM provider
via the Settings panel in the web UI.

Config file: ${envFilePath()}

Docs:  https://github.com/capybarist/hive
MCP:   https://www.npmjs.com/package/@capybaralabs/hive-mcp
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
