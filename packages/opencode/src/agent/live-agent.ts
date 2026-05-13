import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { AgentMetadata } from "./metadata"
import { AgentStatus } from "./status"

// LiveAgent is the value returned by `AgentControl.spawnAgent` and the unit
// returned by every read API that hands a single live agent back to the
// caller. Ported from codex's `LiveAgent` (codex-rs/core/src/agent/control.rs:60-65).
//
// Schema.Class so consumers can construct, decode, and encode the same shape;
// equivalent to codex's `#[derive(Clone, Debug)]` on a struct of three fields.

export class LiveAgent extends Schema.Class<LiveAgent>("LiveAgent")({
  thread_id: SessionID,
  metadata: AgentMetadata,
  status: AgentStatus,
}) {}
