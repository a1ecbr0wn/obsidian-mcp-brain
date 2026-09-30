// Container health check: asks the local listener for its OAuth discovery document.
//
// Reads listenHost and listenPort from the mounted config the same way the server
// does, so the check follows whatever the operator configured. A wildcard bind
// address (0.0.0.0 or ::) is not a valid place to connect to, so it is probed on
// loopback instead. Exits 0 when the server answers with a 2xx status, otherwise 1. Uses Node's
// built-in fetch so the image needs no curl.

import { readFileSync } from 'node:fs';

/**
 * Picks the address to connect to for a configured listenHost.
 * @param {unknown} listenHost - The config's listenHost, or undefined when unset.
 * @returns {string} A host usable in a URL: loopback for unset or wildcard hosts,
 *   otherwise the configured host, with IPv6 literals wrapped in brackets.
 */
export function probeHost(listenHost) {
  const host = typeof listenHost === 'string' ? listenHost.trim() : '';
  if (!host || host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * Requests the discovery document and reports whether the server is healthy.
 * @param {string} configPath - Path to the server's JSON config file.
 * @returns {Promise<boolean>} True when the server answered with a 2xx status.
 */
export async function isHealthy(configPath) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const port = parseInt(config.listenPort ?? 3002, 10);
    const url = `http://${probeHost(config.listenHost)}:${port}/.well-known/oauth-protected-resource`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit((await isHealthy(process.env.CONFIG_PATH)) ? 0 : 1);
}
