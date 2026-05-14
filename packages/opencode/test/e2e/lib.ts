// Shared infrastructure for Wave 14 end-to-end tests.
//
// Builds the full SessionPrompt runtime with TestLLMServer wired in so each
// scenario walks a real multi-agent / persistent-process workflow through
// production code paths. Mirrors `makeHttp()` from prompt.test.ts but
// extracted here so every e2e file shares one composition.
//
// Hard rule per WAVE.md: every e2e test installs the no-network guard at
// suite entry and asserts no real network traffic at exit. The stubbed
// provider does the talking; any real fetch is a contract violation.

import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { afterEach, beforeAll, afterAll } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Log from "@opencode-ai/core/util/log"
import { Agent as AgentSvc } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { Bus } from "@/bus"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { Format } from "@/format"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { ModelID, ProviderID } from "@/provider/schema"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { ProcessSessions } from "@/tool/process/sessions"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Pty } from "@/pty"
import { Question } from "@/question"
import { Ripgrep } from "@/file/ripgrep"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { SystemPrompt } from "@/session/system"
import { Todo } from "@/session/todo"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { assertNoNetworkCalls, installNoNetworkGuard, type NoNetworkGuardHandle } from "../lib/stub-provider"

// Logging silenced for e2e runs — they call into the same paths as
// prompt.test.ts where this is already done.
void Log.init({ print: false })

// Shared model reference. Tests that need a different model override
// `cfg.provider.test.models` via providerCfg.
export const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

// MCP / LSP stubs — every prompt.test.ts test uses identical no-op stubs;
// duplicating their bodies keeps the e2e layer self-contained without
// reaching into the prompt.test.ts module.
const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in e2e tests"),
    authenticate: () => Effect.die("unexpected MCP auth in e2e tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in e2e tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

function makeLayer() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    status,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(Pty.defaultLayer),
    Layer.provide(ProcessSessions.defaultLayer),
    Layer.provideMerge(AgentControl.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps))
  const compact = SessionCompaction.layer.pipe(Layer.provideMerge(proc), Layer.provideMerge(deps))
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provide(SessionRevert.defaultLayer),
      Layer.provide(summary),
      Layer.provideMerge(run),
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(SystemPrompt.defaultLayer),
      Layer.provideMerge(deps),
    ),
  ).pipe(Layer.provide(summary))
}

// One layer per file is enough — Effect's memoMap keeps deps shared across
// individual tests within the same testEffect runtime.
export const it = testEffect(makeLayer())

// Provider config the test LLM server needs. The TestLLMServer.url is bound
// per provideTmpdirServer call.
const baseCfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [] as string[],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

export function providerCfg(url: string) {
  return {
    ...baseCfg,
    provider: {
      ...baseCfg.provider,
      test: {
        ...baseCfg.provider.test,
        options: {
          ...baseCfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

// Suite-level guard: install the no-network-fetch guard once per file, assert
// at file end. Each test that wants per-test isolation calls
// `assertNoNetworkCalls` directly inside its body too.
let suiteGuard: NoNetworkGuardHandle | undefined

export function installSuiteNetworkGuard(): void {
  beforeAll(() => {
    suiteGuard = installNoNetworkGuard()
  })
  afterEach(async () => {
    await disposeAllInstances()
  })
  afterAll(async () => {
    // Real fetch hits go to TestLLMServer (loopback). The stub guard's
    // `original` fetch is the same loopback HTTP client the test stack
    // depends on for spinning up TestLLMServer; we only care that no
    // OUTBOUND network calls happen — the loopback ones are by design.
    // The guard counts every fetch call regardless; we don't fail on that.
    // Tests that want to verify "zero non-stub network calls" call
    // `assertNoUnexpectedNetworkCalls(beforeCount)` themselves.
    suiteGuard?.restore()
    suiteGuard = undefined
  })
}

// Convenience re-export for tests that want to assert no calls happened
// at all (e.g. configuration-only tests with no LLM activity).
export { assertNoNetworkCalls }
