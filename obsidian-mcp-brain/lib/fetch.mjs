// SSRF-safe URL fetching for fetch-binary-file. A caller-supplied URL is effectively
// a request to make this host issue an arbitrary outbound call — on any deployment,
// that host may have private network services reachable that shouldn't be — so every
// function here exists to keep that call scoped to the public internet.

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Addresses a caller-supplied URL must never be allowed to reach. net.BlockList does
// the range matching, and — unlike a hand-written regex — treats an IPv4-mapped IPv6
// address (::ffff:a.b.c.d, in dotted or hex notation) as the IPv4 address it wraps.
// That matters because URL and dns.lookup normalise "::ffff:127.0.0.1" to the hex
// form "::ffff:7f00:1", so a check that only recognises the dotted form waves
// loopback and the cloud metadata address (169.254.169.254) straight through.
const BLOCKED = new net.BlockList();
const BLOCKED_V4 = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // RFC1918
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, incl. cloud metadata
  ['172.16.0.0', 12],    // RFC1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // documentation
  ['192.168.0.0', 16],   // RFC1918
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // documentation
  ['203.0.113.0', 24],   // documentation
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, incl. 255.255.255.255 broadcast
];
// NAT64 and 6to4 embed or route to an arbitrary IPv4 address, so they are blocked
// outright rather than unwrapped — no public web server needs to be reached that way.
const BLOCKED_V6 = [
  ['::', 96],            // unspecified, loopback, and deprecated IPv4-compatible ::a.b.c.d
  ['100::', 64],         // discard-only
  ['2001::', 32],        // Teredo
  ['2001:db8::', 32],    // documentation
  ['2002::', 16],        // 6to4
  ['3fff::', 20],        // documentation
  ['64:ff9b::', 96],     // NAT64
  ['64:ff9b:1::', 48],   // local-use NAT64
  ['fc00::', 7],         // unique-local
  ['fe80::', 10],        // link-local
  ['fec0::', 10],        // deprecated site-local
  ['ff00::', 8],         // multicast
];
for (const [net4, bits] of BLOCKED_V4) BLOCKED.addSubnet(net4, bits, 'ipv4');
for (const [net6, bits] of BLOCKED_V6) BLOCKED.addSubnet(net6, bits, 'ipv6');

/**
 * Checks if an IPv4 address falls within a blocked (non-public) range.
 * "Private" means not safe to fetch — includes loopback, link-local, RFC1918,
 * CGNAT, IETF protocol/benchmarking/documentation, multicast, and reserved ranges.
 * Fails closed: non-IPv4 input returns true.
 * @param {string} ip - IPv4 address to check.
 * @returns {boolean} True if private (blocked), false if public.
 */
export function isPrivateIPv4(ip) {
  return !net.isIPv4(ip) || BLOCKED.check(ip, 'ipv4');
}

/**
 * Checks if an IPv6 address falls within a blocked (non-public) range.
 * "Private" means not safe to fetch — includes loopback, link-local, unique-local,
 * IPv4-mapped IPv6 (unwraps and checks the embedded IPv4), IPv4-compatible (::a.b.c.d),
 * discard-only, Teredo, documentation, 6to4, NAT64, site-local, and multicast ranges.
 * Fails closed: non-IPv6 input returns true.
 * @param {string} ip - IPv6 address to check (dotted or hex notation; IPv4-mapped unwrapped automatically).
 * @returns {boolean} True if private (blocked), false if public.
 */
export function isPrivateIPv6(ip) {
  return !net.isIPv6(ip) || BLOCKED.check(ip, 'ipv6');
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

  // URL.hostname serializes an IPv6 literal with brackets (e.g. "[::1]"), but
  // dns.lookup expects the bare address — passing the bracketed form fails to
  // resolve it at all, which would make an IPv6-literal URL error out instead of
  // actually being checked (as happened here: a CI environment without IPv6
  // correctly failed to resolve "[::1]", exposing that a same-host environment
  // resolving it by coincidence was never validating the address, just erroring).
  const lookupHost = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;

  let addresses;
  try {
    addresses = await dns.lookup(lookupHost, { all: true, verbatim: true });
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
// different, private address on a second, independent lookup). Node 20+ calls a
// custom lookup with { all: true } (autoSelectFamily) and requires an array of
// { address, family } back; the single-address form is only valid without `all`.
function pinnedLookup(addresses) {
  const first = addresses[0];
  return (_hostname, options, callback) => (
    options?.all
      ? callback(null, addresses)
      : callback(null, first.address, first.family)
  );
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
