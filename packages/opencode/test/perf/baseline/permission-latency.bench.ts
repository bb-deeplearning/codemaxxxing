import { Effect } from "effect"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { SessionID } from "@/session/schema"
import { benchEffect, type BenchResult } from "../../lib/perf"

// Wave 0 baseline: cost of `Permission.ask` on the two synchronous paths —
// allow-rule resolves immediately (cached), deny-rule fails immediately
// (uncached). The third path (ask-then-user-reply) requires async coordination
// and is excluded; future waves measure it via end-to-end timing.

const sessionID = SessionID.make("ses_bench_perm")

const allowRuleset: Permission.Ruleset = [{ permission: "bench_tool", pattern: "*", action: "allow" }]
const denyRuleset: Permission.Ruleset = [{ permission: "bench_tool", pattern: "*", action: "deny" }]

export const benchPermissionLatency = (): Effect.Effect<
  Record<string, BenchResult>,
  never,
  Permission.Service
> =>
  Effect.gen(function* () {
    const perm = yield* Permission.Service

    const cached = yield* benchEffect(
      { samples: 500, warmup: 50, label: "permission.ask.cached" },
      () =>
        perm
          .ask({
            id: PermissionID.ascending(),
            sessionID,
            permission: "bench_tool",
            patterns: ["call"],
            metadata: {},
            always: [],
            ruleset: allowRuleset,
          })
          .pipe(Effect.catch(() => Effect.void)),
    )

    const uncached = yield* benchEffect(
      { samples: 500, warmup: 50, label: "permission.ask.uncached" },
      () =>
        perm
          .ask({
            id: PermissionID.ascending(),
            sessionID,
            permission: "bench_tool",
            patterns: ["call"],
            metadata: {},
            always: [],
            ruleset: denyRuleset,
          })
          .pipe(Effect.catch(() => Effect.void)),
    )

    return {
      "permission.ask.cached": cached,
      "permission.ask.uncached": uncached,
    }
  })
