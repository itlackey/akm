import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === 'curate' && !args.includes('--belief')) args.splice(args.indexOf('--') < 0 ? args.length : args.indexOf('--'), 0, '--belief', 'all');
const r = spawnSync('bun', ['/home/founder3/.codex/worktrees/1199-curate-recall-controls/akm/src/cli.ts', ...args], {stdio: 'inherit',env:process.env});
process.exit(r.status ?? 1);
