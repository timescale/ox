let shutdownController: AbortController | null = null;

function ensureController(): AbortController {
  if (!shutdownController) {
    shutdownController = new AbortController();
  }
  return shutdownController;
}

export function getShutdownSignal(): AbortSignal {
  return ensureController().signal;
}

export function abortShutdown(reason?: unknown): void {
  ensureController().abort(reason);
}

export function resetShutdown(): AbortSignal {
  shutdownController = new AbortController();
  return shutdownController.signal;
}
