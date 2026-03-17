#!/usr/bin/env bun

import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getSession, startContainer } from '../../src/services/docker.ts';
import { getRepoInfo } from '../../src/services/git.ts';
import { log } from '../../src/services/logger.ts';
import {
  type AgentType,
  getSandboxProvider,
  type OxSession,
} from '../../src/services/sandbox/index.ts';

const provider = getSandboxProvider('docker');
const repoRoot = resolve(import.meta.dir, '../..');

const SESSIONS = [
  {
    name: 'demo-claude-auth',
    branchName: 'demo-claude-auth',
    agent: 'claude',
    model: 'sonnet',
    prompt: 'Refactor the auth middleware into smaller composable steps',
    title: 'Claude Code',
    statusLines: [
      'Scanning auth entry points and middleware boundaries',
      'Reviewing request context propagation across handlers',
      'Preparing a smaller chain of reusable auth helpers',
    ],
  },
  {
    name: 'demo-opencode-tests',
    branchName: 'demo-opencode-tests',
    agent: 'opencode',
    model: 'anthropic/claude-sonnet-4-5',
    prompt: 'Add integration coverage for the dashboard loading states',
    title: 'OpenCode',
    statusLines: [
      'Mapping dashboard fixtures to integration coverage',
      'Adding cases for empty, loading, and error transitions',
      'Verifying assertions around skeleton and retry states',
    ],
  },
  {
    name: 'demo-codex-validation',
    branchName: 'demo-codex-validation',
    agent: 'codex',
    model: 'gpt-5.4',
    prompt: 'Tighten signup validation and preserve inline form errors',
    title: 'Codex',
    statusLines: [
      'Tracing signup validation from schema to submit handler',
      'Checking edge cases for password and email normalization',
      'Preparing updates to preserve inline form error rendering',
    ],
  },
] as const satisfies readonly DemoSessionDefinition[];

interface DemoSessionDefinition {
  name: string;
  branchName: string;
  agent: AgentType;
  model: string;
  prompt: string;
  title: string;
  statusLines: readonly string[];
}

async function cleanup(): Promise<void> {
  const sessions = await provider.list();
  const demoSessions = sessions.filter((session) =>
    SESSIONS.some((demo) => demo.name === session.name),
  );

  await Promise.all(
    demoSessions.map(async (session) => {
      try {
        await provider.remove(session.id);
      } catch (error) {
        log.debug({ error, session: session.name }, 'Failed to remove session');
      }
    }),
  );

  await rm(resolve(repoRoot, '.ox', 'overlayMounts'), {
    recursive: true,
    force: true,
  }).catch(() => {});
}

function buildInitScript(session: DemoSessionDefinition): string {
  const promptJson = JSON.stringify(session.prompt);
  const titleJson = JSON.stringify(session.title);
  const branchJson = JSON.stringify(session.branchName);
  const agentJson = JSON.stringify(session.agent);
  const lineBlock = session.statusLines
    .map((line) => JSON.stringify(line))
    .join(' ');

  return `
mkdir -p /tmp/ox-demo-bin
cat > /tmp/ox-demo-bin/${session.agent} <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
prompt=${promptJson}
title=${titleJson}
branch=${branchJson}
agent=${agentJson}
status_lines=(${lineBlock})
if [ "$#" -gt 0 ]; then
  last_arg="\${!#}"
  if [ -n "$last_arg" ] && [ "$last_arg" != "--dangerously-skip-permissions" ] && [ "$last_arg" != "--dangerously-bypass-approvals-and-sandbox" ]; then
    prompt="$last_arg"
  fi
fi
frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
i=0
while true; do
  frame="\${frames[$((i % \${#frames[@]}))]}"
  printf '\\033[2J\\033[H'
  printf 'ox interactive session attached to %s\\n\\n' "$branch"
  printf '%s  %s\\n' "$frame" "$title"
  printf 'Agent:  %s\\n' "$agent"
  printf 'Mode:   interactive\\n'
  printf 'Branch: %s\\n' "$branch"
  printf 'Prompt: %s\\n\\n' "$prompt"
  printf 'Live activity\\n'
  for line in "\${status_lines[@]}"; do
    printf '  - %s\\n' "$line"
  done
  printf '\\nDetach with ctrl+\\\\ and reattach with ox session attach %s\\n' "$branch"
  sleep 0.8
  i=$((i + 1))
done
EOF
chmod +x /tmp/ox-demo-bin/${session.agent}
export PATH="/tmp/ox-demo-bin:$PATH"
`;
}

async function createSessions(): Promise<OxSession[]> {
  await provider.ensureReady();
  const repoInfo = await getRepoInfo();

  const created: OxSession[] = [];
  for (const session of SESSIONS) {
    const dockerImage = await provider.ensureImage({ agent: session.agent });
    const containerName = await startContainer({
      branchName: session.branchName,
      prompt: session.prompt,
      repoInfo,
      agent: session.agent,
      model: session.model,
      interactive: true,
      mountDir: repoRoot,
      isGitRepo: false,
      agentMode: 'interactive',
      initScript: buildInitScript(session),
      dockerImage,
    });
    const createdSession = await getSession(containerName);
    if (!createdSession) {
      throw new Error(`Failed to load created session: ${session.name}`);
    }
    created.push(createdSession);
  }

  return created;
}

if (process.argv.includes('--cleanup')) {
  await cleanup();
  process.exit(0);
}

await cleanup();
const sessions = await createSessions();
console.log(`Seeded ${sessions.length} interactive demo sessions.`);
process.exit(0);
