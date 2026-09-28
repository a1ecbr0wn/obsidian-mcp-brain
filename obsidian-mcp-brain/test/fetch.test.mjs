import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import dns from 'node:dns/promises';
import { validateUrl, fetchToBuffer, isPrivateIPv4, isPrivateIPv6 } from '../lib/fetch.mjs';

// Tests cover isPrivateIPv4/isPrivateIPv6 (fail-closed on malformed input, handle
// IPv4-mapped IPv6 in dotted and hex notation), validateUrl (rejects blocked ranges:
// loopback, link-local, RFC1918, CGNAT, IETF/benchmarking/documentation, multicast,
// reserved, IPv6 unique-local/site-local/Teredo/discard/NAT64/6to4/IPv4-compatible,
// and IPv4-mapped IPv6 wrapping any blocked IPv4), and fetchToBuffer (streams with
// size limits, follows redirects with re-validation, respects timeouts including
// hanging DNS). Real network access is never used; dns.lookup on a literal IP
// resolves offline, and http.request is mocked.

let originalRequest;
/**
 * Installs a fake http.request. handler(options) is called once end() is invoked
 * on the fake request, and returns { statusCode, headers, chunks, hang }:
 * hang: true never responds (for the timeout test); otherwise the mock "response"
 * (an EventEmitter that's also async-iterable over chunks) is passed to the caller's
 * callback on the next microtask.
 */
function mockHttpRequest(handler) {
  originalRequest = http.request;
  http.request = (urlOrOptions, options, callback) => {
    const req = new EventEmitter();
    let aborted = false;
    if (options?.signal) {
      options.signal.addEventListener('abort', () => {
        aborted = true;
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        req.emit('error', err);
      });
    }
    req.end = () => {
      queueMicrotask(() => {
        if (aborted) return;
        const spec = handler(urlOrOptions, options);
        if (spec.hang) return; // never calls back — simulates a request that never resolves
        const res = new EventEmitter();
        res.statusCode = spec.statusCode ?? 200;
        res.headers = spec.headers ?? {};
        res.resume = () => {};
        res.destroy = () => { res.destroyed = true; };
        res[Symbol.asyncIterator] = async function* () {
          for (const chunk of spec.chunks ?? []) {
            if (res.destroyed) return;
            yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          }
        };
        callback(res);
      });
    };
    req.destroy = () => {};
    return req;
  };
}
afterEach(() => {
  if (originalRequest) { http.request = originalRequest; originalRequest = undefined; }
});

describe('isPrivateIPv4', () => {
  test('flags loopback, link-local, and all three RFC1918 ranges', () => {
    assert.ok(isPrivateIPv4('127.0.0.1'));
    assert.ok(isPrivateIPv4('169.254.1.1'));
    assert.ok(isPrivateIPv4('10.0.0.1'));
    assert.ok(isPrivateIPv4('172.16.0.1'));
    assert.ok(isPrivateIPv4('192.168.1.1'));
  });

  test('correctly bounds the 172.16.0.0/12 range', () => {
    assert.ok(isPrivateIPv4('172.31.255.255'));
    assert.ok(!isPrivateIPv4('172.32.0.0'));
    assert.ok(!isPrivateIPv4('172.15.255.255'));
  });

  test('does not flag public addresses', () => {
    assert.ok(!isPrivateIPv4('8.8.8.8'));
    assert.ok(!isPrivateIPv4('1.1.1.1'));
  });

  test('flags other non-public ranges: CGNAT, IETF protocol, benchmarking, multicast, reserved, broadcast', () => {
    assert.ok(isPrivateIPv4('100.64.0.1'));
    assert.ok(isPrivateIPv4('100.127.255.255'));
    assert.ok(isPrivateIPv4('192.0.0.1'));
    assert.ok(isPrivateIPv4('198.18.0.1'));
    assert.ok(isPrivateIPv4('198.19.255.255'));
    assert.ok(isPrivateIPv4('224.0.0.1'));
    assert.ok(isPrivateIPv4('240.0.0.1'));
    assert.ok(isPrivateIPv4('255.255.255.255'));
  });

  test('correctly bounds those ranges', () => {
    assert.ok(!isPrivateIPv4('100.63.255.255'));
    assert.ok(!isPrivateIPv4('100.128.0.1'));
    assert.ok(!isPrivateIPv4('198.17.255.255'));
    assert.ok(!isPrivateIPv4('198.20.0.1'));
    assert.ok(!isPrivateIPv4('223.255.255.255'));
  });
});

