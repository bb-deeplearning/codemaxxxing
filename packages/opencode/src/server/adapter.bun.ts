import type { Hono } from "hono"
import { createBunWebSocket } from "hono/bun"
import type { Adapter, FetchApp, Opts } from "./adapter"

function listen(app: FetchApp, opts: Opts, websocket?: ReturnType<typeof createBunWebSocket>["websocket"]) {
  const start = (port: number) => {
    try {
      if (websocket) {
        return Bun.serve({ fetch: app.fetch, hostname: opts.hostname, idleTimeout: 0, websocket, port })
      }
      return Bun.serve({ fetch: app.fetch, hostname: opts.hostname, idleTimeout: 0, port })
    } catch {
      return
    }
  }
  const server = opts.port === 0 ? (start(4096) ?? start(0)) : start(opts.port)
  if (!server) {
    throw new Error(`Failed to start server on port ${opts.port}`)
  }
  if (!server.port) {
    throw new Error(`Failed to resolve server address for port ${opts.port}`)
  }
  return {
    port: server.port,
    stop(close?: boolean) {
      return Promise.resolve(server.stop(close))
    },
  }
}

export const adapter: Adapter = {
  create(app: Hono) {
    const ws = createBunWebSocket()
    return {
      upgradeWebSocket: ws.upgradeWebSocket,
      listen: (opts) => Promise.resolve(listen(app, opts, ws.websocket)),
    }
  },
  createFetch(app) {
    return {
      listen: (opts) => Promise.resolve(listen(app, opts)),
    }
  },
  createFetchWithWebSocket(app, _wsApp) {
    // The side-app's routes call upgradeWebSocket, which reads the Bun
    // server out of c.env — the composite fetch must forward Bun.serve's
    // second argument for that to hold (see server.ts createHttpApi).
    const ws = createBunWebSocket()
    return {
      upgradeWebSocket: ws.upgradeWebSocket,
      listen: (opts) => Promise.resolve(listen(app, opts, ws.websocket)),
    }
  },
}
