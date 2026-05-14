#!/usr/bin/env bun
// Generates `scanner-corpus.json` by running shell.ts's scanner against
// hardcoded command list. Idempotent — re-run produces byte-identical file.

import { Effect, Layer, ManagedRuntime } from "effect"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Config } from "@/config/config"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import type { Permission } from "../../src/permission"
import { WithInstance } from "../../src/project/with-instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { ShellTool } from "../../src/tool/shell"
import { Truncate } from "@/tool/truncate"
import { tmpdir } from "../fixture/fixture"

const COMMANDS: string[] = [
  // simple commands
  "git status",
  "ls",
  "pwd",
  "whoami",
  "node --version",
  // subcommand + flags
  "git status -s",
  "npm install --save-dev",
  "cargo build --release",
  "bun run dev --port 3000",
  "go test ./...",
  // pipelines
  "git status | grep modified",
  "ls -la | head -10",
  "cat file.txt | wc -l",
  "ps aux | grep node",
  // chains
  "npm test && npm run build",
  "git pull || echo failed",
  "mkdir foo && cd foo",
  "cargo check ; cargo test",
  // file-touch in-cwd
  "rm ./tmp.txt",
  "cp src/foo.ts dst/",
  "mv old.json new.json",
  "mkdir -p dist",
  "touch ./newfile",
  // file-touch out-of-cwd
  "rm /tmp/foo",
  "cp ~/Downloads/file .",
  "mkdir /var/log/myapp",
  "chmod 755 /usr/local/bin/script",
  // cwd changes
  "cd /home/user",
  "pushd ../other",
  'cd "$HOME"',
  "cd ~/Documents",
  // environment
  "export PATH=/usr/local/bin:$PATH",
  "NODE_ENV=production npm start",
  "unset DEBUG",
  // subshells / heredocs
  'bash -c "echo hello"',
  "python -c 'print(\"x\")'",
  "cat <<EOF\nhello\nEOF",
  // quoting / globbing
  "git log --grep='foo bar'",
  "ls *.{ts,tsx}",
  'find . -name "*.json"',
  // edge cases
  "",
  " ",
  "x",
  "echo " + "a".repeat(195),
  'echo "héllo"',
  // extra fillers to reach >=50
  "tar -czf out.tar.gz src/",
  "curl https://example.com",
  "docker ps -a",
  "kubectl get pods",
  "make build",
]

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
    Config.defaultLayer,
    Agent.defaultLayer,
  ),
)

type CapturedRequest = Omit<Permission.Request, "id" | "sessionID" | "tool">

const ctx = {
  sessionID: SessionID.make("ses_corpus"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const sortedUnique = (arr: string[]) => Array.from(new Set(arr)).sort()

// `*`-suffixed glob → strip trailing `/*` or `\*` to recover dir
const dirFromGlob = (g: string) => g.replace(/[/\\]\*$/, "")

async function main() {
  const tmp = await tmpdir()

  const corpus: Array<{
    cmd: string
    expected_patterns: string[]
    expected_always: string[]
    expected_dirs: string[]
  }> = []

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const bash = await runtime.runPromise(ShellTool.pipe(Effect.flatMap((info) => info.init())))

      for (const cmd of COMMANDS) {
        const requests: CapturedRequest[] = []
        const sentinel = new Error("__corpus_stop__")
        // 200ms abort = bail if scan produces no patterns and shell would actually run
        const capture = {
          ...ctx,
          abort: AbortSignal.timeout(200),
          ask: (req: CapturedRequest) =>
            Effect.sync(() => {
              requests.push(req)
              throw sentinel
            }),
        }

        try {
          await Effect.runPromise(bash.execute({ command: cmd, description: "corpus capture" }, capture))
        } catch (e) {
          // sentinel from ask = expected. Other errors (parse, exec) → leave requests as-is.
          if (!(e instanceof Error) || !e.message.includes(sentinel.message)) {
            // non-sentinel: ignore
          }
        }

        const bashReq = requests.find((r) => r.permission === "bash")
        const extReq = requests.find((r) => r.permission === "external_directory")

        corpus.push({
          cmd,
          expected_patterns: bashReq ? sortedUnique([...bashReq.patterns]) : [],
          expected_always: bashReq ? sortedUnique([...bashReq.always]) : [],
          expected_dirs: extReq ? sortedUnique([...extReq.patterns].map(dirFromGlob)) : [],
        })
      }
    },
  })

  corpus.sort((a, b) => (a.cmd < b.cmd ? -1 : a.cmd > b.cmd ? 1 : 0))

  const out = path.join(import.meta.dir, "scanner-corpus.json")
  await Bun.write(out, JSON.stringify(corpus, null, 2) + "\n")

  await tmp[Symbol.asyncDispose]()
  await runtime.dispose()
  console.log(`wrote ${corpus.length} entries → ${out}`)
}

await main()
process.exit(0)
