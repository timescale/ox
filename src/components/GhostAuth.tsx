import { checkGhostCredentials } from '../services/ghost.ts';
import { startContainerGhostAuth } from '../services/ghostAuth.ts';
import { log } from '../services/logger.ts';
import { createTui } from '../services/tui';
import { CopyOnSelect } from './CopyOnSelect.tsx';
import { GhAuth } from './GhAuth.tsx';

export const runGhostAuthScreen = async (): Promise<boolean> => {
  const authProcess = await startContainerGhostAuth();
  if (!authProcess) {
    log.error('Failed to start Ghost auth process');
    return false;
  }

  const { render, destroy } = await createTui();

  render(
    <CopyOnSelect>
      <GhAuth
        code={authProcess.code}
        url={authProcess.url}
        onCancel={() => {
          authProcess.cancel();
        }}
      />
    </CopyOnSelect>,
  );

  const result = await authProcess.waitForCompletion();

  await destroy();

  return result;
};

export const ensureGhostAuth = async (): Promise<void> => {
  if (await checkGhostCredentials()) {
    return;
  }

  log.warn('Ghost credentials are missing or expired.');

  if (!(await runGhostAuthScreen())) {
    throw new Error('Ghost authentication failed or was cancelled');
  }
};
