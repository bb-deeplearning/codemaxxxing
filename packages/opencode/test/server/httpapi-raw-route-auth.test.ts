import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Instance } from "../../src/project/instance"
import { EventPaths } from "../../src/server/routes/instance/httpapi/event"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { PtyPaths } from "../../src/server/routes/instance/httpapi/groups/pty"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { PtyID } from "../../src/pty/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

const originalHttpApi = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

function app(input: { password?: string; username?: string }) {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
  const handler = HttpRouter.toWebHandler(
    ExperimentalHttpApiServer.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input.password,
            OPENCODE_SERVER_USERNAME: input.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler

  return {
    fetch: (request: Request) => handler(request, ExperimentalHttpApiServer.context),
    request(input: string | URL | Request, init?: RequestInit) {
      return this.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
}

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => {})
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = originalHttpApi
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi raw route authorization", () => {
  test("requires configured auth before opening the raw instance event stream", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app({ password: "secret" })
    const headers = { "x-opencode-directory": tmp.path }

    const missing = await server.request(EventPaths.event, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(EventPaths.event, {
      headers: { ...headers, authorization: basic("opencode", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(200)
  })

  test("requires configured auth before resolving the raw PTY websocket route", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app({ password: "secret" })
    const route = PtyPaths.connect.replace(":ptyID", PtyID.ascending())
    const headers = { "x-opencode-directory": tmp.path }

    const missing = await server.request(route, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(route, {
      headers: { ...headers, authorization: basic("opencode", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(404)
  })

  test("requires configured auth on every root api route (/global family)", async () => {
    const server = app({ password: "secret" })

    /* the root api family has no instance router layer: without its own
       auth middleware, config rewrite / dispose / upgrade / fs listing /
       the global event stream are open. pin every GET in the family. */
    for (const route of [GlobalPaths.health, GlobalPaths.fs, GlobalPaths.config, GlobalPaths.event]) {
      const missing = await server.request(route)
      await cancelBody(missing)
      expect(missing.status).toBe(401)

      const bad = await server.request(route, {
        headers: { authorization: basic("opencode", "wrong") },
      })
      await cancelBody(bad)
      expect(bad.status).toBe(401)

      const authed = await server.request(route, {
        headers: { authorization: basic("opencode", "secret") },
      })
      await cancelBody(authed)
      expect(authed.status).toBe(200)
    }
  })

  test("authed global fs listing serves home and rejects bad paths", async () => {
    const server = app({ password: "secret" })
    const headers = { authorization: basic("opencode", "secret") }

    const listing = await server.request(GlobalPaths.fs, { headers })
    expect(listing.status).toBe(200)
    const body = (await listing.json()) as { path: string; home: string }
    expect(body.path).toBe(body.home)

    const bad = await server.request(`${GlobalPaths.fs}?path=relative/nope`, { headers })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ success: false })
  })
})
