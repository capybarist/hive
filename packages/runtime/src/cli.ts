// `hive` CLI entry. Subcommands:
//   hive               → first-run wizard if not configured, otherwise run saved config
//   hive run [role]    → arrange to run a specific role (queen | bee | hive)
//   hive init          → force the wizard, do not start the node
//   hive settings      → reserved for when the Settings UI ships (roadmap 3b)

import { existsSync } from 'node:fs';
import { runWizard } from './wizard.js';
import { runNode } from './runner.js';
import { envFilePath } from './paths.js';

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  switch (cmd) {
    case undefined: {
      const cfg = await runWizard();
      runNode(cfg);
      return;
    }
    case 'init': {
      await runWizard();
      console.log(`\n✓ Wizard complete. Start the node with: hive`);
      return;
    }
    case 'run': {
      if (!existsSync(envFilePath())) {
        console.error(`No config found at ${envFilePath()}.\nRun 'hive init' first, or 'hive' to auto-run the wizard.`);
        process.exit(1);
      }
      const role = (rest[0] as 'queen' | 'bee' | 'hive' | undefined);
      // Re-run wizard's load path; allow role override from CLI.
      const cfg = await runWizard();
      if (role) cfg.role = role;
      runNode(cfg);
      return;
    }
    case 'settings': {
      console.error('hive settings: not yet shipped. Tracked as roadmap step 3b (Settings UI).');
      process.exit(1);
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
  hive                          First-run wizard, then start the node
  hive run [queen|bee|hive]     Start the node (uses saved config)
  hive init                     Force the wizard, do not start
  hive settings                 (coming with roadmap 3b)
  hive help                     This message

Docs:  https://github.com/capybarist/hive
Cases: https://github.com/capybarist/hive/blob/main/docs/USE-CASES.md
MCP:   https://www.npmjs.com/package/@capybaralabs/hive-mcp
Skill: https://github.com/capybarist/hive/tree/main/skills/hive-research
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
