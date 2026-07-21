import { SessionID } from "@/session/schema"

type Rule = { method?: string; path: string; exact?: boolean; action: "local" | "forward" }

const RULES: Array<Rule> = [
  { path: "/experimental/workspace", action: "local" },
  { path: "/session/status", action: "forward" },
  { method: "GET", path: "/session", action: "local" },
]

export function isLocalWorkspaceRoute(method: string, path: string) {
  for (const rule of RULES) {
    if (rule.method && rule.method !== method) continue
    const match = rule.exact ? path === rule.path : path === rule.path || path.startsWith(rule.path + "/")
    if (match) return rule.action === "local"
  }
  return false
}

export function getWorkspaceRouteSessionID(url: URL) {
  if (url.pathname === "/session/status") return null

  const id = url.pathname.match(/^\/session\/([^/]+)(?:\/|$)/)?.[1]
  if (!id) return null

  return SessionID.make(id)
}

// Verbs that RUN or steer a session's agent loop. A bare request (no
// ?directory=, no x-opencode-directory) for one of these must land on the
// session's HOME instance, not the receiving process's cwd — the loop runs
// on the instance that receives the POST, and a wrong-cwd lap is the
// dual-lap family's surviving residual (GOTCHAS
// session-runloop-lock-busy-guard-was-per-instance). Reads stay bare on
// purpose: routing a GET by session directory could spawn an instance as
// a side effect.
const SESSION_HOME_VERBS = new Set([
  "message",
  "prompt_async",
  "command",
  "shell",
  "abort",
  "loop",
  "summarize",
  "revert",
  "unrevert",
  "fork",
  "init",
])

export function isSessionHomeRoute(method: string, pathname: string): boolean {
  if (method === "POST") {
    const verb = pathname.match(/^\/session\/[^/]+\/([a-z_]+)$/)?.[1]
    if (verb && SESSION_HOME_VERBS.has(verb)) return true
    // permission replies resolve against the home instance's in-memory ask
    // registry — a bare reply to the default instance is silently eaten
    // (WARN + http 200, the eaten-answer scar).
    return /^\/session\/[^/]+\/permissions\/[^/]+$/.test(pathname)
  }
  if (method === "DELETE") {
    // queued-message unsend: the queue lives on the home instance's loop
    return /^\/session\/[^/]+\/message\/[^/]+$/.test(pathname)
  }
  return false
}

export function workspaceProxyURL(target: string | URL, requestURL: URL) {
  const proxyURL = new URL(target)
  proxyURL.pathname = `${proxyURL.pathname.replace(/\/$/, "")}${requestURL.pathname}`
  proxyURL.search = requestURL.search
  proxyURL.hash = requestURL.hash
  proxyURL.searchParams.delete("workspace")
  return proxyURL
}
