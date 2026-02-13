// Type augmentation for tty.WriteStream._refreshSize()
//
// This is an undocumented but stable Node.js/Bun API that forces a fresh
// ioctl(TIOCGWINSZ) syscall to update the cached .columns and .rows values.
// It emits a 'resize' event if the dimensions have changed.
//
// Normally .columns/.rows are only updated when the process receives SIGWINCH.
// While attached to a Docker subprocess, SIGWINCH goes to Docker (not us),
// so calling _refreshSize() is necessary to get accurate terminal dimensions
// after detaching.

declare module 'node:tty' {
  interface WriteStream {
    _refreshSize(): void;
  }
}
