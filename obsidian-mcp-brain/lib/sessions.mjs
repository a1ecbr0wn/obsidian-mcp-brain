/**
 * The MCP sessions the server knows about. A session is made by `initialize` and is used by the
 * client's later requests and its notification stream (`GET /mcp`). Without a limit on how long
 * a session may sit unused the table fills up with the sessions of clients that came and went,
 * and every new `initialize` is then refused; so a session that has been idle for `idleMs` is
 * removed. The table takes its clock as a parameter so that the rules can be tested without
 * waiting.
 */

/**
 * @typedef {object} Session
 * @property {string|undefined} user - Who the session belongs to; set only when authentication is on.
 * @property {number} lastActive - When a request last ended, or a stream last opened or closed.
 * @property {number} inFlight - Requests being handled.
 * @property {boolean} stream - Whether a notification stream is open.
 */

export class SessionTable {
  /** @type {Map<string, Session>} */
  #sessions = new Map();
  #max;
  #idleMs;
  #now;
  #onExpired;

  /**
   * @param {object} options
   * @param {number} options.idleMs - How long a session may be idle before it is removed.
   * @param {number} [options.maxSessions=1000] - The most sessions held at once.
   * @param {() => number} [options.now=Date.now] - The clock, in milliseconds.
   * @param {(removed: Array<{sid: string, user: string|undefined, idleMs: number}>) => void} [options.onExpired]
   *   Called with the sessions removed by every sweep, including the one `create` makes when the
   *   table is full, so that no removal goes unrecorded.
   */
  constructor({ idleMs, maxSessions = 1000, now = Date.now, onExpired = () => {} }) {
    if (!(idleMs > 0)) throw new Error('SessionTable needs a positive idleMs');
    this.#idleMs = idleMs;
    this.#max = maxSessions;
    this.#now = now;
    this.#onExpired = onExpired;
  }

  /** Number of sessions held (expired ones not yet swept are included). */
  get size() {
    return this.#sessions.size;
  }

  /** @param {string} sid */
  has(sid) {
    return this.#sessions.has(sid);
  }

  /**
   * Who a session belongs to.
   * @param {string} sid
   * @returns {string|undefined} undefined for an unknown session or one made without authentication.
   */
  user(sid) {
    return this.#sessions.get(sid)?.user;
  }

  /**
   * Adds a session. When the table is full, sessions that have expired are removed first, so a
   * session nobody uses never blocks a new one.
   * @param {string} sid
   * @param {string} [user]
   * @returns {boolean} false if the table is still full.
   */
  create(sid, user) {
    if (this.#sessions.size >= this.#max) this.sweep();
    if (this.#sessions.size >= this.#max) return false;
    this.#sessions.set(sid, { user, lastActive: this.#now(), inFlight: 0, stream: false });
    return true;
  }

  /** A request on the session starts. @param {string} sid */
  begin(sid) {
    const s = this.#sessions.get(sid);
    if (s) s.inFlight++;
  }

  /** A request on the session ends, which restarts its idle time. @param {string} sid */
  end(sid) {
    const s = this.#sessions.get(sid);
    if (!s) return;
    s.inFlight = Math.max(0, s.inFlight - 1);
    s.lastActive = this.#now();
  }

  /** A notification stream opens on the session. @param {string} sid */
  streamOpened(sid) {
    const s = this.#sessions.get(sid);
    if (!s) return;
    s.stream = true;
    s.lastActive = this.#now();
  }

  /** The session's notification stream closes, which starts its idle time. @param {string} sid */
  streamClosed(sid) {
    const s = this.#sessions.get(sid);
    if (!s) return;
    s.stream = false;
    s.lastActive = this.#now();
  }

  /**
   * The check made a fixed time after a session is created: it goes if no notification stream
   * is open at that moment.
   * @param {string} sid
   * @returns {boolean} Whether the session was removed.
   */
  graceCheck(sid) {
    const s = this.#sessions.get(sid);
    if (!s || s.stream) return false;
    this.#sessions.delete(sid);
    return true;
  }

  /**
   * Removes a session.
   * @param {string} sid
   * @returns {boolean} Whether there was one.
   */
  delete(sid) {
    return this.#sessions.delete(sid);
  }

  /**
   * Removes the sessions that have been idle (no request in flight, no open stream) for the
   * idle time.
   * @returns {Array<{sid: string, user: string|undefined, idleMs: number}>} The sessions removed.
   */
  sweep() {
    const now = this.#now();
    const removed = [];
    for (const [sid, s] of this.#sessions) {
      if (s.inFlight > 0 || s.stream) continue;
      const idleMs = now - s.lastActive;
      if (idleMs < this.#idleMs) continue;
      this.#sessions.delete(sid);
      removed.push({ sid, user: s.user, idleMs });
    }
    if (removed.length) this.#onExpired(removed);
    return removed;
  }
}
