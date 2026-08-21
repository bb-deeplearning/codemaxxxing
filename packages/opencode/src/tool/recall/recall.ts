import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import type { MessageV2 } from "@/session/message-v2"
import * as Tool from "../tool"
import DESCRIPTION from "./recall.txt"

// recall — pull-based escape hatch for compacted history. Compaction
// summarises old turns and stamps `state.time.compacted` on old tool parts,
// after which message-v2 renders them to the model as "[Old tool result
// content cleared]" (message-v2.ts:917-919) — but the row in sqlite still
// holds every byte of the original output. This tool searches the stored
// rows, so a detail the context dropped can still be pulled back.

export const ID = "recall" as const
export const PermissionKey = "recall" as const

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20
const EXCERPT_CHARS = 700
const PRUNED_MARKER = "[recovered from pruned tool output]"

export const Parameters = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(2)).annotate({
    description:
      "What to look for, case-insensitive. Every whitespace-separated term must appear in an excerpt for it to match, so start with something distinctive (an error code, a file path, a flag) and broaden if nothing comes back.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT }))).annotate({
    description: `Maximum number of excerpts to return. Defaults to ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`,
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

// Everything a tool part carries that the model may have seen: the input it
// was called with plus whatever it produced. Pending and running calls only
// have the input.
const toolText = (state: MessageV2.ToolState) => {
  const input = JSON.stringify(state.input)
  if (state.status === "completed") return [input, state.output].join("\n")
  if (state.status === "error") return [input, state.error].join("\n")
  return input
}

const searchable = (messages: MessageV2.WithParts[]) =>
  messages.flatMap((msg) =>
    msg.parts.flatMap((part) => {
      const base = { messageID: msg.info.id, role: msg.info.role }
      if (part.type === "text")
        return [
          {
            ...base,
            part: "text",
            time: part.time?.start ?? msg.info.time.created,
            pruned: false,
            text: part.text,
          },
        ]
      if (part.type === "reasoning")
        return [{ ...base, part: "reasoning", time: part.time.start, pruned: false, text: part.text }]
      if (part.type !== "tool") return []
      return [
        {
          ...base,
          part: `tool:${part.tool}`,
          time: part.state.status === "pending" ? msg.info.time.created : part.state.time.start,
          pruned: part.state.status === "completed" && part.state.time.compacted !== undefined,
          text: toolText(part.state),
        },
      ]
    }),
  )

const occurrences = (haystack: string, term: string) => haystack.split(term).length - 1

const excerpt = (text: string, index: number) => {
  // Centre the window on the hit, sliding back off the end so a match in the
  // last few hundred characters still returns a full window of context.
  const centred = Math.max(0, index - Math.floor(EXCERPT_CHARS / 2))
  const start = Math.min(centred, Math.max(0, text.length - EXCERPT_CHARS))
  const end = Math.min(text.length, start + EXCERPT_CHARS)
  return [start > 0 ? "..." : "", text.slice(start, end).trim(), end < text.length ? "..." : ""].join("")
}

export const RecallTool = Tool.define(
  ID,
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: PermissionKey,
            patterns: [params.query],
            always: ["*"],
            metadata: { query: params.query },
          })

          const messages = yield* sessions.messages({ sessionID: ctx.sessionID })
          const searched = searchable(messages)
          // AND across terms: a candidate matches only when every term is
          // present. Score is the total number of term occurrences, so the
          // densest hits float to the top; ties break newest-first.
          const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean)
          const hits = searched
            .flatMap((item) => {
              const lower = item.text.toLowerCase()
              const found = terms.map((term) => ({ index: lower.indexOf(term), count: occurrences(lower, term) }))
              if (found.length === 0 || found.some((entry) => entry.index < 0)) return []
              return [
                {
                  ...item,
                  score: found.reduce((total, entry) => total + entry.count, 0),
                  first: Math.min(...found.map((entry) => entry.index)),
                },
              ]
            })
            .sort((a, b) => b.score - a.score || b.time - a.time)

          if (hits.length === 0)
            return {
              title: params.query,
              metadata: { query: params.query, matches: 0, returned: 0, pruned: 0, searched: searched.length },
              output: [
                `No matches for "${params.query}" in this session's history (searched ${searched.length} parts across ${messages.length} messages).`,
                "Every term has to appear in the same excerpt. Try fewer terms, or one distinctive term like an error code, file name, or command.",
              ].join("\n"),
            }

          const limit = params.limit ?? DEFAULT_LIMIT
          const selected = hits.slice(0, limit)

          return {
            title: params.query,
            metadata: {
              query: params.query,
              matches: hits.length,
              returned: selected.length,
              pruned: selected.filter((hit) => hit.pruned).length,
              searched: searched.length,
            },
            output: [
              `Found ${hits.length} match${hits.length === 1 ? "" : "es"} in this session's history${
                hits.length > selected.length ? `, showing the top ${selected.length}` : ""
              }.`,
              ...selected.map((hit, index) =>
                [
                  "",
                  `${index + 1}. ${hit.messageID} | ${hit.role} | ${hit.part} | ${new Date(hit.time).toISOString()}`,
                  ...(hit.pruned ? [PRUNED_MARKER] : []),
                  excerpt(hit.text, hit.first),
                ].join("\n"),
              ),
            ].join("\n"),
          }
        }),
    }
  }),
)

export * as Recall from "./recall"
