import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTable } from '../lib/sessions.mjs';

const MIN = 60_000;

/** A table with a clock the test moves by hand. */
function makeTable(opts = {}) {
  const clock = { t: 1_000_000 };
  const table = new SessionTable({ idleMs: 30 * MIN, now: () => clock.t, ...opts });
  return { table, clock, advance: ms => { clock.t += ms; } };
}

describe('SessionTable: creating and finding sessions', () => {
  it('holds a session and the user it belongs to', () => {
    const { table } = makeTable();
    assert.equal(table.create('a', 'alec@example.test'), true);
    assert.equal(table.has('a'), true);
    assert.equal(table.user('a'), 'alec@example.test');
    assert.equal(table.size, 1);
  });

  it('has no user for a session made without authentication, and none for an unknown one', () => {
    const { table } = makeTable();
    table.create('a');
    assert.equal(table.user('a'), undefined);
    assert.equal(table.user('nope'), undefined);
    assert.equal(table.has('nope'), false);
  });

  it('refuses a session once the cap is reached', () => {
    const { table } = makeTable({ maxSessions: 3 });
    for (const id of ['a', 'b', 'c']) assert.equal(table.create(id), true);
    assert.equal(table.create('d'), false);
    assert.equal(table.has('d'), false);
  });

  it('makes room by removing expired sessions before it refuses', () => {
    const { table, advance } = makeTable({ maxSessions: 2 });
    table.create('a');
    table.create('b');
    advance(31 * MIN);
    assert.equal(table.create('c'), true);
    assert.equal(table.has('a'), false);
    assert.equal(table.has('c'), true);
  });

  it('does not make room by removing a session that is still in use', () => {
    const { table, advance } = makeTable({ maxSessions: 1 });
    table.create('a');
    table.streamOpened('a');
    advance(31 * MIN);
    assert.equal(table.create('b'), false);
    assert.equal(table.has('a'), true);
  });
});

describe('SessionTable: the idle timeout', () => {
  it('removes a session that has been idle for the timeout', () => {
    const { table, advance } = makeTable();
    table.create('a', 'u');
    advance(30 * MIN - 1);
    assert.deepEqual(table.sweep(), []);
    advance(1);
    const removed = table.sweep();
    assert.deepEqual(removed.map(r => r.sid), ['a']);
    assert.equal(removed[0].user, 'u');
    assert.equal(removed[0].idleMs, 30 * MIN);
    assert.equal(table.has('a'), false);
    assert.equal(table.user('a'), undefined);
  });

  it('is restarted by a request that ends', () => {
    const { table, advance } = makeTable();
    table.create('a');
    advance(20 * MIN);
    table.begin('a');
    table.end('a');
    advance(20 * MIN);
    assert.deepEqual(table.sweep(), []);
    advance(10 * MIN);
    assert.equal(table.sweep().length, 1);
  });

  it('never removes a session while a request is in flight, however long it runs', () => {
    const { table, advance } = makeTable();
    table.create('a');
    table.begin('a');
    advance(5 * 60 * MIN);
    assert.deepEqual(table.sweep(), []);
    table.end('a');
    advance(29 * MIN);
    assert.deepEqual(table.sweep(), []);
    advance(1 * MIN);
    assert.equal(table.sweep().length, 1);
  });

  it('counts overlapping requests, so the first to finish does not make it idle', () => {
    const { table, advance } = makeTable();
    table.create('a');
    table.begin('a');
    table.begin('a');
    table.end('a');
    advance(60 * MIN);
    assert.deepEqual(table.sweep(), []);
    table.end('a');
    advance(30 * MIN);
    assert.equal(table.sweep().length, 1);
  });

  it('never removes a session with a stream open, however long it is idle', () => {
    const { table, advance } = makeTable();
    table.create('a');
    table.streamOpened('a');
    advance(24 * 60 * MIN);
    assert.deepEqual(table.sweep(), []);
    assert.equal(table.has('a'), true);
  });

  it('starts the clock when the stream closes', () => {
    const { table, advance } = makeTable();
    table.create('a');
    table.streamOpened('a');
    advance(5 * 60 * MIN);
    table.streamClosed('a');
    advance(29 * MIN);
    assert.deepEqual(table.sweep(), []);
    advance(1 * MIN);
    assert.equal(table.sweep().length, 1);
  });

  it('keeps a session that reconnects its stream within the timeout', () => {
    const { table, advance } = makeTable();
    table.create('a');
    table.streamOpened('a');
    table.streamClosed('a');
    advance(10 * MIN);
    table.streamOpened('a');
    advance(60 * MIN);
    assert.deepEqual(table.sweep(), []);
  });

  it('only removes the idle sessions', () => {
    const { table, advance } = makeTable();
    table.create('idle');
    table.create('busy');
    table.begin('busy');
    advance(31 * MIN);
    assert.deepEqual(table.sweep().map(r => r.sid), ['idle']);
    assert.equal(table.has('busy'), true);
  });

  it('ignores requests and streams for a session it does not have', () => {
    const { table } = makeTable();
    table.begin('x');
    table.end('x');
    table.streamOpened('x');
    table.streamClosed('x');
    assert.equal(table.has('x'), false);
    assert.equal(table.size, 0);
  });

  it('frees the table after 1000 abandoned sessions, so initialize works again', () => {
    const { table, advance } = makeTable();
    for (let i = 0; i < 1000; i++) {
      assert.equal(table.create(`s${i}`), true);
      table.streamOpened(`s${i}`);
      table.streamClosed(`s${i}`);
    }
    assert.equal(table.create('late'), false, 'full while the sessions are fresh');
    advance(31 * MIN);
    assert.equal(table.create('late'), true);
    assert.equal(table.size, 1);
  });
});

