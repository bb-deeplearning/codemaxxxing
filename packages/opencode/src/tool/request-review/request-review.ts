import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import * as Tool from "../tool"
import DESCRIPTION from "./request-review.txt"

// request_review — declared review (2026-07-23, rohan's paradigm
// correction). Review is something an agent SAYS, never something the
// system infers from git state: every inference is wrong somewhere
// (commits-exist shouts mid-work, session-idle shouts while the parent
// waits on its children). The tool emits worktree.review.requested for
// the session's own checkout; clients raise the review need on that
// event and ONLY that event (plus orphaned wreckage).
//
// Root-only by locked topology (docs/idea-worktrees.md): children never
// touch main and never summon the human — their checkout rides the
// completion notification to their parent, and the parent integrates
// into ITS worktree. One declaration, one review, one landing.

export const ID = "request_review" as const

export const Parameters = Schema.Struct({
  note: Schema.optional(
    Schema.String.annotate({
      description:
        "One or two sentences for the human reviewer: what this lands and where to look first. Becomes the headline on the review card. Skip pleasantries — lead with the thing that matters.",
    }),
  ),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

export const RequestReviewTool = Tool.define(
  ID,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
        Effect.gen(function* () {
          const session = yield* sessions.get(ctx.sessionID)
          if (session.parentID) {
            return {
              title: "request_review",
              metadata: { error: "subagent" },
              output:
                "you're a subagent — your checkout rides your completion notification to your parent, and integration is their call (they merge your branch into THEIR worktree). finish your task instead of requesting review.",
            }
          }
          // Same layer-dep-avoidance as agent-spawn: Worktree.Service lives
          // outside the tool registry's layer; AppRuntime.runPromise
          // attaches the ambient InstanceRef so the service resolves THIS
          // session's checkout instance.
          const ran = yield* Effect.promise(async () => {
            const [{ AppRuntime }, { Worktree }] = await Promise.all([
              import("@/effect/app-runtime"),
              import("@/worktree"),
            ])
            return AppRuntime.runPromise(
              Effect.gen(function* () {
                const svc = yield* Worktree.Service
                return yield* svc.requestReview({ note: params.note })
              }),
            ).then(
              (value) => ({ ok: true as const, value }),
              (error) => ({
                ok: false as const,
                reason: error instanceof Error ? error.message : String(error),
              }),
            )
          })
          if (!ran.ok) {
            return {
              title: "request_review",
              metadata: { error: "request_failed", reason: ran.reason },
              output: ran.reason,
            }
          }
          const requested = ran.value
          return {
            title: `request_review ${requested.branch ?? requested.name}`,
            metadata: { ...requested },
            output: `review requested for ${requested.branch ?? requested.name}${requested.note ? ` — "${requested.note}"` : ""}. the human decides from here: merge, send back, or discard. keep the checkout as it is until the verdict.`,
          }
        }),
    }
  }),
)

export * as RequestReview from "./request-review"
