import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Server } from "./server"

// The effect-httpapi backend served every route EXCEPT inbound websockets:
// createFetch never handed Bun.serve a websocket handler, so
// /pty/:ptyID/connect answered 400 to every upgrade (found live 2026-08-07;
// the desktop terminal pane was the only caller and nobody noticed). These
// tests pin the composite-dispatch fix in server.ts (createHttpApi) end to
// end: a REAL listen, a REAL pty over REST, a REAL websocket — open, replay
// meta frame, echo round trip, and the REST surface staying on the effect
// router underneath.

process.env.OPENCODE_EXPERIMENTAL_HTTPAPI = "true"

let listener: Awaited<ReturnType<typeof Server.listen>>
let base: string

beforeAll(async () => {
  listener = await Server.listen({ port: 0, hostname: "127.0.0.1" })
  base = `http://127.0.0.1:${listener.port}`
})

afterAll(async () => {
  await listener?.stop(true)
})

const createPty = async () => {
  const res = await fetch(`${base}/pty`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "ws-test" }),
  })
  expect(res.status).toBe(200)
  const info = (await res.json()) as { id: string }
  expect(info.id).toStartWith("pty_")
  return info.id
}

describe("httpapi pty connect websocket", () => {
  test("upgrade completes, meta frame arrives, echo round-trips", async () => {
    if (process.platform === "win32") return
    const id = await createPty()

    const ws = new WebSocket(`ws://127.0.0.1:${listener.port}/pty/${id}/connect?cursor=0`)
    ws.binaryType = "arraybuffer"

    let meta: number | undefined
    let live = ""
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true)
      ws.onerror = () => resolve(false)
      ws.onclose = () => resolve(false)
      setTimeout(() => resolve(false), 5000)
    })
    expect(opened).toBe(true)

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        live += event.data
        return
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer)
      if (bytes[0] === 0) {
        meta = JSON.parse(new TextDecoder().decode(bytes.slice(1))).cursor
      }
    }

    const deadline = Date.now() + 5000
    while (meta === undefined && Date.now() < deadline) {
      await Bun.sleep(25)
    }
    expect(typeof meta).toBe("number")

    ws.send("echo WS-FIX-$((2*21))\r")
    const echoDeadline = Date.now() + 6000
    while (!live.includes("WS-FIX-42") && Date.now() < echoDeadline) {
      await Bun.sleep(25)
    }
    expect(live).toContain("WS-FIX-42")

    ws.close()
    await fetch(`${base}/pty/${id}`, { method: "DELETE" })
  }, 20000)

  test("connect on a missing pty refuses the upgrade", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${listener.port}/pty/pty_does_not_exist/connect`)
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true)
      ws.onerror = () => resolve(false)
      ws.onclose = () => resolve(false)
      setTimeout(() => resolve(false), 5000)
    })
    expect(opened).toBe(false)
  }, 10000)

  test("the REST pty surface still rides the effect router", async () => {
    const id = await createPty()
    const list = await fetch(`${base}/pty`)
    expect(list.status).toBe(200)
    const items = (await list.json()) as { id: string }[]
    expect(items.some((p) => p.id === id)).toBe(true)
    const del = await fetch(`${base}/pty/${id}`, { method: "DELETE" })
    expect(del.status).toBe(200)
  }, 10000)
})
