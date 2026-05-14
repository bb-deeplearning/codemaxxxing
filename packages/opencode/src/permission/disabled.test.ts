// Wave 2 — `Permission.disabled` SHELL_TOOLS group test. Mirrors the
// existing EDIT_TOOLS pattern so saved `permission.bash: { "*": "deny" }`
// transparently strips the legacy `bash` tool AND the new `exec_command`
// + `write_stdin` IDs from the model-visible tool list.
//
// Reference: PERMISSION_MAPPING.md § "Post-Wave-2 mapping (bash group)" and
// INTEGRATION_INVARIANTS.md § `permission-bash-deny-hides-exec-and-stdin-from-tool-list`.

import { describe, expect, test } from "bun:test"
import { Permission, SHELL_TOOLS } from "./index"

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
})
