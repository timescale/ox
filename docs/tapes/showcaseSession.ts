#!/usr/bin/env bun

interface ShowcaseSession {
  agent: string;
  session: string;
  branch: string;
  prompt: string;
  activity: string[];
}

const SESSIONS: Record<string, ShowcaseSession> = {
  'demo-claude-auth': {
    agent: 'Claude Code',
    session: 'demo-claude-auth',
    branch: 'refactor-auth-middleware',
    prompt: 'Refactor the auth middleware into smaller composable steps',
    activity: [
      'Scanning auth entry points and middleware boundaries',
      'Comparing request context usage across handlers',
      'Sketching smaller middleware helpers before edits',
    ],
  },
  'demo-opencode-tests': {
    agent: 'OpenCode',
    session: 'demo-opencode-tests',
    branch: 'add-dashboard-test-coverage',
    prompt: 'Add integration coverage for the dashboard loading states',
    activity: [
      'Reviewing existing dashboard fixtures and route mocks',
      'Drafting failing integration cases for empty and error states',
      'Preparing assertions around loading skeleton transitions',
    ],
  },
  'demo-codex-validation': {
    agent: 'Codex',
    session: 'demo-codex-validation',
    branch: 'tighten-signup-validation',
    prompt: 'Tighten signup validation and preserve inline form errors',
    activity: [
      'Tracing validation flow from form schema to submit handler',
      'Checking edge cases for password and email normalization',
      'Planning targeted updates to the form error rendering',
    ],
  },
};

const sessionName = process.argv[2];
const session = sessionName ? SESSIONS[sessionName] : undefined;

if (!session) {
  console.error(`Unknown showcase session: ${sessionName ?? '<missing>'}`);
  process.exit(1);
}

const spinnerFrames = ['|', '/', '-', '\\'];

function pad(value: string, width: number): string {
  return value.length >= width
    ? value.slice(0, width)
    : value.padEnd(width, ' ');
}

function border(width: number): string {
  return `+${'-'.repeat(width - 2)}+`;
}

function row(value = '', width = 94): string {
  return `| ${pad(value, width - 4)} |`;
}

function render(frame: number) {
  const spinner = spinnerFrames[frame % spinnerFrames.length];
  const width = 94;
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(`${border(width)}\n`);
  process.stdout.write(
    `${row(` ox interactive session  ${spinner}  attached to ${session.session}`, width)}\n`,
  );
  process.stdout.write(`${border(width)}\n`);
  process.stdout.write(`${row(`Agent   : ${session.agent}`, width)}\n`);
  process.stdout.write(`${row(`Branch  : ${session.branch}`, width)}\n`);
  process.stdout.write(`${row('Mode    : interactive', width)}\n`);
  process.stdout.write(`${row(`Prompt  : ${session.prompt}`, width)}\n`);
  process.stdout.write(`${row('', width)}\n`);
  process.stdout.write(`${row('Live activity', width)}\n`);
  for (const line of session.activity) {
    process.stdout.write(`${row(`  - ${line}`, width)}\n`);
  }
  process.stdout.write(`${row('', width)}\n`);
  process.stdout.write(
    `${row('Detach with ctrl+\\ and reattach later with ox session attach <session>', width)}\n`,
  );
  process.stdout.write(`${border(width)}\n`);
}

render(0);
const interval = setInterval(() => render(Date.now()), 700);

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on('data', (chunk: Buffer) => {
  if (chunk.includes(0x1c) || chunk.includes(0x03) || chunk.includes(0x71)) {
    clearInterval(interval);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdout.write('\x1b[2J\x1b[H');
    process.exit(0);
  }
});
