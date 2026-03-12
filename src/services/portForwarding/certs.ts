import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { userConfigDir } from '../config.ts';
import { log } from '../logger.ts';
import { CADDY_CONTAINER } from './caddy.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path inside the Caddy container where the root CA cert is generated */
const CONTAINER_CERT_PATH = '/data/caddy/pki/authorities/local/root.crt';

/** Marker file that records whether we've trusted the cert */
const certMarkerPath = () => join(userConfigDir(), '.caddy-cert-trusted');

/** Local path where we copy the cert from the container */
const localCertPath = () => join(userConfigDir(), 'caddy-root-ca.crt');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the Caddy-generated internal root CA certificate is trusted by the OS.
 *
 * Steps:
 * 1. Check marker file — skip if already trusted.
 * 2. Trigger a TLS handshake so Caddy generates the internal CA.
 * 3. Poll for the cert to appear inside the container.
 * 4. Copy it to the host.
 * 5. Trust it via platform-specific commands (requires sudo).
 * 6. Write a marker file so we don't repeat on next run.
 */
export async function ensureCertTrusted(): Promise<void> {
  // 1. Check marker
  if (await Bun.file(certMarkerPath()).exists()) {
    log.debug('Caddy root CA already trusted (marker exists)');
    return;
  }

  // 2. Trigger TLS handshake to generate the cert
  log.info('Triggering Caddy TLS handshake to generate internal CA');
  await $`docker exec ${CADDY_CONTAINER} wget --no-check-certificate -qO /dev/null https://localhost/ 2>/dev/null`
    .quiet()
    .nothrow();

  // 3. Wait for cert to appear
  const maxAttempts = 15;
  let certFound = false;

  for (let i = 0; i < maxAttempts; i++) {
    const result =
      await $`docker exec ${CADDY_CONTAINER} test -f ${CONTAINER_CERT_PATH}`
        .quiet()
        .nothrow();
    if (result.exitCode === 0) {
      certFound = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!certFound) {
    log.warn(
      'Caddy root CA certificate not found after waiting — HTTPS may show warnings',
    );
    return;
  }

  // 4. Copy cert to host
  const certDest = localCertPath();
  await mkdir(userConfigDir(), { recursive: true });
  await $`docker cp ${CADDY_CONTAINER}:${CONTAINER_CERT_PATH} ${certDest}`.quiet();
  log.info({ path: certDest }, 'Copied Caddy root CA to host');

  // 5. Platform-specific trust
  const platform = process.platform;

  if (platform === 'darwin') {
    log.info('Trusting Caddy root CA in macOS System keychain (requires sudo)');
    await $`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${certDest}`;
  } else if (platform === 'linux') {
    log.info('Trusting Caddy root CA on Linux (requires sudo)');
    await $`sudo cp ${certDest} /usr/local/share/ca-certificates/ox-caddy-root.crt`;
    await $`sudo update-ca-certificates`;
  } else {
    log.warn(
      { platform },
      'Automatic certificate trust not supported on this platform. ' +
        `Manually trust: ${certDest}`,
    );
    return;
  }

  // 6. Write marker
  await Bun.write(certMarkerPath(), new Date().toISOString());
  log.info('Caddy root CA trusted and marker written');
}
