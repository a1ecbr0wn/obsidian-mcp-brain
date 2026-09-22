// SSRF-safe URL fetching for fetch-binary-file. A caller-supplied URL is effectively
// a request to make this host issue an arbitrary outbound call — on any deployment,
// that host may have private network services reachable that shouldn't be — so every
// function here exists to keep that call scoped to the public internet.

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv4InRange(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

// Loopback, link-local, and the three RFC1918 private ranges.
const PRIVATE_V4_RANGES = [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
];

export function isPrivateIPv4(ip) {
  return PRIVATE_V4_RANGES.some(([base, bits]) => ipv4InRange(ip, base, bits));
}

export function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique-local
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped IPv6
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/**
 * Validates that url is an http(s) URL whose hostname resolves only to public
 * addresses. Throws with a clear message otherwise.
 * @returns {Promise<{parsed: URL, addresses: {address: string, family: number}[]}>}
 *   The resolved addresses are returned so the caller can pin its connection to them
 *   (see fetchToBuffer) — re-resolving the hostname later, e.g. inside a plain
 *   fetch()/http.request() call, would reopen a DNS-rebinding gap between this check
 *   and the actual connection.
 */
export async function validateUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`URL scheme must be http or https: ${url}`);
  }

  let addresses;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve hostname: ${parsed.hostname}`);
  }
  if (!addresses.length) {
    throw new Error(`Could not resolve hostname: ${parsed.hostname}`);
  }
  for (const { address, family } of addresses) {
    const isPrivate = family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
    if (isPrivate) {
      throw new Error(`URL resolves to a disallowed address (${address}): ${url}`);
    }
  }
  return { parsed, addresses };
}

// A dns.lookup-compatible function that ignores whatever hostname it's asked to
// resolve and always returns the address(es) validateUrl already vetted — this is
// what pins the actual socket to the validated IP, closing the DNS-rebinding gap
// between validation and connection (the hostname could otherwise resolve to a
// different, private address on a second, independent lookup).
function pinnedLookup(addresses) {
  const first = addresses[0];
  return (_hostname, _options, callback) => callback(null, first.address, first.family);
}

/**
 * Downloads url and returns its body as a Buffer, enforcing maxBytes while streaming
 * (aborting mid-transfer rather than after the fact) and a hard per-hop timeoutMs
 * (covering both DNS resolution via validateUrl and the HTTP request itself).
 * Redirects are followed manually, up to MAX_REDIRECTS hops, with validateUrl re-run
 * on every hop's target — never just the first. Uses node:http/https directly (not
 * the global fetch) so the connection can be pinned to the exact address validateUrl
 * already checked, rather than letting the request re-resolve the hostname itself.
 */
export async function fetchToBuffer(url, { maxBytes, timeoutMs }) {
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

    try {
      // validateUrl's dns.lookup has no cancellation of its own, so a hostname
      // pointed at a slow or unresponsive resolver (fully attacker-controlled,
      // since the URL is caller-supplied) could otherwise stall past timeoutMs
      // despite the "hard per-hop timeout" this function promises. Racing it
      // against the same abort signal bounds the wait even though the underlying
      // lookup can't itself be cancelled; the losing promise is given a no-op
      // catch so its eventual settlement doesn't surface as an unhandled rejection.
      const validatePromise = validateUrl(currentUrl);
      validatePromise.catch(() => {});
      const { parsed, addresses } = await Promise.race([
        validatePromise,
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('timed out')));
        }),
      ]);
      if (timedOut) throw new Error('timed out');

      const client = parsed.protocol === 'https:' ? https : http;
      const response = await new Promise((resolve, reject) => {
        const req = client.request(parsed, {
          lookup: pinnedLookup(addresses),
          servername: parsed.hostname, // keep TLS SNI/cert hostname checks against the real hostname
          signal: controller.signal,
        }, resolve);
        req.on('error', reject);
        req.end();
      });

      if (REDIRECT_STATUSES.has(response.statusCode)) {
        response.resume(); // discard the redirect body
        const location = response.headers.location;
        if (!location) throw new Error(`Redirect response (${response.statusCode}) had no Location header`);
        currentUrl = new URL(location, parsed).toString();
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        throw new Error(`Request failed with status ${response.statusCode}`);
      }

      const chunks = [];
      let total = 0;
      for await (const chunk of response) {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy();
          throw new Error(`Response exceeded maxBytes (${maxBytes} bytes)`);
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (err) {
      if (timedOut) throw new Error(`Request timed out after ${timeoutMs}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Too many redirects (limit ${MAX_REDIRECTS})`);
}
