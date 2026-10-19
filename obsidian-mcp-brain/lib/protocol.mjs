// The MCP protocol versions the server speaks, and the choice of one for a client.
// The tool list and the transport are the same for all of them; a newer version adds fields
// (a tool's `title`, for one) that an older client ignores.

/** Newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

/**
 * The version to answer `initialize` with: the one the client asked for if the server speaks
 * it, otherwise the newest the server speaks (the client then decides whether it can).
 * @param {unknown} requested - `params.protocolVersion` from the request.
 * @returns {string}
 */
export function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.find(v => v === requested) ?? SUPPORTED_PROTOCOL_VERSIONS[0];
}

/**
 * Whether an `MCP-Protocol-Version` header is acceptable. A request without the header is
 * acceptable (the specification says to assume 2025-03-26). One with a value the server does
 * not speak is not, and neither is an empty one. A header sent twice, or a comma-separated list
 * (Node joins repeated headers that way, as do some proxies), is acceptable when every version
 * in it is one the server speaks.
 * @param {string|string[]|undefined} header - The header as Node gives it.
 * @returns {boolean}
 */
export function protocolHeaderAcceptable(header) {
  if (header === undefined) return true;
  const value = Array.isArray(header) ? header.join(',') : header;
  if (typeof value !== 'string') return false;
  return value.split(',').every(token => SUPPORTED_PROTOCOL_VERSIONS.includes(token.trim()));
}
