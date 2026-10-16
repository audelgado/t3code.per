# Command Center plugin

A separate app that drives official T3 Code servers through their client surfaces. It lives in the fork at `plugins/command-center/` and is the only thing the fork adds to upstream, so `git merge upstream/main` never conflicts.

## Rules

- The repo root's product rules (Effect services, `vp`, `packages/contracts`, ui `variant` rules) do not apply here. This plugin has its own `package.json` and `package-lock.json` and uses npm.
- Never edit anything outside `plugins/command-center/`. Never import from `../../apps` or `../../packages`.
- Server code uses Node built-ins only (`node:http`, `node:sqlite`, `node:crypto`, global `WebSocket`/`fetch`). No runtime dependencies.
- TypeScript runs by Node type stripping: erasable syntax only (no enums, namespaces or parameter properties), imports end in `.ts`, type-only imports use `import type`.
- All knowledge of T3 (RPC tags, payload shapes, routes) lives in `server/t3link.ts`. Everything else codes against `T3Link`, `ThreadRow` and `ProjectRow` in `server/types.ts`.
- `server/types.ts` is the HTTP contract; the web imports it type-only.
- Fork-only reference sources: `git show feat/command-center:<path>`. Upstream: `git show main:<path>`.
- Tokens never appear in logs, API responses, SSE frames or the DB. T3 tokens live in `CC_HOME/tokens/<machineId>` (0600).
- UI strings are Spanish (rioplatense: "Elegí", "Dictá", "Pegá"); technical terms (PR, commit, push, token, MCP, worktree) stay as is. Dates and numbers use es-AR (`Intl`). Labels shared across screens live in `web/src/look.ts`. No continuously running animations.

## Checks

```sh
npm test
npm run typecheck
npm run contract-check -- --local ../..
```

Before pushing a dependency change, prove a clean install works from the committed tree:

```sh
tmp=$(mktemp -d) && git archive HEAD:plugins/command-center | tar -x -C "$tmp" && (cd "$tmp" && npm ci && npm test)
```

## Living in the T3 repo

- The root pre-commit hook (`vp staged`) formats staged plugin files. Harmless.
- Root vitest has no include filter: never run root `vp test` expecting it to skip `plugins/`.
