// `hive` CLI entry. On first run it asks ONE question — the node role
// (bee/queen/hive) — then generates config and starts. Everything else is
// configured in the web Settings panel. Pass a role explicitly to skip the
// prompt (handy for scripts and non-TTY shells).
//
// Subcommands:
//   hive                    → first run asks the role, then starts; later runs
//                             reuse the saved config
//   hive bee|queen|hive     → start in that role (skips the prompt on first run)
//   hive run [role]         → same as above (explicit form)
//   hive help               → usage

import { runWizard } from './wizard.js';
import { runNode } from './runner.js';
import { envFilePath } from './paths.js';

const ROLES = ['queen', 'bee', 'hive'];

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  switch (cmd) {
    case undefined:
    case 'start': {
      const cfg = await runWizard();          // first run prompts for role
      runNode(cfg);
      return;
    }
    case 'run': {
      const cfg = await runWizard(rest[0]);    // role arg skips the prompt
      runNode(cfg);
      return;
    }
    case 'bee':
    case 'queen':
    case 'hive': {
      const cfg = await runWizard(cmd);        // shorthand: `hive bee`
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
  hive                          First run asks the role, then starts
  hive bee | queen | hive       Start in that role (skips the prompt)
  hive run [queen|bee|hive]     Explicit form of the above
  hive help                     This message

Roles:
  bee     producer — extracts & signs knowledge, no LLM key needed
  queen   consumer — answers queries via an LLM, replicates bees
  hive    both in one process (default)

After it starts, open http://localhost:8080 → Settings to configure sources,
topic, and (for query nodes) the LLM provider. The node won't extract or answer
until you save there.

Config file: ${envFilePath()}

Docs:  https://github.com/capybarist/hive
MCP:   https://www.npmjs.com/package/@capybaralabs/hive-mcp
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
