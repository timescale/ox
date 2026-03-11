#!/usr/bin/env bun

// ============================================================================
// Build Script - Compiles ox with build-time constants
//
// Wraps `bun build --compile` to inject build-time defines (e.g. the feedback
// webhook URL from CI secrets). Supports the same flags as the raw bun build
// command used previously.
//
// Usage:
//   ./bun run scripts/build.ts [--outfile=./bin/ox] [--target=...] [--minify] [--sourcemap]
// ============================================================================

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    outfile: { type: 'string', default: './bin/ox' },
    target: { type: 'string' },
    minify: { type: 'boolean', default: false },
    sourcemap: { type: 'boolean', default: false },
  },
  strict: false,
  allowPositionals: true,
});

const webhookUrl = process.env.OX_FEEDBACK_WEBHOOK_URL ?? '';

const args = [
  'build',
  './index.ts',
  '--compile',
  `--outfile=${values.outfile}`,
  '--define',
  `__OX_FEEDBACK_WEBHOOK_URL__='${webhookUrl}'`,
];

if (values.minify) args.push('--minify');
if (values.sourcemap) args.push('--sourcemap');
if (values.target) args.push(`--target=${values.target}`);

const proc = Bun.spawn(['./bun', ...args], {
  stdio: ['inherit', 'inherit', 'inherit'],
});
const exitCode = await proc.exited;
process.exit(exitCode);
