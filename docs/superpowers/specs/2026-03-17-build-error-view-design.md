# Build Error View Design

**Date:** 2026-03-17
**Status:** Approved

## Problem

When `projectSetupLayer` (or any image build step) fails in the TUI, the user sees a transient 3-second toast with a generic message like "Failed to build project setup layer (exit code 1)" and is bounced back to the prompt screen. The detailed build output (apt-get errors, script failures, etc.) was streamed in real-time during the build but is discarded — it is not accumulated and not available for the error. The Docker container is force-removed before the error propagates, so `docker logs` cannot be called after the fact.

The user has no way to see what actually went wrong.

## Solution

### 1. `BuildError` class

A custom error class that carries both the summary message and accumulated build output lines:

```typescript
// src/services/buildError.ts
export class BuildError extends Error {
  readonly outputLines: string[];
  constructor(message: string, outputLines: string[]) {
    super(message);
    this.name = 'BuildError';
    this.outputLines = outputLines;
  }
}
```

Thrown by `ensureProjectSetupLayer` (Docker) and `ensureProjectSetupCloudSnapshot` (Cloud). Can be adopted by agent overlay builds later.

### 2. Output accumulation

**Docker** (`ensureProjectSetupLayer` in `docker.ts`): As lines are streamed from the docker exec process via `processStream`, also push each line into a local `outputLines: string[]` array. On failure, throw `new BuildError(message, outputLines)`.

**Cloud** (`ensureProjectSetupCloudSnapshot` in `cloudSnapshot.ts`): Same pattern — accumulate lines from the `onLine` callback into a local array, throw `BuildError` on failure.

### 3. Router view type

New variant in `SessionsView` union (`routerStore.ts`):

```typescript
| { type: 'build-error'; title: string; message: string; outputLines: string[] }
```

New action: `goToBuildError(title: string, message: string, outputLines: string[])`.

### 4. Error routing

In `sessionWorkflowStore` catch blocks (`startSession`, `startShellSession`): if the caught error is a `BuildError`, navigate to the `build-error` view instead of showing a toast and returning to prompt.

In `readinessStore` (`prebuildAgentImage`): when the prebuild fails with a `BuildError`, store the output lines alongside the error so the prompt-screen readiness status can offer to show details.

### 5. `BuildErrorScreen` component

Full-screen component rendered when `view.type === 'build-error'`:

- **Header**: Red title (e.g., "Build Failed") + error summary message
- **Body**: `<scrollbox>` with `stickyStart="bottom"` showing all output lines via `<AnsiText>` (same pattern as `LogViewer`)
- **Footer**: Hint: "Press Escape to go back"
- **Keyboard**: Escape → `goToPrompt()`, j/k/g/G for scroll

### 6. Prebuild error details on prompt screen

When `ReadinessStatus` shows a build error and output lines are available, show a hint ("Press Enter to view build output"). On Enter, navigate to the `build-error` view with the stored lines.

## Files affected

| File | Change |
|------|--------|
| `src/services/buildError.ts` | New file: `BuildError` class |
| `src/services/docker.ts` | Accumulate lines in `ensureProjectSetupLayer`, throw `BuildError` |
| `src/services/sandbox/cloudSnapshot.ts` | Accumulate lines in `ensureProjectSetupCloudSnapshot`, throw `BuildError` |
| `src/stores/routerStore.ts` | Add `build-error` view type, `goToBuildError` action |
| `src/stores/sessionWorkflowStore.ts` | Route `BuildError` to `build-error` view |
| `src/stores/readinessStore.ts` | Store output lines from `BuildError` on prebuild failure |
| `src/components/BuildErrorScreen.tsx` | New component: scrollable error + output display |
| `src/components/ReadinessStatus.tsx` | Hint + Enter handler to view prebuild error details |
| `src/commands/sessions.tsx` | Route `build-error` view to `BuildErrorScreen` |
