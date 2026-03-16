import { Command, Option } from 'commander';
// Import the embedded base Dockerfile to compute its hash
import BASE_DOCKERFILE from '../../sandbox/base.Dockerfile' with {
  type: 'text',
};
import {
  computeDockerfileHash,
  getAgentVersion,
  getGhcrAgentTag,
  getGhcrBaseTag,
} from '../services/docker';
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
          const { readConfig } = await import('../services/config.ts');
          const config = await readConfig();

          // Resolve the project setup hash if configured
          let dockerSetupHash: string | undefined;
          let cloudSetupHash: string | undefined;
          if (config.projectSetupLayer) {
            const { computeProjectSetupHash } = await import(
              '../services/docker.ts'
            );
            const { computeCloudBaseHash } = await import(
              '../services/sandbox/cloudBaseSteps.ts'
            );
            const dockerBaseHash = computeDockerfileHash(BASE_DOCKERFILE);
            dockerSetupHash = computeProjectSetupHash(
              dockerBaseHash,
              config.projectSetupLayer,
            );
            const cloudBaseHash = computeCloudBaseHash();
            cloudSetupHash = computeProjectSetupHash(
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
                  computeCloudBaseHash(),
                  config.projectSetupLayer,
                ),
              );
            } else {
              const hash = computeDockerfileHash(BASE_DOCKERFILE);
              if (options.image) {
                console.log(`ox-sandbox:md5-${hash}-l-${dockerSetupHash}`);
              } else {
                console.log(dockerSetupHash);
              }
            }
            return;
          }

          // Cloud snapshot slugs
          if (options.cloud) {
            if (options.agent) {
              // When projectSetupLayer is configured, the agent slug
              // incorporates the setup hash (matching what's actually built)
              console.log(getAgentSnapshotSlug(options.agent, cloudSetupHash));
            } else {
              console.log(getBaseSnapshotSlug());
            }
            return;
          }

          // Docker image tags
          const hash = computeDockerfileHash(BASE_DOCKERFILE);

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
              const version = getAgentVersion(options.agent);
              // When projectSetupLayer is configured, the agent overlay is
              // built on top of the setup layer, so include it in the tag
              const base = dockerSetupHash
                ? `${hash}-l-${dockerSetupHash}`
                : hash;
              console.log(`${base}-${options.agent}-${version}`);
            } else {
              console.log(hash);
            }
          }
        },
      ),
  );
