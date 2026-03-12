import { $ } from 'bun';
import { log } from '../logger.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OX_DOMAIN = 'ox.local';
const DNSMASQ_CONF_LINE = `address=/.${OX_DOMAIN}/127.0.0.1`;
const RESOLVER_CONTENT = 'nameserver 127.0.0.1\n';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check whether DNS resolution for *.ox.local is working. */
async function verifyDns(): Promise<boolean> {
  try {
    const result = await $`dig +short test.${OX_DOMAIN} @127.0.0.1`
      .quiet()
      .nothrow();
    const output = result.stdout.toString().trim();
    return output === '127.0.0.1';
  } catch {
    return false;
  }
}

/** Check if a command exists on the system. */
async function commandExists(cmd: string): Promise<boolean> {
  const result = await $`which ${cmd}`.quiet().nothrow();
  return result.exitCode === 0;
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

async function setupMacOS(): Promise<void> {
  // Install dnsmasq if needed
  if (!(await commandExists('dnsmasq'))) {
    if (!(await commandExists('brew'))) {
      throw new Error(
        'dnsmasq is not installed and Homebrew is not available. ' +
          'Install dnsmasq manually: brew install dnsmasq',
      );
    }

    log.info('Installing dnsmasq via Homebrew');
    await $`brew install dnsmasq`.quiet();
  }

  // Determine brew prefix
  const prefixResult = await $`brew --prefix`.quiet();
  const brewPrefix = prefixResult.stdout.toString().trim();

  const dnsmasqDDir = `${brewPrefix}/etc/dnsmasq.d`;
  const dnsmasqConf = `${brewPrefix}/etc/dnsmasq.conf`;
  const oxConf = `${dnsmasqDDir}/ox.conf`;

  // Ensure dnsmasq.d directory
  await $`mkdir -p ${dnsmasqDDir}`.quiet();

  // Check if dnsmasq.conf includes the .d directory
  const confFile = Bun.file(dnsmasqConf);
  const includeLine = `conf-dir=${dnsmasqDDir}`;

  if (await confFile.exists()) {
    const content = await confFile.text();
    if (!content.includes(includeLine)) {
      log.info('Adding conf-dir include to dnsmasq.conf');
      await Bun.write(dnsmasqConf, `${content.trimEnd()}\n${includeLine}\n`);
    }
  } else {
    await Bun.write(dnsmasqConf, `${includeLine}\n`);
  }

  // Write ox.conf
  await Bun.write(oxConf, `${DNSMASQ_CONF_LINE}\n`);
  log.info({ path: oxConf }, 'Wrote dnsmasq ox.local config');

  // Set up macOS resolver
  await $`sudo mkdir -p /etc/resolver`.nothrow();
  await $`echo ${RESOLVER_CONTENT} | sudo tee /etc/resolver/${OX_DOMAIN}`.quiet();
  log.info('Wrote /etc/resolver/ox.local');

  // Restart dnsmasq
  await $`sudo brew services restart dnsmasq`.quiet();
  log.info('Restarted dnsmasq');
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

async function setupLinux(): Promise<void> {
  if (!(await commandExists('dnsmasq'))) {
    throw new Error(
      'dnsmasq is not installed. Please install it:\n' +
        '  Ubuntu/Debian: sudo apt install dnsmasq\n' +
        '  Fedora/RHEL:   sudo dnf install dnsmasq',
    );
  }

  // Write ox.conf via sudo tee
  await $`echo ${DNSMASQ_CONF_LINE} | sudo tee /etc/dnsmasq.d/ox.conf`.quiet();
  log.info('Wrote /etc/dnsmasq.d/ox.conf');

  // Restart dnsmasq
  await $`sudo systemctl restart dnsmasq`.quiet();
  log.info('Restarted dnsmasq');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure dnsmasq is configured so *.ox.local resolves to 127.0.0.1.
 *
 * On macOS: auto-installs via Homebrew, configures /etc/resolver.
 * On Linux: expects dnsmasq already installed, writes /etc/dnsmasq.d/ox.conf.
 */
export async function ensureDns(): Promise<void> {
  const platform = process.platform;

  // Quick check: is it already working?
  const alreadyConfigured = await isAlreadyConfigured(platform);
  if (alreadyConfigured) {
    if (await verifyDns()) {
      log.debug('DNS for *.ox.local already working');
      return;
    }
    log.info('DNS config files exist but resolution failed — reconfiguring');
  }

  // Platform-specific setup
  if (platform === 'darwin') {
    await setupMacOS();
  } else if (platform === 'linux') {
    await setupLinux();
  } else {
    log.warn(
      { platform },
      'Automatic DNS setup not supported on this platform. ' +
        `Configure your DNS to resolve *.${OX_DOMAIN} to 127.0.0.1`,
    );
    return;
  }

  // Verify after setup
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (await verifyDns()) {
    log.info('DNS for *.ox.local verified successfully');
  } else {
    log.warn(
      'DNS verification failed after setup. ' +
        'You may need to flush your DNS cache or wait a moment.',
    );
  }
}

/**
 * Check whether config files already exist (doesn't mean resolution works).
 */
async function isAlreadyConfigured(
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (platform === 'darwin') {
    return Bun.file(`/etc/resolver/${OX_DOMAIN}`).exists();
  }
  if (platform === 'linux') {
    return Bun.file('/etc/dnsmasq.d/ox.conf').exists();
  }
  return false;
}