describe('fail-closed on input that is not an address of the expected family', () => {
  test('treats non-IP strings and family mismatches as private rather than public', () => {
    assert.ok(isPrivateIPv4('garbage'));
    assert.ok(isPrivateIPv4(''));
    assert.ok(isPrivateIPv4('::1'));
    assert.ok(isPrivateIPv6('garbage'));
    assert.ok(isPrivateIPv6(''));
    assert.ok(isPrivateIPv6('8.8.8.8'));
  });

  test('a public address of the right family is still public', () => {
    assert.ok(!isPrivateIPv4('8.8.8.8'));
    assert.ok(!isPrivateIPv6('2001:4860:4860::8888'));
  });
});

describe('isPrivateIPv6', () => {
  test('flags loopback, link-local, and unique-local', () => {
    assert.ok(isPrivateIPv6('::1'));
    assert.ok(isPrivateIPv6('fe80::1'));
    assert.ok(isPrivateIPv6('fc00::1'));
    assert.ok(isPrivateIPv6('fd12:3456::1'));
  });

  test('unwraps an IPv4-mapped IPv6 address and checks the embedded v4', () => {
    assert.ok(isPrivateIPv6('::ffff:127.0.0.1'));
    assert.ok(!isPrivateIPv6('::ffff:8.8.8.8'));
  });

  test('does not flag a public IPv6 address', () => {
    assert.ok(!isPrivateIPv6('2001:4860:4860::8888'));
  });

  // Regression: URL and dns.lookup normalise "::ffff:127.0.0.1" to the hex form
  // "::ffff:7f00:1", which the old dotted-only check never matched — so a URL like
  // http://[::ffff:a9fe:a9fe]/ (cloud metadata) was treated as public.
  test('unwraps an IPv4-mapped IPv6 address written in hex, as URL normalisation produces', () => {
    assert.ok(isPrivateIPv6('::ffff:7f00:1'));      // 127.0.0.1
    assert.ok(isPrivateIPv6('::ffff:a9fe:a9fe'));   // 169.254.169.254
    assert.ok(isPrivateIPv6('::ffff:a00:1'));       // 10.0.0.1
    assert.ok(isPrivateIPv6('::ffff:c0a8:101'));    // 192.168.1.1
    assert.ok(!isPrivateIPv6('::ffff:808:808'));    // 8.8.8.8
  });

  test('flags IPv4-compatible (::a.b.c.d), site-local, and other special-purpose IPv6 ranges', () => {
    assert.ok(isPrivateIPv6('::7f00:1'));            // ::127.0.0.1 after normalisation
    assert.ok(isPrivateIPv6('::a9fe:a9fe'));         // ::169.254.169.254
    assert.ok(isPrivateIPv6('fec0::1'));             // site-local
    assert.ok(isPrivateIPv6('100::1'));              // discard-only
    assert.ok(isPrivateIPv6('2001::1'));             // Teredo
    assert.ok(isPrivateIPv6('2001:db8::1'));         // documentation
    assert.ok(isPrivateIPv6('3fff::1'));             // documentation
  });

  test('correctly bounds the IPv6 ranges', () => {
    assert.ok(isPrivateIPv6('febf:ffff::1'));        // last of fe80::/10
    assert.ok(!isPrivateIPv6('fe7f::1'));            // just below fe80::/10
    assert.ok(isPrivateIPv6('fdff::1'));             // inside fc00::/7
    assert.ok(!isPrivateIPv6('fbff::1'));            // just below fc00::/7
    assert.ok(!isPrivateIPv6('2001:ffff::1'));       // just past Teredo 2001::/32
    assert.ok(!isPrivateIPv6('2003::1'));            // just past 6to4 2002::/16
    assert.ok(!isPrivateIPv6('2001:4860:4860::8888'));
  });

  test('is case-insensitive and treats a mapped public address as public', () => {
    assert.ok(isPrivateIPv6('::FFFF:7F00:1'));
    assert.ok(!isPrivateIPv6('::ffff:808:808'));
  });

  test('flags multicast, NAT64, and 6to4 prefixes, which can embed or route to private IPv4', () => {
    assert.ok(isPrivateIPv6('ff02::1'));
    assert.ok(isPrivateIPv6('64:ff9b::7f00:1'));
    assert.ok(isPrivateIPv6('64:ff9b:1::1'));
    assert.ok(isPrivateIPv6('2002:7f00:1::'));
  });
});

