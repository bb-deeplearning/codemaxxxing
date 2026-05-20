// Wave 2 — `Permission.disabled` SHELL_TOOLS group test. Mirrors the
// existing EDIT_TOOLS pattern so saved `permission.bash: { "*": "deny" }`
// transparently strips the legacy `bash` tool AND the new `exec_command`
// + `write_stdin` IDs from the model-visible tool list.
//
// Wave 3 — extends with MULTI_AGENT_TOOLS group: saved `permission.task:
// { "*": "deny" }` strips the legacy `task` tool AND the six v2
// multi-agent tools (`spawn_agent`, `send_message`, `followup_task`,
// `wait_agent`, `list_agents`, `close_agent`) from the model-visible list.
//
// Reference: PERMISSION_MAPPING.md § "Post-Wave-2 mapping (bash group)" +
// § "Post-Wave-3 mapping (task group)" and INTEGRATION_INVARIANTS.md.

import { describe, expect, test } from "bun:test"
import { MULTI_AGENT_TOOLS, Permission, SHELL_TOOLS } from "./index"

describe("Permission.disabled", () => {
  test("SHELL_TOOLS exports bash, exec_command, write_stdin", () => {
    expect(SHELL_TOOLS).toEqual(["bash", "exec_command", "write_stdin"])
  })

  test("groups SHELL_TOOLS under bash key — wildcard deny strips all three", () => {
    const result = Permission.disabled(
      ["bash", "exec_command", "write_stdin", "read"],
      [{ permission: "bash", pattern: "*", action: "deny" }],
    )
    expect(result.has("bash")).toBe(true)
    expect(result.has("exec_command")).toBe(true)
    expect(result.has("write_stdin")).toBe(true)
    // Tools outside the group remain unaffected.
    expect(result.has("read")).toBe(false)
  })

  test("EDIT_TOOLS still group under edit key — bash group additions don't regress", () => {
    const result = Permission.disabled(
      ["edit", "write", "apply_patch", "read"],
      [{ permission: "edit", pattern: "*", action: "deny" }],
    )
    expect(result.has("edit")).toBe(true)
    expect(result.has("write")).toBe(true)
    expect(result.has("apply_patch")).toBe(true)
    expect(result.has("read")).toBe(false)
  })

  test("non-wildcard deny does NOT disable the group — only wildcard deny strips", () => {
    // `git push: deny` is a precise rule, not a `* deny`. Tools stay
    // present in the model list; the per-call permission flow handles
    // denial when the model actually invokes that pattern.
    const result = Permission.disabled(
      ["bash", "exec_command", "write_stdin"],
      [{ permission: "bash", pattern: "git push", action: "deny" }],
    )
    expect(result.has("bash")).toBe(false)
    expect(result.has("exec_command")).toBe(false)
    expect(result.has("write_stdin")).toBe(false)
  })

  test("allow rule does not disable", () => {
    const result = Permission.disabled(
      ["bash", "exec_command", "write_stdin"],
      [{ permission: "bash", pattern: "*", action: "allow" }],
    )
    expect(result.size).toBe(0)
  })

  test("empty ruleset returns empty Set", () => {
    const result = Permission.disabled(["bash", "exec_command", "write_stdin", "read"], [])
    expect(result.size).toBe(0)
  })

  test("findLast precedence — later allow overrides earlier deny", () => {
    // Ordered ruleset: [{bash, *, deny}, {bash, *, allow}]. `findLast`
    // walks from end, so allow wins. Tools NOT in the disabled set.
    const result = Permission.disabled(
      ["bash", "exec_command", "write_stdin"],
      [
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "*", action: "allow" },
      ],
    )
    expect(result.size).toBe(0)
  })

  test("MULTI_AGENT_TOOLS exports task + 7 v2 multi-agent IDs in canonical order", () => {
    expect(MULTI_AGENT_TOOLS).toEqual([
      "task",
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "list_agents",
      "close_agent",
      "spawn_pool",
    ])
  })

  test("groups MULTI_AGENT_TOOLS under task key — wildcard deny strips legacy task + all 7 v2 tools", () => {
    const result = Permission.disabled(
      [
        "task",
        "spawn_agent",
        "send_message",
        "followup_task",
        "wait_agent",
        "list_agents",
        "close_agent",
        "spawn_pool",
        "read",
      ],
      [{ permission: "task", pattern: "*", action: "deny" }],
    )
    for (const id of MULTI_AGENT_TOOLS) {
      expect(result.has(id)).toBe(true)
    }
    // Tools outside the group remain unaffected.
    expect(result.has("read")).toBe(false)
  })

  test("non-wildcard task deny does NOT disable the multi-agent group", () => {
    // `explore: deny` is precise, not `*: deny`. Tools stay present in the
    // model list; per-call permission flow handles per-pattern denial.
    const result = Permission.disabled(
      ["task", "spawn_agent", "send_message", "followup_task", "wait_agent", "list_agents", "close_agent", "spawn_pool"],
      [{ permission: "task", pattern: "explore", action: "deny" }],
    )
    for (const id of MULTI_AGENT_TOOLS) {
      expect(result.has(id)).toBe(false)
    }
  })

  test("task allow rule does not disable any multi-agent tool", () => {
    const result = Permission.disabled(
      ["task", "spawn_agent", "send_message", "followup_task", "wait_agent", "list_agents", "close_agent"],
      [{ permission: "task", pattern: "*", action: "allow" }],
    )
    expect(result.size).toBe(0)
  })

  test("SHELL_TOOLS and MULTI_AGENT_TOOLS groups are independent — bash deny doesn't strip multi-agent and vice versa", () => {
    const result = Permission.disabled(
      ["bash", "exec_command", "write_stdin", "task", "spawn_agent", "send_message"],
      [
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "allow" },
      ],
    )
    // SHELL_TOOLS struck.
    for (const id of SHELL_TOOLS) expect(result.has(id)).toBe(true)
    // MULTI_AGENT_TOOLS unaffected (task allow).
    expect(result.has("task")).toBe(false)
    expect(result.has("spawn_agent")).toBe(false)
    expect(result.has("send_message")).toBe(false)
  })

  test("findLast precedence — later task allow overrides earlier task deny", () => {
    const result = Permission.disabled(
      ["task", "spawn_agent", "send_message"],
      [
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "allow" },
      ],
    )
    expect(result.size).toBe(0)
  })
})
