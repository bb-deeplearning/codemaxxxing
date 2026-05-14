// Fuzz helpers for Wave 1's property test (`scanner-handles-1000-fuzz-inputs-without-crash`).
// Generates random bash commands from a small grammar drawn from the
// FIXTURES.md scanner-corpus categories. Seeded `Math.random` proxy so
// failing seeds reproduce.

const COMMANDS: ReadonlyArray<string> = [
  "git status",
  "git log",
  "git diff",
  "git pull",
  "git push",
  "ls",
  "ls -la",
  "pwd",
  "whoami",
  "node",
  "npm install",
  "npm test",
  "npm run build",
  "bun run dev",
  "cargo build",
  "cargo test",
  "go build",
  "go test",
  "make",
  "kubectl get pods",
  "docker ps",
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "cat",
  "echo",
  "head",
  "tail",
  "grep",
  "find",
  "wc",
  "ps",
]

const ARGS: ReadonlyArray<string> = [
  "foo.txt",
  "src/index.ts",
  "./tmp",
  "/tmp/x",
  "./build",
  "main",
  "origin",
  "-v",
  "--quiet",
  "-r",
  "*.json",
  "test/",
  "node_modules",
  '"hello world"',
  "~/Documents",
]

const PIPES: ReadonlyArray<string> = ["|", "&&", "||", ";"]

export interface Rng {
  (): number
}

// Mulberry32 — small fast 32-bit PRNG. Reproducible across runs given the seed.
export function makeRng(seed: number): Rng {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rng: Rng, arr: ReadonlyArray<T>): T => arr[Math.floor(rng() * arr.length)]

function singleCommand(rng: Rng): string {
  const head = pick(rng, COMMANDS)
  const argCount = Math.floor(rng() * 4) // 0..3 args
  if (argCount === 0) return head
  const args = Array.from({ length: argCount }, () => pick(rng, ARGS))
  return `${head} ${args.join(" ")}`
}

export function generateCommand(rng: Rng): string {
  // 60% single command, 30% chain/pipe, 10% empty/whitespace edges
  const r = rng()
  if (r < 0.1) return r < 0.05 ? "" : "  "
  if (r < 0.4) {
    const a = singleCommand(rng)
    const b = singleCommand(rng)
    return `${a} ${pick(rng, PIPES)} ${b}`
  }
  return singleCommand(rng)
}

// Set equality helper for the deterministic-on-rerun assertion.
export function scanEqual(
  a: { patterns: Set<string>; always: Set<string>; dirs: Set<string> },
  b: { patterns: Set<string>; always: Set<string>; dirs: Set<string> },
): boolean {
  const setEq = (x: Set<string>, y: Set<string>) => {
    if (x.size !== y.size) return false
    for (const v of x) if (!y.has(v)) return false
    return true
  }
  return setEq(a.patterns, b.patterns) && setEq(a.always, b.always) && setEq(a.dirs, b.dirs)
}
