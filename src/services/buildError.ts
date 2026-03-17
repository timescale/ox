/**
 * Error thrown when a sandbox image build step fails.
 * Carries the accumulated build output lines so the TUI can display them.
 */
export class BuildError extends Error {
  readonly outputLines: string[];
  constructor(message: string, outputLines: string[]) {
    super(message);
    this.name = 'BuildError';
    this.outputLines = outputLines;
  }
}
