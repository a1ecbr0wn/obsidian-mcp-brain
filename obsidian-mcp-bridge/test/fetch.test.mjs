import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import dns from 'node:dns/promises';
import { validateUrl, fetchToBuffer, isPrivateIPv4, isPrivateIPv6 } from '../lib/fetch.mjs';

// fetchToBuffer tests mock node:http's request() — no real network access, matching
// this project's existing tests. dns.lookup on a literal IP resolves offline (no
// network call), so validateUrl tests use literal IPs (public: 8.8.8.8; private: per
// range). fetchToBuffer uses http.request directly (not the global fetch) so it can
// pin the connection to the already-validated address — see lib/fetch.mjs's
// pinnedLookup comment. One test (hanging DNS lookup) mocks dns.lookup itself to
// verify that even unresponsive resolvers don't stall past the timeout.

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
