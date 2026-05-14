// Wave 5 — differential test: the substantive prose fragments from
// `tool/shell/shell.txt` (git safety protocol, PR creation flow, file-op
// restriction) must appear VERBATIM (modulo a fixed bash-tool-name → new
// tool-name substitution) inside `tool/process/exec-command.txt` after the
// migration. Same shape for the `task.txt` → `agent-spawn.txt` migration.
//
// Why "verbatim modulo substitution"? The git safety wording in shell.txt
// has been hand-tuned over many iterations — every "NEVER" / "DO NOT" /
// "IMPORTANT" choice is deliberate. Migration rewrites = wave failure.
// The substitution is bounded to tool-name references because the new
// tools (`exec_command`, `spawn_agent`) replace the legacy `bash`/`task`
// in the model's view; everything else stays byte-identical.
//
// The substitution map below also drives the actual content authored into
// `exec-command.txt` so the two files agree byte-for-byte after applying
// the same transform — this is what makes the assertion meaningful.

import { describe, expect, test } from "bun:test"
import { ShellPrompt } from "@/tool/shell/prompt"

// Substitution map: how bash-rendered references become exec_command
// references in the migrated content. Stable; both the test and the
// authored exec-command.txt use this exact list.
//
// Pre-migration `shell.txt` is rendered through ShellPrompt.render which
// substitutes ${toolName}=bash, ${gitCommands}="bash commands",
// ${gitCommandRestriction}="git bash commands". The resulting strings
// then map onto exec_command's voice as below. Order matters — longer
// keys before substrings.
const BASH_TO_EXEC: ReadonlyArray<readonly [string, string]> = [
  // The shell.txt template lines that reach the migration target windows
  // (git safety + PR creation) substitute these patterns under the bash
  // profile. The post-migration form drops the "bash" qualifier from
  // command-noun mentions and renames the tool-name mentions.
  //
  // Order matters: longer keys before shorter substring overlaps.
  ["each using the bash tool", "each using the exec_command tool"],
  ["using the bash tool", "using the exec_command tool"],
  ["the following bash commands", "the following commands"],
  ["besides git bash commands", "besides git commands"],
  ["via the bash tool", "via the exec_command tool"],
]

const adapt = (s: string): string => {
  let out = s
  for (const [from, to] of BASH_TO_EXEC) out = out.replaceAll(from, to)
  return out
}

const LIMITS = { maxLines: 2000, maxBytes: 51200 }

const renderedShell = ShellPrompt.render("bash", "darwin", LIMITS).description

// Markers that delimit the migration target sections in shell.txt.
const GIT_SAFETY_HEADER = "# Committing changes with git"
const PR_CREATION_HEADER = "# Creating pull requests"
const OTHER_OPS_HEADER = "# Other common operations"

function sliceBetween(start: string, end: string | null): string {
  const startIdx = renderedShell.indexOf(start)
  if (startIdx < 0) throw new Error(`marker not found in rendered shell: ${start}`)
  const endIdx = end === null ? renderedShell.length : renderedShell.indexOf(end, startIdx + start.length)
  if (end !== null && endIdx < 0) throw new Error(`end marker not found: ${end}`)
  return renderedShell.slice(startIdx, endIdx).trimEnd()
}

const gitSafetyBlock = sliceBetween(GIT_SAFETY_HEADER, PR_CREATION_HEADER)
const prCreationBlock = sliceBetween(PR_CREATION_HEADER, OTHER_OPS_HEADER)
const otherOpsBlock = sliceBetween(OTHER_OPS_HEADER, null)

// Adapted = what the migrated text in exec-command.txt MUST contain
// verbatim. If the test goes RED, either (a) exec-command.txt was edited
// in a way that lost migrated content, or (b) shell.txt was edited and
// the migration drifted — both are wave failures unless explicitly
// surfaced in NOTES.md.
const adaptedGitSafety = adapt(gitSafetyBlock)
const adaptedPrCreation = adapt(prCreationBlock)
const adaptedOtherOps = adapt(otherOpsBlock)

