# Changes: Global server surface + config hot-reload

**Date**: 2026-07-19

Two server-side capabilities: a `/global/*` HTTP surface for host-level operations (fs browse, cache reload, restart) with the auth hole on that prefix closed, and live config hot-reload so config file edits apply without restarting the process.

## GET /global/fs + /global/* auth close (`fe92f6ab2e`)

- **`src/server/global-fs.ts` (NEW, 77 lines).** Host directory browse: lists entries for an absolute path, used by clients to pick project directories without shelling out.
- **`src/server/routes/global.ts` (NEW).** Legacy-backend `/global/*` route group.
- **httpapi backend parity.** `routes/instance/httpapi/{groups,handlers}/global.ts` (NEW) expose the same surface on the Effect HttpApi backend.
- **Auth hole closed.** `/global/*` previously bypassed bearer auth on the httpapi backend (`public.ts` treated the prefix as public). Now pinned behind auth on both backends; regression coverage in `test/server/httpapi-raw-route-auth.test.ts` (NEW) + `httpapi-bridge.test.ts`. GOTCHAS entry: `httpapi-root-api-family-needs-auth-router-middleware`.
- Tests: `test/server/global-fs.test.ts` (98 lines).

## Config hot-reload (`57fcf0e19d` + fixes `d93f208e88`, `d262514989`)

Config file changes apply live — no restart.

- **`src/config/reload.ts` (NEW, ~280 lines after fixes).** Watches config files via `file/watcher.ts`, and on change flushes the per-instance caches and re-boots the instance state so agents/commands/providers/skills/mcp/tools/lsp/format/plugins pick up the new config. One-line cache-registration hooks added across 14 service modules (`agent.ts`, `command/index.ts`, `format/index.ts`, `lsp.ts`, `mcp/index.ts`, `plugin/index.ts`, `provider/{auth,provider}.ts`, `skill/index.ts`, `tool/registry.ts`, …).
- **`effect/instance-registry.ts` + `instance-state.ts` extensions.** Flush/re-boot primitives the reloader drives; tests in `test/effect/instance-state.test.ts`.
- **Fix: never flush an in-flight boot (`d93f208e88`).** Flushing an instance mid-boot deadlocked inside ScopedCache (the flush waits on the boot which waits on the cache slot). Reload now skips in-flight boots with a bounded late-boot retry, plus a watcher noise filter (editor tmp-file churn).
- **Fix: watcher must be forced alive (`d262514989`).** Per-service runtimes are lazy — a layer nothing references is never constructed, so the watcher silently never started. `Server.listen` now explicitly touches the reload service.
- **GOTCHAS (`c1abd5e895`).** Two entries: the lazy-runtime construction trap + the ScopedCache in-flight-boot deadlock.

## POST /global/reload + /global/restart (`0d70d6f39f`)

- **`/global/reload`** flushes skills/mcp/config caches live via the reload service — the manual trigger for the same path the watcher drives.
- **`/global/restart`** (`src/server/global-lifecycle.ts`, NEW): clean process exit for the supervisor to relaunch.
- Both backends, both auth-pinned (`httpapi-raw-route-auth.test.ts` extended).
