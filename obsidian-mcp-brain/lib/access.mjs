// Pure path-normalisation and access-control functions.
// denyPaths is passed explicitly so these functions are side-effect-free and testable.

export function normPath(...parts) {
  const joined = parts.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  const segments = [];
  for (const seg of joined.split('/')) {
    if (seg === '..') segments.pop();
    else if (seg && seg !== '.') segments.push(seg);
  }
  return segments.join('/');
}

export function isDenied(denyPaths, path) {
  if (!denyPaths.length || !path) return false;
  const p = normPath(path);
  return denyPaths.some(denied => p === denied || p.startsWith(denied + '/'));
}

// ── denyBinaryPaths: wildcard patterns that stop a binary file being read ───
//
// Syntax: vault-relative paths where '*' matches within one segment, '?' matches one
// character within a segment, and '**' as a whole segment matches any number of
// segments (including none). Everything else is literal. A pattern protects any path it
// matches, and everything under a folder it matches. Hand-written because the project has
// no runtime dependencies and supports Node 18, which has no built-in glob matcher.
//
// Matching deliberately does not use regular expressions: the path is client-supplied, and
// a backtracking regex built from stacked '**' or repeated '*' can be made to run for
// seconds on one request, blocking the server's single thread. Both matchers below run in
// polynomial time with no backtracking blow-up.

/**
 * Matches one path segment against a pattern segment of literals, '*' and '?'.
 * Iterative two-pointer matching: remembers only the last '*', so it never recurses.
 */
function segmentMatches(pattern, text) {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

/**
 * True if the pattern's segments match the start of the path's segments; whatever path
 * remains is the contents of a matched folder. Dynamic programming over (pattern segment,
 * path segment), so cost is bounded by pattern length times path length.
 */
function matchesPathPrefix(patSegs, pathSegs) {
  const n = pathSegs.length;
  let next = new Uint8Array(n + 1).fill(1); // every pattern segment consumed
  for (let i = patSegs.length - 1; i >= 0; i--) {
    const cur = new Uint8Array(n + 1);
    if (patSegs[i] === '**') {
      cur[n] = next[n];
      for (let j = n - 1; j >= 0; j--) cur[j] = next[j] || cur[j + 1];
    } else {
      for (let j = n - 1; j >= 0; j--) cur[j] = next[j + 1] && segmentMatches(patSegs[i], pathSegs[j]) ? 1 : 0;
    }
    next = cur;
  }
  return next[0] === 1;
}

/**
 * Compiles denyBinaryPaths patterns once, so each check does no parsing.
 * Patterns are normalised like paths; any that normalise to nothing are dropped.
 * @param {string[]} patterns
 * @returns {string[][]} Each pattern as its list of segments.
 */
export function compileBinaryPatterns(patterns) {
  return patterns.map(p => normPath(p)).filter(Boolean).map(p => p.split('/'));
}

/**
 * True if reading the binary file at `path` is restricted: some pattern matches the
 * path itself or one of its parent folders.
 * @param {string[][]} compiled - Output of compileBinaryPatterns.
 * @param {string} path - Vault-relative path.
 */
export function isBinaryReadDenied(compiled, path) {
  if (!compiled.length || !path) return false;
  const segments = normPath(path).split('/').filter(Boolean);
  return compiled.some(patSegs => matchesPathPrefix(patSegs, segments));
}

/**
 * Returns an error message if moving srcPath to dstPath would take a read-protected file
 * out of protection (source protected, destination not), else null. Without this rule the
 * agent could move a protected file somewhere unprotected and read it there.
 * @param {string[][]} compiled - Output of compileBinaryPatterns.
 * @param {string} srcPath - Vault-relative source path.
 * @param {string} dstPath - Vault-relative destination path.
 */
export function checkBinaryMove(compiled, srcPath, dstPath) {
  if (isBinaryReadDenied(compiled, srcPath) && !isBinaryReadDenied(compiled, dstPath)) {
    return `Reading is restricted for '${normPath(srcPath)}' and the destination is not protected`;
  }
  return null;
}

// Returns an error message string if the tool call should be blocked, else null.
export function checkAccess(denyPaths, toolName, args) {
  if (!denyPaths.length) return null;

  switch (toolName) {
    case 'read-note':
    case 'create-note':
    case 'edit-note': {
      const p = normPath(args.folder, args.filename);
      if (isDenied(denyPaths, p)) return `Access denied: '${p}' is restricted`;
      break;
    }

    case 'delete-note': {
      const p = normPath(args.folder, args.filename);
      if (isDenied(denyPaths, p)) return `Access denied: '${p}' is restricted`;
      break;
    }

    case 'move-note': {
      const src = normPath(args.folder, args.filename);
      const dst = normPath(args.newFolder, args.newFilename);
      if (isDenied(denyPaths, src)) return `Access denied: source '${src}' is restricted`;
      if (isDenied(denyPaths, dst)) return `Access denied: destination '${dst}' is restricted`;
      break;
    }

    case 'create-binary-file':
    case 'fetch-binary-file':
    case 'upload-binary':
    case 'read-binary-file': {
      const p = normPath(args.folder, args.filename);
      if (isDenied(denyPaths, p)) return `Access denied: '${p}' is restricted`;
      break;
    }

    case 'delete-binary-file': {
      const p = normPath(args.folder, args.filename);
      if (isDenied(denyPaths, p)) return `Access denied: '${p}' is restricted`;
      break;
    }

    case 'move-binary-file': {
      const src = normPath(args.folder, args.filename);
      const dst = normPath(args.newFolder, args.newFilename);
      if (isDenied(denyPaths, src)) return `Access denied: source '${src}' is restricted`;
      if (isDenied(denyPaths, dst)) return `Access denied: destination '${dst}' is restricted`;
      break;
    }

    case 'find-backlinks': {
      const p = normPath(args.folder, args.filename);
      if (isDenied(denyPaths, p)) return `Access denied: '${p}' is restricted`;
      break;
    }

    case 'resolve-wikilink': {
      // The target is a free-text string, not a known path — this is a cheap upfront
      // check on the literal string; walkAllFiles's own per-candidate filtering is what
      // actually keeps denied files out of the result regardless.
      if (args.target) {
        const p = normPath(args.target);
        if (isDenied(denyPaths, p)) return `Access denied: '${p}' is restricted`;
      }
      break;
    }

    case 'add-tags':
    case 'remove-tags': {
      const files = Array.isArray(args.files) ? args.files : [];
      const blocked = files.map(f => normPath(f)).find(f => isDenied(denyPaths, f));
      if (blocked) return `Access denied: '${blocked}' is restricted`;
      break;
    }

    case 'create-folder': {
      const p = normPath(args.folder);
      if (isDenied(denyPaths, p)) return `Access denied: '${p}' is restricted`;
      break;
    }

    case 'search-vault': {
      if (args.path) {
        const p = normPath(args.path);
        if (isDenied(denyPaths, p)) return `Access denied: '${p}' is restricted`;
      }
      break;
    }
  }
  return null;
}
