# Fixtures — concrete configs and command corpus used as golden inputs

The campaign's golden-input suite. Wave 0 materializes these as JSON files at `packages/opencode/test/fixtures/permission-configs/` and `packages/opencode/test/fixtures/scanner-corpus.json`. Every later wave loads them and asserts behavior against the expected outcomes recorded here.

## Permission config fixtures

Each fixture is a concrete user `opencode.jsonc` permission stanza shape. Stored as JSON. Each fixture has a name, a config body, and a list of expected (invocation → decision) tuples.

### `empty-config.json`

```json
{ "permission": [] }
```

| Invocation | Expected decision |
|---|---|
| `exec_command(cmd: "git status")` | `ask` (no rule matches → default action) |
| `spawn_agent(agent_type: "explore", ...)` | `ask` |

### `allow-all-bash.json`

```json
{ "permission": { "bash": "allow" } }
```

| Invocation | Expected decision |
|---|---|
| `exec_command(cmd: "git status")` | `allow` |
| `exec_command(cmd: "rm /tmp/foo")` | `allow` (bash rule auto-allows; external_directory still asks for `/tmp` though) |
| `spawn_agent(agent_type: "explore")` | `ask` (bash rule doesn't cover task) |

### `deny-all-bash.json`

```json
{ "permission": { "bash": { "*": "deny" } } }
```

| Invocation | Expected outcome |
|---|---|
| `tools(model)` | does NOT contain `bash`, `exec_command`, OR `write_stdin` (SHELL_TOOLS group disabled) |
| `spawn_agent(agent_type: "explore")` | still `ask` (task rule unaffected) |

### `git-allow-rest-ask.json`

```json
{
  "permission": {
    "bash": {
      "git *": "allow",
      "git push": "deny",
      "*": "ask"
    }
  }
}
```

| Invocation | Expected decision |
|---|---|
| `exec_command(cmd: "git status")` | `allow` (matches `git *`) |
| `exec_command(cmd: "git status -s")` | `allow` (AST normalizes flags; `BashArity.prefix(["git","status"]).join(" ") + " *"` = `"git *"`, matches) |
| `exec_command(cmd: "git push origin main")` | `deny` (more specific rule wins via `findLast` semantics; spec for `evaluate.ts` confirms last-match wins) |
| `exec_command(cmd: "npm install")` | `ask` (matches `*`) |
| `exec_command(cmd: "rm /tmp/foo")` | `ask` for `bash` AND `ask` for `external_directory /tmp` (two prompts) |

### `task-explore-allow.json`

```json
{
  "permission": {
    "task": {
      "explore": "allow",
      "general": "ask"
    }
  }
}
```

| Invocation | Expected outcome |
|---|---|
| `spawn_agent(agent_type: "explore", ...)` | `allow` |
| `spawn_agent(agent_type: "general", ...)` | `ask` |
| `spawn_agent` description (per `describeSpawnAgent`) | lists both `explore` and `general` as eligible (allow + ask both render; only `deny` filters out) |

### `task-explore-deny.json`

```json
{
  "permission": {
    "task": {
      "explore": "deny",
      "general": "allow"
    }
  }
}
```

| Invocation | Expected outcome |
|---|---|
| `spawn_agent(agent_type: "explore", ...)` | rejected at execute time (matches the bug-3 hardening pattern) |
| `spawn_agent` description | lists `general` only — `explore` filtered by the `Permission.evaluate("task", item.name, ...).action !== "deny"` filter at `registry.ts:329` (Wave 3 changes the key from `spawn_agent` to `task`) |

### `deny-all-task.json`

```json
{ "permission": { "task": { "*": "deny" } } }
```

| Invocation | Expected outcome |
|---|---|
| `tools(model)` | does NOT contain `task`, `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, OR `close_agent` (MULTI_AGENT_TOOLS group disabled) |
| `exec_command(cmd: "git status")` | `ask` (bash rule unaffected) |

### `mixed-permissions.json`

```json
{
  "permission": {
    "bash": {
      "git *": "allow",
      "rm *": "deny"
    },
    "task": {
      "explore": "allow"
    },
    "edit": "deny"
  }
}
```

Combined fixture exercising all three categories simultaneously.

| Invocation | Expected outcome |
|---|---|
| `exec_command(cmd: "git pull")` | `allow` |
| `exec_command(cmd: "rm /tmp/foo")` | `deny` (and external_directory ask never fires because the bash decision short-circuits) |
| `spawn_agent(agent_type: "explore")` | `allow` |
| `spawn_agent(agent_type: "general")` | `ask` |
| `tools(model)` | excludes `edit`, `write`, `apply_patch` (EDIT_TOOLS group); includes `exec_command`, `write_stdin`, `spawn_agent`, etc. |

### `tools-bash-false.json` (user-config-level)

```json
{
  "tools": { "bash": false },
  "permission": {}
}
```

| Invocation | Expected outcome |
|---|---|
| `tools(model)` | does NOT contain `bash`, `exec_command`, OR `write_stdin` (SHELL_TOOLS group disabled via `resolveTools` group rule) |

### `tools-task-false.json` (user-config-level)

```json
{
  "tools": { "task": false },
  "permission": {}
}
```

| Invocation | Expected outcome |
|---|---|
| `tools(model)` | does NOT contain any of the 6 v2 tools or `task` (MULTI_AGENT_TOOLS group disabled) |

### `agent-overrides-deny-bash.json`

Agent-level (per-agent permission rule) — agent's own permission ruleset says deny-bash; user-level says allow-everything.

```json
{
  "permission": { "bash": "allow", "task": "allow" },
  "agent": {
    "build": {
      "permission": { "bash": { "*": "deny" } }
    }
  }
}
```

| Invocation | Expected outcome |
|---|---|
| `tools(model, agent: "build")` | does NOT contain `bash`, `exec_command`, OR `write_stdin` |
| `tools(model, agent: "caveman")` | DOES contain them (caveman's permission unchanged) |

The `Permission.merge(agent.permission, user.permission)` at `session/llm.ts:453` handles the layering; agent-level rules win on tie via `findLast`.

## Scanner command corpus — `scanner-corpus.json`

50 representative bash commands the scanner must handle correctly. Used by Wave 1's differential test (OLD `shell.ts` parse vs NEW `tool/shell/scan.ts` parse) and Wave 2's differential permission flow test (OLD `bash` perms vs NEW `exec_command` perms).

Format:
```json
[
  {
    "cmd": "git status",
    "expected_patterns": ["git status"],
    "expected_always": ["git *"],
    "expected_dirs": []
  },
  { "cmd": "git status -s --porcelain", "expected_always": ["git *"], ... },
  { "cmd": "npm install --save-dev typescript", "expected_always": ["npm install *"], ... },
  ...
]
```

Categories (~5-10 each):

- **simple commands:** `git status`, `ls`, `pwd`, `whoami`, `node --version`
- **subcommand + flags:** `git status -s`, `npm install --save-dev`, `cargo build --release`, `bun run dev --port 3000`
- **pipelines:** `git status | grep modified`, `ls -la | head -10`, `cat file.txt | wc -l`
- **chains:** `npm test && npm run build`, `git pull || echo failed`, `mkdir foo && cd foo`
- **file-touch (in-cwd):** `rm ./tmp.txt`, `cp src/foo.ts dst/`, `mv old.json new.json`, `mkdir -p dist`
- **file-touch (out-of-cwd):** `rm /tmp/foo`, `cp ~/Downloads/file .`, `mkdir /var/log/myapp`, `chmod 755 /usr/local/bin/script`
- **cwd changes:** `cd /home/user`, `pushd ../other`, `cd "$HOME"`, `cd ~/Documents`
- **environment:** `export PATH=/usr/local/bin:$PATH`, `NODE_ENV=production npm start`, `unset DEBUG`
- **subshells / heredocs:** `bash -c "echo hello"`, `python -c 'print("x")'`, `cat <<EOF\nhello\nEOF`
- **quoting / globbing:** `git log --grep='foo bar'`, `ls *.{ts,tsx}`, `find . -name "*.json"`
- **edge cases:** empty string `""`, single space `" "`, single token `"x"`, very long input (200 chars), unicode (`echo "héllo"`)

Each entry's `expected_always`, `expected_patterns`, `expected_dirs` is established in Wave 0 by running `shell.ts`'s scanner against each command and recording the output. Wave 1's differential test compares `tool/shell/scan.ts`'s scanner against these recorded values.

## Generation script

Wave 0 ships `packages/opencode/test/fixtures/generate-corpus.ts` that:

1. Reads each command from a hardcoded list (the categories above).
2. Calls the legacy `shell.ts` scanner on each.
3. Writes the resulting `expected_*` fields to `scanner-corpus.json`.
4. Idempotent — re-running with no scanner change produces a byte-identical file.

The committed `scanner-corpus.json` is the authoritative oracle for Wave 1's differential test. Wave 1 must NOT regenerate it (regenerating defeats the differential check). Wave 1 only consumes it.

## How fixtures are loaded

Test helper at `packages/opencode/test/fixtures/load-config.ts`:

```ts
export function loadPermissionConfig(name: string): Config {
  // Reads permission-configs/<name>.json, returns parsed Config object
  // suitable for passing into Session.create / agent setup
}

export function loadScannerCorpus(): Array<{
  cmd: string
  expected_patterns: string[]
  expected_always: string[]
  expected_dirs: string[]
}>
```

Tests import from the helper. No inline JSON in test bodies.
