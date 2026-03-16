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
      .option('-s, --setup', 'include project setup layer hash')
      .action(
        async (options: {
          agent?: 'claude' | 'opencode' | 'codex';
          image?: boolean;
          cloud?: boolean;
          setup?: boolean;
        }) => {
          // Project setup layer hash
          if (options.setup) {
            const { readConfig } = await import('../services/config.ts');
            const config = await readConfig();
            if (!config.projectSetupLayer) {
              console.error('No projectSetupLayer configured');
              process.exit(1);
            }

            if (options.cloud) {
              const { computeCloudBaseHash } = await import(
                '../services/sandbox/cloudBaseSteps.ts'
              );
              const { getProjectSetupSnapshotSlug } = await import(
                '../services/sandbox/cloudSnapshot.ts'
              );
              const baseHash = computeCloudBaseHash();
              console.log(
                getProjectSetupSnapshotSlug(baseHash, config.projectSetupLayer),
              );
            } else {
              const hash = computeDockerfileHash(BASE_DOCKERFILE);
              const { computeProjectSetupHash } = await import(
                '../services/docker.ts'
              );
              const setupHash = computeProjectSetupHash(
                hash,
                config.projectSetupLayer,
              );
              if (options.image) {
                console.log(`ox-sandbox:md5-${hash}-l-${setupHash}`);
              } else {
                console.log(setupHash);
              }
            }
            return;
          }

          // Cloud snapshot slugs
          if (options.cloud) {
            if (options.agent) {
              console.log(getAgentSnapshotSlug(options.agent));
            } else {
              console.log(getBaseSnapshotSlug());
            }
            return;
          }

          // Docker image tags (existing behavior)
          const hash = computeDockerfileHash(BASE_DOCKERFILE);

          if (options.image) {
            if (options.agent) {
              console.log(getGhcrAgentTag(options.agent));
            } else {
              console.log(getGhcrBaseTag());
            }
          } else {
            if (options.agent) {
              const version = getAgentVersion(options.agent);
              console.log(`${hash}-${options.agent}-${version}`);
            } else {
              console.log(hash);
            }
          }
        },
      ),
  );
