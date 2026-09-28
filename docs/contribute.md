---
layout: docs
title: "Contribute | obsidian-mcp-brain"
---

## Contribute

Pull requests and issues are welcome on
[GitHub](https://github.com/a1ecbr0wn/obsidian-mcp-brain).

### Repository layout

- `obsidian-mcp-brain/` is the server, published to npm as `obsidian-mcp-brain`.
- `mcp-shim/` is the Claude Desktop relay described under
  [Connect a client](connect). It is not published.
- `docs/` is this site.

The repository is an npm workspaces monorepo. From the repository root:

```sh
npm install
npm test
```

`npm test` runs the server's tests with Node's built-in test runner, so there are
no test dependencies to install. `mcp-shim` has no tests of its own.

### Commit messages

Use [conventional commit](https://www.conventionalcommits.org) prefixes such as
`feat:`, `fix:`, `build:` and `doc:`. The release changelog is generated from them,
and the next version number is worked out from them when a release is made without
naming one.

### Releases

Releases are made from the repository's **Actions** tab by running **Tag a
release**. Leave the version blank to have it worked out from the commits since the
last tag, or give one explicitly. The workflow bumps the version in both
`package.json` files, then commits and tags with a GPG signature. It then
starts the publish workflow, which runs the tests, publishes to npm with
provenance, and creates a GitHub Release with the changelog.

Publishing to npm uses
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) rather than a
stored token. The package's npmjs.com settings must list this repository and the
`publish.yml` workflow as a trusted publisher with direct publish allowed.
