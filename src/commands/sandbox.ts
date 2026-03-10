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
      .action(
        (options: {
          agent?: 'claude' | 'opencode' | 'codex';
          image?: boolean;
        }) => {
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
