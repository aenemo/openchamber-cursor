import { Credential, Integration, type Plugin } from "@opencode/plugin"
import type { AuthMaterial } from "../backends/types.js"
import { createNativeLogin, pollNativeLogin, refreshNativeToken, type NativeTokens } from "../backends/native/auth.js"
import { resolveCursorAgentLaunch, type Launch } from "../util/windows.js"
import { collectLaunch, spawnLaunch } from "../backends/spawn.js"

export const CURSOR_ID = "cursor"
export const AGENT_METHOD = "cursor-agent"
export const NATIVE_METHOD = "cursor-native"

const AGENT_MARKER = "cursor-agent"

function oauth(methodID: string, tokens: { access: string; refresh: string; expires: number }) {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make(methodID),
    refresh: tokens.refresh,
    access: tokens.access,
    expires: Math.floor(tokens.expires),
  })
}

export async function cursorAgentLoggedIn(launch: Launch): Promise<boolean> {
  const { code, output } = await collectLaunch(launch, ["status", "--format", "json"], process.cwd())
  if (/not logged in|login required/i.test(output)) return false
  return code === 0
}

async function waitForAgentLogin(launch: Launch): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (await cursorAgentLoggedIn(launch)) return
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error("cursor-agent login timed out. Run `cursor-agent login` and try again.")
}

function loginUrlFrom(output: string): string | undefined {
  const match = output.match(/https:\/\/\S+/)
  return match?.[0]
}

export async function registerIntegrations(ctx: Plugin.Context): Promise<void> {
  const integrationID = Integration.ID.make(CURSOR_ID)
  await ctx.integration.transform((editor) => {
    editor.update(CURSOR_ID, (integration) => {
      integration.name = "Cursor"
    })
    editor.method.update({
      integrationID,
      method: { id: Integration.MethodID.make(AGENT_METHOD), type: "oauth", label: "Log in with cursor-agent (browser)" },
      async authorize() {
        const launch = resolveCursorAgentLaunch(process.env.CURSOR_AGENT_BIN)
        if (!launch) throw new Error("cursor-agent is not installed.")
        const { child, lines } = spawnLaunch(launch, ["login"], process.cwd(), new AbortController().signal)
        let buffer = ""
        const url = await Promise.race([
          (async () => {
            for await (const line of lines) {
              buffer += `${line}\n`
              const found = loginUrlFrom(buffer)
              if (found) return found
            }
            return undefined
          })(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 4000)),
        ])
        return {
          mode: "auto" as const,
          url: url || "https://cursor.com/login",
          instructions: "Finish login in the browser. cursor-agent keeps the session.",
          callback: waitForAgentLogin(launch).then(() => {
            child.kill()
            return oauth(AGENT_METHOD, { access: AGENT_MARKER, refresh: AGENT_MARKER, expires: Date.now() + 365 * 24 * 3600_000 })
          }),
        }
      },
      async refresh(credential) {
        return oauth(AGENT_METHOD, {
          access: credential.access,
          refresh: credential.refresh,
          expires: Date.now() + 365 * 24 * 3600_000,
        })
      },
    })
    editor.method.update({
      integrationID,
      method: { id: Integration.MethodID.make(NATIVE_METHOD), type: "oauth", label: "Cursor account (native OAuth)" },
      async authorize() {
        const login = createNativeLogin()
        return {
          mode: "auto" as const,
          url: login.loginUrl,
          instructions: "Sign in to Cursor. This stores an access token for the native backend.",
          callback: pollNativeLogin(login.uuid, login.verifier).then((tokens: NativeTokens) => oauth(NATIVE_METHOD, tokens)),
        }
      },
      async refresh(credential) {
        const tokens = await refreshNativeToken(credential.refresh)
        return oauth(NATIVE_METHOD, tokens)
      },
    })
    editor.method.update({
      integrationID,
      method: { type: "key", label: "API key" },
    })
    editor.method.update({
      integrationID,
      method: { type: "env", names: ["CURSOR_API_KEY"] },
    })
  })
}

export async function resolveAuth(ctx: Plugin.Context): Promise<AuthMaterial | undefined> {
  const envKey = process.env.CURSOR_API_KEY
  const connection = await ctx.integration.connection.active(CURSOR_ID)
  if (!connection) return envKey ? { kind: "api-key", apiKey: envKey } : undefined
  const credential = await ctx.integration.connection.resolve(connection)
  if (!credential) return envKey ? { kind: "api-key", apiKey: envKey } : undefined
  if (credential.type === "key") return { kind: "api-key", apiKey: credential.key }
  if (credential.type === "oauth") {
    if (String(credential.methodID) === NATIVE_METHOD) {
      return { kind: "native", accessToken: credential.access, refreshToken: credential.refresh }
    }
    return { kind: "cli" }
  }
  return envKey ? { kind: "api-key", apiKey: envKey } : { kind: "cli" }
}
