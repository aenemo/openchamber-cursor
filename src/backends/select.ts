import type { AuthMaterial } from "./types.js"

export type BackendChoice = "auto" | "cli" | "sdk" | "native"

export function parseBackendChoice(value: string | undefined): BackendChoice {
  if (value === "cli" || value === "sdk" || value === "native" || value === "auto") return value
  return "auto"
}

export function chooseBackend(choice: BackendChoice, auth: AuthMaterial | undefined): "cli" | "sdk" | "native" {
  if (choice === "cli" || choice === "sdk" || choice === "native") return choice
  if (auth?.kind === "native") return "native"
  if (auth?.kind === "api-key") return "sdk"
  return "cli"
}
