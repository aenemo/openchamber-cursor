import type { Plugin as PluginNamespace } from "@opencode/plugin"
import { Plugin } from "@opencode/plugin"
import { AgentCliBackend } from "./backends/agent-cli.js"
import { SdkBackend } from "./backends/sdk.js"
import { NativeBackend } from "./backends/native/backend.js"
import { ensureSdkApiKey } from "./backends/native/auth.js"
import { registerIntegrations, resolveAuth } from "./plugin/auth.js"
import { modelsForPublish, noteDiscovered, publishProvider } from "./plugin/catalog.js"
import { startSharedProxy, type RunningProxy } from "./proxy/server.js"
import { log } from "./util/log.js"

const OpenChamberCursor = Plugin.define({
  id: "openchamber-cursor",
  async setup(ctx) {
    await registerIntegrations(ctx)
    const state: { port: number; token: string } = {
      port: 0,
      token: "",
    }
    const cli = new AgentCliBackend()
    const sdk = new SdkBackend(async () => {
      const auth = await resolveAuth(ctx)
      const key = auth?.apiKey || auth?.accessToken
      if (!key) throw new Error("Connect Cursor with an API key, or set CURSOR_API_KEY, before using the SDK backend.")
      return ensureSdkApiKey(key, auth?.refreshToken)
    })
    const native = new NativeBackend(async () => {
      const auth = await resolveAuth(ctx)
      if (!auth?.accessToken) throw new Error("Use Cursor account (native OAuth) before the native backend.")
      // Connect-RPC wants the OAuth access token. The SDK wants a minted crsr_ user API key.
      if (process.env.CURSOR_NATIVE_TRANSPORT === "connect") return auth.accessToken
      return ensureSdkApiKey(auth.accessToken, auth.refreshToken)
    })
    const proxy: RunningProxy = await startSharedProxy({
      getAuth: () => resolveAuth(ctx),
      backends: { cli, sdk, native },
      fallbackDirectory: () => ctx.location.directory,
      models: () => modelsForPublish(),
    })
    state.port = proxy.port
    state.token = proxy.token
    await publishProvider(ctx, state)

    const warm = async () => {
      const auth = await resolveAuth(ctx)
      if (!auth || auth.kind === "cli") return
      const started = Date.now()
      try {
        if (auth.kind === "native") await native.warmUp(ctx.location.directory)
        else await sdk.warmUp(ctx.location.directory)
        log("info", "cursor backend warm-up complete", { kind: auth.kind, ms: Date.now() - started })
      } catch (error) {
        log("warn", "cursor backend warm-up failed", error instanceof Error ? error.message : error)
      }
    }

    const refresh = async () => {
      const auth = await resolveAuth(ctx)
      try {
        // SDK/native warmUp lists models and prewarms the workspace executor in one worker round-trip.
        const next = !auth || auth.kind === "cli"
          ? await cli.listModels()
          : auth.kind === "native"
            ? await native.warmUp(ctx.location.directory)
            : await sdk.warmUp(ctx.location.directory)
        if (noteDiscovered(next)) log("info", "cursor models updated", modelsForPublish().map((model) => model.id))
        else log("info", "cursor model discovery kept the current catalog", modelsForPublish().map((model) => model.id))
      } catch (error) {
        log("warn", "model discovery failed", error instanceof Error ? error.message : error)
        void warm()
      }
      await ctx.provider.reload()
    }
    void refresh()

    await ctx.session.hook(
      "model.request",
      async (event) => {
        let directory: string = ctx.location.directory
        try {
          const session = await ctx.session.get({ sessionID: event.sessionID })
          const located = session as { directory?: string; location?: { directory?: string } }
          directory = located.location?.directory || located.directory || directory
        } catch (error) {
          log("warn", "session directory lookup failed", error instanceof Error ? error.message : error)
        }
        event.headers["x-opencode-directory"] = encodeURIComponent(directory)
        event.headers["x-openchamber-cursor-session"] = String(event.sessionID)
        event.headers.authorization = `Bearer ${state.token}`
        event.baseURL = `http://127.0.0.1:${state.port}/v1`
      },
      { providerID: "cursor" },
    )

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = (event as { type: string }).type
          if (type.includes("connection") || type.includes("credential")) void refresh()
        }
      } catch {
        // Unsubscribing ends the loop.
      }
    })()

    return async () => {
      controller.abort()
      await sdk.dispose()
      await native.dispose()
      await proxy.close()
    }
  },
})

export default OpenChamberCursor

export type { PluginNamespace }
