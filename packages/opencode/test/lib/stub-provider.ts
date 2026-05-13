import { Duration, Effect, Layer, Schema, Stream } from "effect"
import { LLM } from "@/session/llm"

export interface StubScript {
  readonly events?: ReadonlyArray<LLM.Event>
  readonly latencyMs?: number
}

const asEvent = (value: unknown): LLM.Event => value as unknown as LLM.Event

const stubFinishStep = (): LLM.Event =>
  asEvent({
    type: "finish-step",
    finishReason: "stop",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    },
    response: { id: "stub", modelId: "stub-model", timestamp: new Date() },
  })

const stubFinish = (): LLM.Event =>
  asEvent({
    type: "finish",
    finishReason: "stop",
    totalUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    },
  })

const defaultEvents = (): ReadonlyArray<LLM.Event> => [stubFinishStep(), stubFinish()]

export const stubProvider = (script?: StubScript): Layer.Layer<LLM.Service> =>
  Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      stream: () => {
        const events = script?.events ?? defaultEvents()
        const base: Stream.Stream<LLM.Event, unknown> = Stream.fromIterable(events)
        if (script?.latencyMs && script.latencyMs > 0) {
          const ms = script.latencyMs
          return base.pipe(Stream.tap(() => Effect.sleep(Duration.millis(ms))))
        }
        return base
      },
    }),
  )

export class NetworkCalledError extends Schema.TaggedErrorClass<NetworkCalledError>()(
  "NetworkCalledError",
  {
    count: Schema.Number,
    sample: Schema.String,
  },
) {
  override get message() {
    return `Stub guard detected ${this.count} unexpected network call(s); first: ${this.sample}`
  }
}

interface NetworkGuard {
  count: number
  first: string
  original: typeof globalThis.fetch
}

let activeGuard: NetworkGuard | undefined

export interface NoNetworkGuardHandle {
  count(): number
  restore(): void
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

export function installNoNetworkGuard(): NoNetworkGuardHandle {
  if (activeGuard) {
    const guard = activeGuard
    return {
      count: () => guard.count,
      restore: () => restoreGuard(guard),
    }
  }
  const guard: NetworkGuard = { count: 0, first: "", original: globalThis.fetch }
  const proxy = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    guard.count += 1
    const url = urlOf(input)
    if (!guard.first) guard.first = url
    return guard.original(input, init)
  }
  // `typeof fetch` requires a `preconnect` static; mirror it so the proxy
  // remains a structural drop-in for any code that calls `fetch.preconnect`.
  Object.defineProperty(proxy, "preconnect", {
    value: (...args: Parameters<typeof globalThis.fetch.preconnect>) => guard.original.preconnect(...args),
  })
  globalThis.fetch = proxy as unknown as typeof fetch
  activeGuard = guard
  return {
    count: () => guard.count,
    restore: () => restoreGuard(guard),
  }
}

function restoreGuard(guard: NetworkGuard): void {
  if (activeGuard !== guard) return
  globalThis.fetch = guard.original
  activeGuard = undefined
}

export const assertNoNetworkCalls = (): Effect.Effect<void, NetworkCalledError> =>
  Effect.gen(function* () {
    if (!activeGuard || activeGuard.count === 0) return
    yield* new NetworkCalledError({ count: activeGuard.count, sample: activeGuard.first })
  })
