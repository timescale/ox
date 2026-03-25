import { Command, Option } from 'commander';
import type { AgentType } from '../services/config.ts';
import { getGhcrAgentTag, getGhcrBaseTag } from '../services/docker';
import {
  getAgentSnapshotSlug,
  getBaseSnapshotSlug,
} from '../services/sandbox/cloudSnapshot';

export const sandboxCommand = new Command('sandbox')
  .description('sandbox image utilities')
  .addCommand(
    new Command('hash')
      .description('print the content hash used for sandbox image tags')
      .addOption(
        new Option(
          '-a, --agent <name>',
          'include agent name and version in the tag',
        ).choices(['claude', 'opencode', 'codex']),
      )
      .option('-i, --image', 'print the full GHCR image reference')
      .option('-c, --cloud', 'print cloud snapshot slug instead of Docker tag')
      .option(
        '-p, --project',
        'show the project setup layer hash (requires projectSetupLayer config)',
      )
      .action(
        async (options: {
          agent?: 'claude' | 'opencode' | 'codex';
          image?: boolean;
          cloud?: boolean;
          project?: boolean;
        }) => {
          // Validate flag combinations
          if (options.project && options.agent) {
            console.error(
              'Error: --project and --agent cannot be used together.\n' +
                'Use --project to show the project setup layer hash, or --agent to show the agent overlay tag.',
            );
            process.exit(1);
          }
          if (options.project && options.image) {
            console.error(
              'Error: --project and --image cannot be used together.\n' +
                'Project setup layers are built locally and not published to GHCR.',
            );
            process.exit(1);
          }
          if (options.image && options.cloud) {
            console.error(
              'Error: --image and --cloud cannot be used together.\n' +
                'Use --image for GHCR Docker image references, or --cloud for Deno Cloud snapshot slugs.',
            );
            process.exit(1);
          }

          const { readConfig } = await import('../services/config.ts');
          const config = await readConfig();

          // Resolve the actual base image (respects buildSandboxFromDockerfile / sandboxBaseImage)
          const {
            resolveSandboxImage,
            getDockerSandboxSetupTag,
            getProjectSetupTag: getSetupTag,
            getAgentOverlayTag: getOverlayTag,
          } = await import('../services/docker.ts');
          const resolved = await resolveSandboxImage(config);
          const resolvedBase = resolved.image;
          const effectiveDockerBase = config.dockerInSandbox
            ? getDockerSandboxSetupTag(resolvedBase)
            : resolvedBase;

          // Resolve the project setup hash if configured
          let dockerSetupTag: string | undefined;
          let cloudSetupHash: string | undefined;
          if (config.projectSetupLayer) {
            const { computeProjectSetupHash: computeSetupHash } = await import(
              '../services/docker.ts'
            );
            dockerSetupTag = getSetupTag(
              effectiveDockerBase,
              config.projectSetupLayer,
            );

            const { computeCloudBaseHash } = await import(
              '../services/sandbox/cloudBaseSteps.ts'
            );
            const cloudBaseHash = computeCloudBaseHash(config);
            cloudSetupHash = computeSetupHash(
              cloudBaseHash,
              config.projectSetupLayer,
            );
          }

          // --project: show the project setup layer hash/slug
          if (options.project) {
            if (!config.projectSetupLayer) {
              console.error('No projectSetupLayer configured');
              process.exit(1);
            }

            if (options.cloud) {
              const { getProjectSetupSnapshotSlug } = await import(
                '../services/sandbox/cloudSnapshot.ts'
              );
              const { computeCloudBaseHash } = await import(
                '../services/sandbox/cloudBaseSteps.ts'
              );
              console.log(
                getProjectSetupSnapshotSlug(
                  computeCloudBaseHash(config),
                  config.projectSetupLayer,
                ),
              );
            } else {
              // --image is rejected above, so this is always the full Docker tag
              console.log(dockerSetupTag);
            }
            return;
          }

          // Cloud snapshot slugs
          if (options.cloud) {
            if (options.agent) {
              // When projectSetupLayer is configured, the agent slug
              // incorporates the setup hash (matching what's actually built)
              console.log(
                getAgentSnapshotSlug(options.agent, cloudSetupHash, config),
              );
            } else {
              console.log(getBaseSnapshotSlug(config));
            }
            return;
          }

          // Docker image tags
          if (options.image) {
            if (options.agent) {
              // GHCR tags don't include setup layer (it's project-specific,
              // not published). Show the GHCR base agent tag.
              console.log(getGhcrAgentTag(options.agent));
            } else {
              console.log(getGhcrBaseTag());
            }
          } else {
            if (options.agent) {
              const effectiveBase = dockerSetupTag ?? effectiveDockerBase;
              const tag = getOverlayTag(effectiveBase, options.agent);
              console.log(tag);
            } else {
              console.log(resolvedBase);
            }
          }
        },
      ),
  )
  .addCommand(
    new Command('build')
      .description(
        'build sandbox image layers (and all parent layers if needed)',
      )
      .addOption(
        new Option(
          '-a, --agent <name>',
          'build up through the agent overlay layer',
        ).choices(['claude', 'opencode', 'codex']),
      )
      .option('-c, --cloud', 'build cloud snapshots instead of Docker images')
      .option(
        '-p, --project',
        'build up through the project setup layer (requires projectSetupLayer config)',
      )
      .option('--no-cache', 'force rebuild, ignoring existing cached layers')
      .action(
        async (options: {
          agent?: 'claude' | 'opencode' | 'codex';
          cloud?: boolean;
          project?: boolean;
          cache?: boolean; // commander inverts --no-cache to cache=false
        }) => {
          // Validate flag combinations
          if (options.project && options.agent) {
            console.error(
              'Error: --project and --agent cannot be used together.\n' +
                'Use --agent to build through all layers (including project setup if configured).',
            );
            process.exit(1);
          }

          const force = options.cache === false;

          const { readConfig } = await import('../services/config.ts');
          const config = await readConfig();

          if (options.project && !config.projectSetupLayer) {
            console.error('Error: no projectSetupLayer configured');
            process.exit(1);
          }

          // Helper: run a build step with progress, print result to stderr,
          // return the image/slug produced.
          const { printErr } = await import('../utils/shell.ts');

          const runStep = async <T extends string>(
            label: string,
            fn: (
              onProgress: (p: { type: string; message?: string }) => void,
            ) => Promise<T>,
          ): Promise<T> => {
            process.stderr.write(`${label}: `);
            let needsNewline = true;
            const onProgress = (p: { type: string; message?: string }) => {
              switch (p.type) {
                case 'checking':
                  process.stderr.write('checking... ');
                  break;
                case 'exists':
                  process.stderr.write('exists\n');
                  needsNewline = false;
                  break;
                case 'pulling':
                case 'pulling-cache':
                case 'building':
                case 'creating-volume':
                case 'booting-sandbox':
                case 'installing':
                case 'snapshotting':
                case 'cleaning-up':
                  process.stderr.write(`${p.message ?? p.type}\n`);
                  needsNewline = false;
                  break;
                case 'done':
                  // 'done' only prints if nothing else did
                  if (needsNewline) {
                    process.stderr.write('done\n');
                    needsNewline = false;
                  }
                  break;
              }
            };
            const result = await fn(onProgress);
            // Ensure the line is terminated — some ensure functions
            // return early (cache hit) without emitting any progress.
            if (needsNewline) {
              process.stderr.write('exists\n');
            }
            return result;
          };

          let finalImage: string;

          try {
            if (options.cloud) {
              // --- Cloud build path ---
              const { getDenoToken } = await import('../services/deno.ts');
              const token = await getDenoToken();
              if (!token) {
                console.error(
                  'Error: no Deno Deploy token configured. Run cloud setup first.',
                );
                process.exit(1);
              }

              const region = config.cloudRegion ?? 'ord';
              const {
                ensureCloudSnapshot,
                ensureDbProviderCloudSnapshot,
                ensureProjectSetupCloudSnapshot,
                ensureAgentCloudSnapshot,
              } = await import('../services/sandbox/cloudSnapshot.ts');

              // 1. Build base
              const baseSlug = await runStep('Base snapshot', (onProgress) =>
                ensureCloudSnapshot({
                  token,
                  region,
                  config,
                  force,
                  onProgress,
                }),
              );

              // 2. Build project setup layer (if needed)
              let effectiveBaseSlug = baseSlug;
              let parentHash: string | undefined;
              const cloudSetupScript = config.projectSetupLayer;
              if (cloudSetupScript && (options.project || options.agent)) {
                effectiveBaseSlug = await runStep(
                  'Project setup snapshot',
                  (onProgress) =>
                    ensureProjectSetupCloudSnapshot({
                      token,
                      region,
                      baseSnapshotSlug: baseSlug,
                      script: cloudSetupScript,
                      force,
                      stream: true,
                      onProgress,
                    }),
                );
                parentHash = effectiveBaseSlug.replace('oxl-', '');
              }

              if (
                (options.project || options.agent) &&
                (config.dbServiceProvider === 'tiger' ||
                  config.dbServiceProvider === 'ghost')
              ) {
                const provider = config.dbServiceProvider;
                effectiveBaseSlug = await runStep(
                  `DB provider (${provider}) snapshot`,
                  (onProgress) =>
                    ensureDbProviderCloudSnapshot({
                      token,
                      region,
                      provider,
                      baseSnapshotSlug: effectiveBaseSlug,
                      parentHash,
                      config,
                      force,
                      onProgress,
                    }),
                );
                parentHash = effectiveBaseSlug.replace('oxd-', '');
              }

              // 3. Build agent overlay (if requested)
              finalImage = effectiveBaseSlug;
              if (options.agent) {
                finalImage = await runStep(
                  `Agent (${options.agent}) snapshot`,
                  (onProgress) =>
                    ensureAgentCloudSnapshot({
                      token,
                      region,
                      agent: options.agent as AgentType,
                      baseSnapshotSlug: effectiveBaseSlug,
                      parentHash,
                      config,
                      force,
                      onProgress,
                    }),
                );
              }
            } else {
              // --- Docker build path ---
              const {
                ensureDockerImage,
                ensureDbProviderLayer,
                ensureDockerSandboxSetupLayer,
                ensureProjectSetupLayer,
                ensureAgentOverlay,
              } = await import('../services/docker.ts');

              // 1. Build base
              const baseImage = await runStep('Base image', (onProgress) =>
                ensureDockerImage({ onProgress, force }),
              );

              // 2. Build project setup layer (if needed)
              let effectiveBase = baseImage;
              if (
                config.dockerInSandbox &&
                (options.project || options.agent)
              ) {
                effectiveBase = await runStep(
                  'Docker in sandbox layer',
                  (onProgress) =>
                    ensureDockerSandboxSetupLayer(effectiveBase, {
                      onProgress,
                      force,
                      stream: true,
                    }),
                );
              }

              const dockerSetupScript = config.projectSetupLayer;
              if (dockerSetupScript && (options.project || options.agent)) {
                effectiveBase = await runStep(
                  'Project setup layer',
                  (onProgress) =>
                    ensureProjectSetupLayer(effectiveBase, dockerSetupScript, {
                      onProgress,
                      force,
                      stream: true,
                    }),
                );
              }

              if (
                (options.project || options.agent) &&
                (config.dbServiceProvider === 'tiger' ||
                  config.dbServiceProvider === 'ghost')
              ) {
                const provider = config.dbServiceProvider;
                effectiveBase = await runStep(
                  `DB provider (${provider}) layer`,
                  (onProgress) =>
                    ensureDbProviderLayer(effectiveBase, provider, {
                      onProgress,
                      force,
                    }),
                );
              }

              // 3. Build agent overlay (if requested)
              finalImage = effectiveBase;
              if (options.agent) {
                finalImage = await runStep(
                  `Agent (${options.agent}) overlay`,
                  (onProgress) =>
                    ensureAgentOverlay(
                      effectiveBase,
                      options.agent as AgentType,
                      {
                        onProgress,
                        force,
                      },
                    ),
                );
              }
            }

            // Print the final image name to stdout
            console.log(finalImage);
          } catch (err) {
            // Ensure we're on a new line after any partial progress output
            printErr('');
            const message = err instanceof Error ? err.message : String(err);
            printErr(`Error: ${message}`);
            process.exit(1);
          }
        },
      ),
  );
