import { NonNegativeInt } from "@/util/schema"
import { Schema } from "effect"
import { AgentPath } from "./agent-path"

// Cross-agent message envelope, ported from codex's `protocol::InterAgentCommunication`
// (codex-rs/protocol/src/protocol.rs ~ "Op::InterAgentCommunication"). Codex
// carries a richer `Vec<UserInput>` payload (text/image/etc); for v0 we ship
// plain text via `content`, and reserve `items` for future structured payloads
// without breaking the wire format.

export class InterAgentCommunication extends Schema.Class<InterAgentCommunication>(
  "InterAgentCommunication",
)({
  author: AgentPath,
  recipient: AgentPath,
  content: Schema.String,
  trigger_turn: Schema.Boolean,
  sent_at: NonNegativeInt,
  items: Schema.optional(Schema.Array(Schema.Unknown)),
}) {}
