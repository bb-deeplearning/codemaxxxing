import { Effect, Schema } from "effect"

// AgentPath is a hierarchical handle into the multi-agent tree, ported from
// codex's `protocol::agent_path::AgentPath` (codex-rs/protocol/src/agent_path.rs).
// The tree is rooted at "/root"; segments are lowercase ASCII letters, digits,
// and underscores. Codex's parser treats "." and ".." as reserved at the
// segment level; we keep that rule when validating leaves but reinterpret ".."
// inside `resolve` as Unix-style upward traversal so callers can express
// "sibling of current" without juggling parents themselves. Traversal that
// would escape root is rejected.

const ROOT_LITERAL = "/root"
const ROOT_SEGMENT = "root"
const SEGMENT_PATTERN = /^[a-z0-9_]+$/

const validateSegment = (segment: string): string | null => {
  if (segment === "") return "segment must not be empty"
  if (segment === "." || segment === "..") return `segment '${segment}' is reserved`
  if (segment === ROOT_SEGMENT) return "segment 'root' is reserved"
  if (segment.includes("/")) return "segment must not contain a slash"
  if (!SEGMENT_PATTERN.test(segment)) {
    return "segment must use only lowercase letters, digits, and underscores"
  }
  return null
}

const validateAbsolutePath = (path: string): string | null => {
  if (path === "") return "path must not be empty"
  if (!path.startsWith("/")) return "path must start with '/'"
  if (path === ROOT_LITERAL) return null
  if (!path.startsWith(`${ROOT_LITERAL}/`)) return "path must be rooted at '/root'"
  if (path.endsWith("/")) return "path must not end with a trailing slash"
  // Skip "/root/" prefix; validate every remaining segment.
  const tail = path.slice(ROOT_LITERAL.length + 1)
  for (const segment of tail.split("/")) {
    const reason = validateSegment(segment)
    if (reason !== null) return reason
  }
  return null
}

export class AgentPathInvalidError extends Schema.TaggedErrorClass<AgentPathInvalidError>()(
  "AgentPathInvalidError",
  {
    input: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid agent path '${this.input}': ${this.reason}`
  }
}

const _AgentPath = Schema.String.check(
  Schema.makeFilter<string>((s) => validateAbsolutePath(s) ?? undefined),
).pipe(Schema.brand("AgentPath"))

export type AgentPath = typeof _AgentPath.Type

const ROOT = _AgentPath.make(ROOT_LITERAL)

const isRoot = (p: AgentPath): boolean => (p as string) === ROOT_LITERAL

const parent = (p: AgentPath): AgentPath | null => {
  if (isRoot(p)) return null
  const str = p as string
  return _AgentPath.make(str.slice(0, str.lastIndexOf("/")))
}

const from = (input: string): Effect.Effect<AgentPath, AgentPathInvalidError> => {
  const reason = validateAbsolutePath(input)
  if (reason !== null) return Effect.fail(new AgentPathInvalidError({ input, reason }))
  return Effect.succeed(_AgentPath.make(input))
}

const join = (p: AgentPath, leaf: string): Effect.Effect<AgentPath, AgentPathInvalidError> => {
  const reason = validateSegment(leaf)
  if (reason !== null) return Effect.fail(new AgentPathInvalidError({ input: leaf, reason }))
  return Effect.succeed(_AgentPath.make(`${p as string}/${leaf}`))
}

const resolve = (
  current: AgentPath,
  reference: string,
): Effect.Effect<AgentPath, AgentPathInvalidError> => {
  if (reference === "") {
    return Effect.fail(new AgentPathInvalidError({ input: reference, reason: "reference must not be empty" }))
  }
  // Absolute reference — defer to the standard absolute-path validator.
  if (reference.startsWith("/")) return from(reference)
  if (reference.endsWith("/")) {
    return Effect.fail(
      new AgentPathInvalidError({ input: reference, reason: "reference must not end with a trailing slash" }),
    )
  }
  let result = current
  for (const segment of reference.split("/")) {
    if (segment === "..") {
      const par = parent(result)
      if (par === null) {
        return Effect.fail(
          new AgentPathInvalidError({ input: reference, reason: "reference escapes root" }),
        )
      }
      result = par
      continue
    }
    const reason = validateSegment(segment)
    if (reason !== null) return Effect.fail(new AgentPathInvalidError({ input: segment, reason }))
    result = _AgentPath.make(`${result as string}/${segment}`)
  }
  return Effect.succeed(result)
}

export const AgentPath = Object.assign(_AgentPath, {
  ROOT,
  root: () => ROOT,
  isRoot,
  parent,
  join,
  resolve,
  from,
})
