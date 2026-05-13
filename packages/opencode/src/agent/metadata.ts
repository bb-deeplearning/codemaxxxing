import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { AgentPath } from "./agent-path"

// Per-agent metadata held by the AgentRegistry. Ported from codex's
// `AgentMetadata` (codex-rs/core/src/agent/registry.rs:36-42). All fields are
// optional so the same shape covers every life stage:
//
//   - Reserved-but-uncommitted slot      → only `agent_path` is set
//   - Live spawned agent                 → at minimum `agent_id`; usually all
//                                          of `agent_path`, `agent_nickname`,
//                                          `agent_role` are set too
//   - Root entry registered explicitly   → `agent_id` + `agent_path` (root)
//
// `last_task_message` is filled in by the runLoop after each turn so the
// `list_agents` tool surface can show what each sibling is currently doing.

export class AgentMetadata extends Schema.Class<AgentMetadata>("AgentMetadata")({
  agent_id: Schema.optional(SessionID),
  agent_path: Schema.optional(AgentPath),
  agent_nickname: Schema.optional(Schema.String),
  agent_role: Schema.optional(Schema.String),
  last_task_message: Schema.optional(Schema.String),
}) {}