describe('validateUrl', () => {
  test('rejects a non-http(s) scheme', async () => {
    await assert.rejects(() => validateUrl('ftp://8.8.8.8/x'), /scheme must be http or https/i);
  });

  test('rejects an unparseable URL string', async () => {
    await assert.rejects(() => validateUrl('not a url'), /invalid url/i);
  });

  test('rejects loopback', async () => {
    await assert.rejects(() => validateUrl('http://127.0.0.1/'), /disallowed address/i);
  });

  test('rejects link-local', async () => {
    await assert.rejects(() => validateUrl('http://169.254.1.1/'), /disallowed address/i);
  });

  test('rejects 10.0.0.0/8', async () => {
    await assert.rejects(() => validateUrl('http://10.0.0.1/'), /disallowed address/i);
  });

  test('rejects 172.16.0.0/12', async () => {
    await assert.rejects(() => validateUrl('http://172.16.0.1/'), /disallowed address/i);
  });

  test('rejects 192.168.0.0/16', async () => {
    await assert.rejects(() => validateUrl('http://192.168.1.1/'), /disallowed address/i);
  });

  test('rejects an IPv6 loopback literal', async () => {
    await assert.rejects(() => validateUrl('http://[::1]/'), /disallowed address/i);
  });

  test('rejects an IPv6 link-local literal', async () => {
    await assert.rejects(() => validateUrl('http://[fe80::1]/'), /disallowed address/i);
  });

  test('rejects IPv4-mapped IPv6 literals wrapping loopback, cloud metadata, and RFC1918, in either notation', async () => {
    for (const url of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[::ffff:a9fe:a9fe]/',
      'http://[::ffff:10.0.0.1]/',
    ]) {
      await assert.rejects(() => validateUrl(url), /disallowed address/i, url);
    }
  });

  test('rejects IPv4-compatible and site-local IPv6 literals, which URL normalises to hex', async () => {
    for (const url of ['http://[::127.0.0.1]/', 'http://[::a9fe:a9fe]/', 'http://[fec0::1]/']) {
      await assert.rejects(() => validateUrl(url), /disallowed address/i, url);
    }
  });

  test('still accepts a public address written as an IPv4-mapped IPv6 literal', async () => {
    const { addresses } = await validateUrl('http://[::ffff:8.8.8.8]/');
    assert.ok(addresses.length > 0);
  });

  test('rejects IPv4 documentation ranges', async () => {
    for (const url of ['http://192.0.2.1/', 'http://198.51.100.1/', 'http://203.0.113.1/']) {
      await assert.rejects(() => validateUrl(url), /disallowed address/i, url);
    }
  });

  test('rejects CGNAT and multicast IPv4 literals', async () => {
    await assert.rejects(() => validateUrl('http://100.64.0.1/'), /disallowed address/i);
    await assert.rejects(() => validateUrl('http://224.0.0.1/'), /disallowed address/i);
  });

  // Regression: URL.hostname serializes IPv6 literals with brackets (e.g. "[::1]"),
  // which dns.lookup can't resolve as-is — the address must actually be checked
  // ("disallowed address"), not just fail to resolve ("could not resolve hostname").
  // A CI environment without IPv6 exposed this: dns.lookup("[::1]") failed to
  // resolve there even though a same-host environment resolved it by coincidence.
  test('actually resolves and checks an IPv6 literal, rather than failing to resolve it', async () => {
    await assert.rejects(() => validateUrl('http://[::1]/'), err => {
      assert.doesNotMatch(err.message, /could not resolve/i);
      return true;
    });
  });

  test('accepts a public IPv4 literal and returns its resolved addresses', async () => {
    const { parsed, addresses } = await validateUrl('http://8.8.8.8/');
    assert.equal(parsed.hostname, '8.8.8.8');
    assert.ok(addresses.some(a => a.address === '8.8.8.8'));
  });
});

