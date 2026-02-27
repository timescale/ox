#!/usr/bin/env node

// This script is the entry point for the @ox.build/cli npm package.
// It resolves and spawns the correct platform-specific binary from
// the @ox.build/cli-{os}-{arch} optional dependency packages.

const { platform, arch, env, argv } = process;
const { spawnSync } = require('node:child_process');

const PLATFORMS = {
  darwin: {
    arm64: '@ox.build/cli-darwin-arm64/bin/ox',
  },
  linux: {
    x64: '@ox.build/cli-linux-x64/bin/ox',
    arm64: '@ox.build/cli-linux-arm64/bin/ox',
  },
};

const binPath = env.OX_BINARY || PLATFORMS[platform]?.[arch];

if (!binPath) {
  console.error(
    `ox does not ship prebuilt binaries for your platform (${platform}-${arch}).`,
  );
  console.error(
    'You can install from source instead: https://github.com/timescale/ox',
  );
  process.exitCode = 1;
} else {
  let resolvedPath;
  try {
    resolvedPath = env.OX_BINARY || require.resolve(binPath);
  } catch {
    console.error(
      `Could not find the ox binary for your platform (${platform}-${arch}).`,
    );
    console.error(
      'The platform-specific package may not have been installed correctly.',
    );
    console.error('Try reinstalling: npm install -g @ox.build/cli');
    process.exitCode = 1;
  }

  if (resolvedPath) {
    const result = spawnSync(resolvedPath, argv.slice(2), {
      shell: false,
      stdio: 'inherit',
    });

    if (result.error) {
      throw result.error;
    }

    process.exitCode = result.status;
  }
}
