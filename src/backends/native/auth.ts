import { createHash, randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cacheDir } from "../../util/paths.js"

const LOGIN_URL = "https://cursor.com/loginDeepControl"
const POLL_URL = "https://api2.cursor.sh/auth/poll"
const REFRESH_URL = process.env.CURSOR_REFRESH_URL ?? "https://api2.cursor.sh/auth/exchange_user_api_key"
const MINT_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/CreateUserApiKey"
const NINETY_DAYS_MS = 90 * 24 * 3600_000

export interface NativeLogin {
  verifier: string
  loginUrl: string
  uuid: string
}

export interface NativeTokens {
  access: string
  refresh: string
  expires: number
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url")
}

export function createNativeLogin(): NativeLogin {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash("sha256").update(verifier).digest())
  const uuid = randomUUID()
  const params = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" })
  return { verifier, uuid, loginUrl: `${LOGIN_URL}?${params.toString()}` }
}

export function tokenExpiry(token: string): number {
  try {
    const payload = token.split(".")[1]
    if (!payload) return Date.now() + 3600_000
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp?: number }
    if (typeof decoded.exp === "number") return decoded.exp * 1000 - 5 * 60_000
  } catch {
    // Fall through to a one-hour lifetime.
  }
  return Date.now() + 3600_000
}

function issuedTokens(access: string, refresh: string): NativeTokens {
  return {
    access,
    refresh,
    expires: tokenExpiry(access),
  }
}

export async function pollNativeLogin(uuid: string, verifier: string, signal?: AbortSignal): Promise<NativeTokens> {
  let delay = 1000
  for (let attempt = 0; attempt < 150; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, delay))
    if (signal?.aborted) throw new Error("Cursor login cancelled")
    const response = await fetch(`${POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`, { signal })
    if (response.status === 404) {
      delay = Math.min(delay * 1.2, 10_000)
      continue
    }
    if (!response.ok) throw new Error(`Cursor login poll failed (${response.status})`)
    const data = (await response.json()) as { accessToken?: string; refreshToken?: string }
    if (!data.accessToken) throw new Error("Cursor login returned no access token")
    return issuedTokens(data.accessToken, data.refreshToken || data.accessToken)
  }
  throw new Error("Cursor login timed out")
}

export async function refreshNativeToken(refresh: string): Promise<NativeTokens> {
  const response = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${refresh}`, "Content-Type": "application/json" },
    body: "{}",
  })
  if (!response.ok) throw new Error(`Cursor token refresh failed (${response.status})`)
  const data = (await response.json()) as { accessToken?: string; refreshToken?: string }
  if (!data.accessToken) throw new Error("Cursor token refresh returned no access token")
  return issuedTokens(data.accessToken, data.refreshToken || refresh)
}

export async function mintUserApiKey(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ apiKey: string; expires: number }> {
  const expires = Date.now() + NINETY_DAYS_MS
  const response = await fetchImpl(MINT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Connect-Protocol-Version": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: `openchamber-cursor-${os.hostname()}`,
      expiresAt: String(Math.floor(expires)),
    }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Creating Cursor SDK API key failed (${response.status}): ${detail.slice(0, 200)}`)
  }
  const data = (await response.json()) as { apiKey?: string }
  if (!data.apiKey) throw new Error("Cursor returned an empty API key")
  return { apiKey: data.apiKey, expires }
}

function mintedFile(): string {
  return path.join(cacheDir(), "minted-key.json")
}

let cachedKey: { sourceHash: string; apiKey: string; expires: number } | undefined

/** Turns a browser-login JWT into a reusable user API key (`crsr_...`) required by `@cursor/sdk`. */
export async function ensureSdkApiKey(
  tokenOrKey: string,
  refreshToken?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!tokenOrKey.startsWith("eyJ")) return tokenOrKey
  const sourceHash = createHash("sha256").update(refreshToken || tokenOrKey).digest("hex").slice(0, 16)
  if (cachedKey && cachedKey.sourceHash === sourceHash && cachedKey.expires > Date.now() + 60_000) {
    return cachedKey.apiKey
  }
  try {
    const onDisk = JSON.parse(fs.readFileSync(mintedFile(), "utf8")) as { sourceHash?: string; apiKey?: string; expires?: number }
    if (onDisk.sourceHash === sourceHash && typeof onDisk.apiKey === "string" && (onDisk.expires ?? 0) > Date.now() + 60_000) {
      cachedKey = { sourceHash, apiKey: onDisk.apiKey, expires: onDisk.expires! }
      return onDisk.apiKey
    }
  } catch {
    // Mint a fresh key below.
  }
  let minted: { apiKey: string; expires: number }
  try {
    minted = await mintUserApiKey(tokenOrKey, fetchImpl)
  } catch (firstError) {
    if (!refreshToken) throw firstError
    const refreshed = await refreshNativeToken(refreshToken)
    if (!refreshed.access.startsWith("eyJ")) {
      minted = { apiKey: refreshed.access, expires: refreshed.expires }
    } else {
      minted = await mintUserApiKey(refreshed.access, fetchImpl)
    }
  }
  cachedKey = { sourceHash, apiKey: minted.apiKey, expires: minted.expires }
  try {
    fs.mkdirSync(cacheDir(), { recursive: true })
    fs.writeFileSync(mintedFile(), JSON.stringify(cachedKey))
  } catch {
    // In-memory cache still serves this process.
  }
  return minted.apiKey
}