describe('fetchToBuffer', () => {
  test('returns the response body as a Buffer on success', async () => {
    mockHttpRequest(() => ({ statusCode: 200, chunks: ['hel', 'lo'] }));
    const buf = await fetchToBuffer('http://8.8.8.8/x', { maxBytes: 1000, timeoutMs: 1000 });
    assert.equal(buf.toString(), 'hello');
  });

  // Regression: Node 20+ enables autoSelectFamily by default, so net.connect calls a
  // custom lookup with { all: true } and requires an array of { address, family } back.
  // Answering with the single-address form there made every real-hostname fetch fail
  // with "Invalid IP address: undefined". IP-literal URLs never invoke lookup at all,
  // which is why the tests above couldn't see it — these use a hostname with dns mocked.
  describe('pinned lookup contract', () => {
    let originalLookup;
    afterEach(() => { if (originalLookup) { dns.lookup = originalLookup; originalLookup = undefined; } });

    async function captureLookup() {
      originalLookup = dns.lookup;
      dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }];
      let lookup;
      mockHttpRequest((_url, options) => { lookup = options.lookup; return { statusCode: 200, chunks: ['x'] }; });
      await fetchToBuffer('http://example.com/x', { maxBytes: 1000, timeoutMs: 1000 });
      return lookup;
    }

    test('answers an { all: true } lookup with the array of validated addresses', async () => {
      const lookup = await captureLookup();
      const result = await new Promise((resolve, reject) =>
        lookup('ignored.example', { all: true }, (err, ...args) => (err ? reject(err) : resolve(args))));
      assert.equal(result.length, 1, 'all:true must be answered with a single array argument');
      assert.deepEqual(result[0], [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ]);
    });

    test('answers a plain lookup with a single address and family', async () => {
      const lookup = await captureLookup();
      const result = await new Promise((resolve, reject) =>
        lookup('ignored.example', {}, (err, ...args) => (err ? reject(err) : resolve(args))));
      assert.deepEqual(result, ['93.184.216.34', 4]);
    });
  });

  test('throws with the status code on a non-2xx response', async () => {
    mockHttpRequest(() => ({ statusCode: 404 }));
    await assert.rejects(() => fetchToBuffer('http://8.8.8.8/missing', { maxBytes: 1000, timeoutMs: 1000 }), /404/);
  });

  test('re-validates a redirect target and rejects one that resolves to a private address, without following it', async () => {
    let calls = 0;
    mockHttpRequest(() => {
      calls++;
      return { statusCode: 302, headers: { location: 'http://10.0.0.1/secret' } };
    });
    await assert.rejects(
      () => fetchToBuffer('http://8.8.8.8/start', { maxBytes: 1000, timeoutMs: 1000 }),
      /disallowed address/i,
    );
    assert.equal(calls, 1, 'the private redirect target must never actually be requested');
  });

  test('throws after too many redirects', async () => {
    mockHttpRequest(() => ({ statusCode: 302, headers: { location: 'http://8.8.8.8/next' } }));
    await assert.rejects(() => fetchToBuffer('http://8.8.8.8/start', { maxBytes: 1000, timeoutMs: 1000 }), /too many redirects/i);
  });

  test('aborts mid-stream once maxBytes is exceeded, without reading the full body', async () => {
    let consumed = 0;
    originalRequest = http.request;
    http.request = (urlOrOptions, options, callback) => {
      const req = new EventEmitter();
      req.end = () => {
        queueMicrotask(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          res.resume = () => {};
          res.destroy = () => { res.destroyed = true; };
          // 500,1000,1500 bytes cumulative — exceeds maxBytes=1000 on the third chunk.
          // A generator (not a pre-built array) so consumed only counts what fetchToBuffer
          // actually pulled before throwing, proving it stops early rather than draining
          // all 5 chunks first.
          res[Symbol.asyncIterator] = async function* () {
            for (let i = 0; i < 5; i++) {
              if (res.destroyed) return;
              consumed++;
              yield new Uint8Array(500);
            }
          };
          callback(res);
        });
      };
      req.destroy = () => {};
      return req;
    };
    await assert.rejects(
      () => fetchToBuffer('http://8.8.8.8/big', { maxBytes: 1000, timeoutMs: 1000 }),
      /exceeded maxBytes/i,
    );
    assert.equal(consumed, 3, 'must stop after the chunk that exceeds the cap, not drain the whole body');
  });

  test('times out a hanging request', async () => {
    mockHttpRequest(() => ({ hang: true }));
    await assert.rejects(
      () => fetchToBuffer('http://8.8.8.8/hangs', { maxBytes: 1000, timeoutMs: 50 }),
      /timed out after 50ms/i,
    );
  });

  test('times out a hanging DNS lookup, not just a hanging request', async () => {
    // dns.lookup has no cancellation of its own, so the timeout has to bound the
    // whole hop (validateUrl included) rather than starting only once the request
    // begins — this is what closes the gap a code review caught.
    const originalLookup = dns.lookup;
    dns.lookup = () => new Promise(() => {}); // never resolves
    try {
      await assert.rejects(
        () => fetchToBuffer('http://example.com/x', { maxBytes: 1000, timeoutMs: 50 }),
        /timed out after 50ms/i,
      );
    } finally {
      dns.lookup = originalLookup;
    }
  });
});
