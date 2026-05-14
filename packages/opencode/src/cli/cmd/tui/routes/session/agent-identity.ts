import { RGBA } from "@opentui/core"
import { Locale } from "@/util/locale"

// Shared identity helpers for the multi-agent v2 system. Used by every
// agent-tool renderer (spawn/wait/send/followup/list/close) and by the
// MailboxMessage chrome so the user sees the same display string and
// instance-stable color for an agent everywhere it appears.
//
// Design note: the multi-agent v2 system has THREE address spaces for an
// agent — its SessionID (UUID), its AgentPath (`/root/<leaf>` hierarchical
// address), and its nickname (a single human-friendly word from the 101-name
// pool). Each renderer has different bits of these:
//
//   - spawn_agent: receives nickname + path + agent_type from metadata/input
//   - send_message / followup_task / close_agent: receives a target STRING
//     (relative or canonical path, or an external reference) from input —
//     no nickname unless we look it up in the registry, which we don't
//   - mailbox messages: receive metadata.from (an AgentPath string) — no
//     nickname unless we look it up
//   - list_agents: receives a list of agent_name strings (paths) from output
//
// So `formatAgentIdentity` accepts whichever bits the caller has and
// produces the best display label it can. `pickPaletteColor` hashes the
// strongest stable identifier (nickname > path > target) so the same agent
// is the same color everywhere.

export interface AgentIdentity {
  // Nickname from the registry pool (e.g. "lovelace"). Lowercase.
  // When present, becomes the primary handle in the UI.
  readonly nickname?: string
  // Subagent type as the model sees it (e.g. "explore", "general").
  // Renders as a muted suffix after the nickname.
  readonly agent_type?: string
  // Canonical AgentPath like "/root/git_historian". Used as a display
  // fallback when nickname is unknown, and as the color hash key when
  // nickname is unknown.
  readonly path?: string
}

// Pure: titlecase a nickname. "lovelace" → "Lovelace". Returns undefined
// when the input is undefined / empty so callers can short-circuit.
export function displayNickname(nickname: string | undefined): string | undefined {
  if (!nickname) return undefined
  return Locale.titlecase(nickname)
}

// Pure: strip the leading slash of a canonical AgentPath for display.
// "/root/git_historian" → "root/git_historian". The leading slash is a
// model-facing detail; humans read the path without it.
export function displayPath(path: string | undefined): string | undefined {
  if (!path) return undefined
  return path.startsWith("/") ? path.slice(1) : path
}

// Pure: produce the short agent label that appears in tool rows + chrome.
//   - nickname + agent_type → "Lovelace explore"
//   - nickname only         → "Lovelace"
//   - path only             → "root/git_historian"
//   - empty identity        → "agent"
export function formatAgentIdentity(i: AgentIdentity): string {
  const nick = displayNickname(i.nickname)
  if (nick && i.agent_type) return `${nick} ${i.agent_type}`
  if (nick) return nick
  const p = displayPath(i.path)
  if (p) return p
  return "agent"
}

// Pure: 32-bit FNV-1a hash. Used to pick a palette index per nickname.
// Cryptographic strength is not required — we just need stability across
// renders (same input → same output) and reasonable distribution across
// the small palette so two siblings don't collide too often.
function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

// Pure: pick a palette color stable per identity. Hash key preference is
// nickname > path > "agent". A nickname is the most discriminating signal
// (the registry pool guarantees uniqueness within a tree), so two siblings
// of the same agent_type still get distinct colors.
//
// Empty palette throws — callers (mount wrappers) build the palette from
// theme colors, which always has at least one entry. The throw is a load-
// bearing assertion: a silent fallback would mask a theme misconfig.
export function pickPaletteColor(palette: readonly RGBA[], i: AgentIdentity): RGBA {
  if (palette.length === 0) throw new Error("pickPaletteColor: empty palette")
  const key = i.nickname ?? i.path ?? "agent"
  const idx = hashString(key) % palette.length
  return palette[idx]!
}

// Re-export hashString as a named test hook so the FNV implementation can
// be tested directly. Not part of the public surface — consumers should use
// pickPaletteColor.
export const _hashString = hashString

export * as AgentIdentity from "./agent-identity"