const execCommandPath = new URL("../../src/tool/process/exec-command.txt", import.meta.url).pathname
const agentSpawnPath = new URL("../../src/tool/agent-spawn/agent-spawn.txt", import.meta.url).pathname
const taskTextPath = new URL("../../src/tool/task.txt", import.meta.url).pathname

describe("Wave 5 — prompt prose migration", () => {
  test("exec_command.txt contains the git safety protocol fragment from shell.txt verbatim (modulo bash → exec_command)", async () => {
    const execText = await Bun.file(execCommandPath).text()
    expect(execText).toContain(adaptedGitSafety)
  })

  test("exec_command.txt contains the PR creation flow fragment from shell.txt verbatim (modulo bash → exec_command)", async () => {
    const execText = await Bun.file(execCommandPath).text()
    expect(execText).toContain(adaptedPrCreation)
  })

  test("exec_command.txt contains the other-common-operations cheat sheet from shell.txt", async () => {
    const execText = await Bun.file(execCommandPath).text()
    expect(execText).toContain(adaptedOtherOps)
  })

  test("exec_command.txt carries the file-op restriction warning that previously lived in shell.txt", async () => {
    // shell.txt's IMPORTANT block: "This tool is for terminal operations
    // like git, npm, docker, etc. DO NOT use it for file operations
    // (reading, writing, editing, searching, finding files) - use the
    // specialized tools for this instead." Post-Wave-4 the model has no
    // bash tool to redirect to, so the warning lives on exec_command —
    // the only shell-flavored surface remaining.
    const execText = await Bun.file(execCommandPath).text()
    expect(execText).toContain("DO NOT use it for file operations")
    expect(execText).toContain("git, npm, docker")
  })

  test("exec_command.txt no longer instructs the model to use bash as an alternative", async () => {
    // WAVE.md gotcha 6: the pre-migration line `Use \`bash\` instead for
    // single commands ...` directs the model to a tool it cannot reach
    // post-Wave-4. The migration MUST drop the cross-reference (or rephrase
    // it to a persistence/one-shot semantic distinction without naming
    // bash). Asserting the dead reference is gone catches a regression
    // where a future edit re-introduces a bash mention.
    const execText = await Bun.file(execCommandPath).text()
    expect(execText).not.toContain("Use `bash` instead")
  })

  test("agent-spawn.txt is unchanged at the eligible-subagent listing seam (describeSpawnAgent appends at runtime)", async () => {
    // No prose migration needed for spawn_agent — task.txt's substantive
    // operational content is already covered in the v2 agent-spawn prose
    // (Mental model / When to delegate / Cost / Limits / fork_turns).
    // The per-subagent enumeration is templated by describeSpawnAgent at
    // runtime per registry.ts:348-361 and asserted in
    // tool-surface-replacement.test.ts § prose-migration-preserves-spawn-agent-eligible-list.
    //
    // This test pins the static-file invariant: agent-spawn.txt does NOT
    // include the literal "Available agent types" header itself (it's
    // appended at render time). If a future edit moves the listing into
    // the static file, both the static and runtime listings would
    // duplicate — the model would see TWO copies. Catch that here.
    const spawnText = await Bun.file(agentSpawnPath).text()
    expect(spawnText).not.toContain("Available agent types and the tools they have access to:")
  })

  test("task.txt is preserved as-is (Wave 5 does not edit the legacy file)", async () => {
    // BACKWARD_COMPAT.md / WAVE.md gotcha 8: task.txt stays as-is for
    // internal callers and plugin shims that may reference it. Wave 5
    // only ADDS to agent-spawn.txt where substantive content needed
    // migrating; in this campaign, NO content is migrated (the v2 prose
    // already covers everything operational). Assert task.txt still has
    // the canonical { agents } templating placeholder so any internal
    // renderer continues to work.
    const taskText = await Bun.file(taskTextPath).text()
    expect(taskText).toContain("{agents}")
  })
})