describe('SessionTable: reporting what it removes', () => {
  it('reports the sessions a sweep removes', () => {
    const seen = [];
    const { table, advance } = makeTable({ onExpired: removed => seen.push(...removed) });
    table.create('a', 'u');
    advance(31 * MIN);
    table.sweep();
    assert.deepEqual(seen.map(r => [r.sid, r.user]), [['a', 'u']]);
  });

  it('reports the sessions removed to make room, and does not report when none go', () => {
    const calls = [];
    const { table, advance } = makeTable({ maxSessions: 1, onExpired: removed => calls.push(removed.map(r => r.sid)) });
    table.create('a');
    table.create('b');
    assert.deepEqual(calls, [], 'nothing expired yet');
    advance(31 * MIN);
    assert.equal(table.create('b'), true);
    assert.deepEqual(calls, [['a']]);
  });
});

describe('SessionTable: the check for a session that never opens a stream', () => {
  it('removes a session with no stream open', () => {
    const { table } = makeTable();
    table.create('a', 'u');
    assert.equal(table.graceCheck('a'), true);
    assert.equal(table.has('a'), false);
  });

  it('keeps a session whose stream is open at that moment', () => {
    const { table } = makeTable();
    table.create('a');
    table.streamOpened('a');
    assert.equal(table.graceCheck('a'), false);
    assert.equal(table.has('a'), true);
  });

  it('does nothing for a session that is already gone', () => {
    const { table } = makeTable();
    assert.equal(table.graceCheck('nope'), false);
  });
});

describe('SessionTable: delete', () => {
  it('removes a session and its user, once', () => {
    const { table } = makeTable();
    table.create('a', 'u');
    assert.equal(table.delete('a'), true);
    assert.equal(table.has('a'), false);
    assert.equal(table.user('a'), undefined);
    assert.equal(table.delete('a'), false);
  });

  it('removes a session that is busy', () => {
    const { table } = makeTable();
    table.create('a');
    table.begin('a');
    table.streamOpened('a');
    assert.equal(table.delete('a'), true);
  });
});

describe('SessionTable: setup', () => {
  it('needs an idle time', () => {
    assert.throws(() => new SessionTable({}), /idleMs/);
    assert.throws(() => new SessionTable({ idleMs: 0 }), /idleMs/);
  });

  it('uses the real clock by default', () => {
    const table = new SessionTable({ idleMs: 1000 });
    table.create('a');
    assert.deepEqual(table.sweep(), []);
  });
});
