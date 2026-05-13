import { Effect } from "effect"
import { AgentControl } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import { SessionID } from "@/session/schema"

// Resolve the canonical AgentPath for the calling session. Used by every
// model-facing multi-agent tool (Wave 8) to derive `currentPath` from
// `Tool.Context.sessionID` before delegating into AgentControl methods that
// require it (`spawnAgent`, `listAgents`, `resolveAgentReference`).
//
// Behavior:
//   - When the registry already knows the session (because it was either
//     spawned via AgentControl or previously registered as root), return the
//     metadata's `agent_path` verbatim.
//   - Otherwise the calling session is the user-facing root. Lazy-register
//     it (idempotent in AgentControl) and return `AgentPath.root()`.
//
// Mirrors codex's repeated pattern across multi_agents_v2 handlers — every
// tool entry point first calls `register_session_root` then derives a path
// from `turn.session_source`. Centralising it here keeps each tool's body
// focused on its own behaviour.
export const currentAgentPath = (
  control: AgentControl.Interface,
  id: SessionID,
): Effect.Effect<AgentPath> =>
  Effect.gen(function* () {
    const meta = yield* control.getAgentMetadata(id)
    if (meta?.agent_path) return meta.agent_path
    yield* control.registerSessionRoot(id)
    return AgentPath.root()
  })

export * as AgentToolContext from "./current-path"
