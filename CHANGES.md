# Changes

## 2026-05-15 — replace-bash-task

**Removed from model surface:** `bash` and `task` tools no longer appear
in the model's tool list. `exec_command` + `write_stdin` and the v2
multi-agent tools (`spawn_agent`, `send_message`, `followup_task`,
`wait_agent`, `list_agents`, `close_agent`) are now the only
shell-flavored and agent-spawning surfaces.

**Saved permissions still work.** Rules under `permission.bash: ...`
continue to gate `exec_command` + `write_stdin` (transparent: the
permission key for those tools is now `bash` per the SHELL_TOOLS
group). Rules under `permission.task: ...` continue to gate the v2
multi-agent tools (transparent: the permission key for all six is now
`task` per the MULTI_AGENT_TOOLS group, mirroring EDIT_TOOLS' collapse
of `edit` / `write` / `apply_patch` onto permission key `edit`).
No config migration required.

**`tools: { bash: false }` and `tools: { task: false }`** now hide every
member of their respective group from the model's tool list. Pre-campaign
they hid only the literally-named tool.

**Plugin migration:**

- Plugins hooking `tool.definition` for legacy IDs `bash` or `task`
  continue to fire via a bridge in `tool/registry.ts:407-421`.
  Mutations land on `exec_command` / `spawn_agent`'s description.
  No code change required.
- Plugins hooking `tool.execute` (or `tool.execute.before` /
  `tool.execute.after`) for legacy IDs `bash` or `task` must migrate
  to the new IDs explicitly. Execution semantics differ between the
  pairs: one-shot vs persistent for shell, single-shot vs
  concurrent-interactive for agents — bridging would break expectations.

**Custom prompts:** if your custom agent prompts mention "the bash tool"
or "the task tool" by name, update them to reference `exec_command` /
`spawn_agent`. The model self-corrects in most cases.

**Saved per-friend permission keys are silently inert:** rules under
`permission.spawn_agent`, `permission.send_message`,
`permission.followup_task`, `permission.wait_agent`,
`permission.list_agents`, `permission.close_agent` no longer match
their tool's per-call asks. Restate the intent under `permission.task`.
This mirrors the existing EDIT_TOOLS behavior since the codebase's
launch (saved `permission.write` rules don't match `write.ts`'s asks
either; those land under `permission.edit`).

**`shell.ts` and `task.ts` are not deleted.** Both remain importable
and runnable from internal code. They are simply no longer advertised
to the model.

Spec: [`specs/replace-bash-task.md`](./specs/replace-bash-task.md).
Campaign archive: `.wave/campaigns/replace-bash-task-2026-05-15/`.
