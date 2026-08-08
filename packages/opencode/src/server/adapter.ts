import type { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"

export type FetchApp = {
  fetch(request: Request): Response | Promise<Response>
}

export type Opts = {
  port: number
  hostname: string
}

export type Listener = {
  port: number
  stop: (close?: boolean) => Promise<void>
}

export interface Runtime {
  upgradeWebSocket: UpgradeWebSocket
  listen(opts: Opts): Promise<Listener>
}

export interface Adapter {
  create(app: Hono): Runtime
  createFetch(app: FetchApp): Omit<Runtime, "upgradeWebSocket">
  /** A fetch-backed server (the effect-httpapi router) cannot complete
      websocket upgrades: the effect router is a plain Request→Response
      handler, so Bun.serve never gets websocket handlers and the node
      server never gets an upgrade listener — request.upgrade dies with a
      400 (found live 2026-08-07 driving /pty/:id/connect). This variant
      pairs the fetch app with a hono side-app that OWNS upgrade routes;
      the composite fetch dispatches upgrade requests to it, and the
      returned runtime carries the upgradeWebSocket helper those routes
      need plus listen() wired with the runtime's websocket machinery. */
  createFetchWithWebSocket(app: FetchApp, wsApp: Hono): Runtime
}
