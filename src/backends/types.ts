export interface CursorModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

export type BackendEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "done"; text?: string }
  | { type: "error"; message: string }

export interface ToolSpec {
  name: string
  description?: string
  parameters?: unknown
}

export interface BackendRunRequest {
  model: string
  /** Cursor SDK model params such as optimize_for for Auto Router. */
  modelParams?: Array<{ id: string; value: string }>
  /** cursor-agent --model string, including bracket params when needed. */
  cliModel?: string
  prompt: string
  /** Latest user message only, used when continuing an existing stateful SDK agent. */
  lastUserPrompt?: string
  cwd: string
  tools: ToolSpec[]
  toolResults?: Array<{ id: string; content: string }>
  continuation?: boolean
  sessionKey: string
  signal: AbortSignal
}

export interface CursorBackend {
  readonly id: "cli" | "sdk" | "native"
  listModels(): Promise<CursorModel[]>
  run(request: BackendRunRequest): AsyncIterable<BackendEvent>
  /** Start the long-lived worker and load the SDK so the first chat turn is not cold. */
  /** Prefetch models and prewarm the local workspace executor. Returns the model list when available. */
  warmUp?(cwd: string): Promise<CursorModel[]>
  dispose?(): Promise<void>
}

/** Appends tool results the way a stateless backend must, because it has no live tool channel. */
export function promptWithToolResults(
  prompt: string,
  toolResults?: ReadonlyArray<{ id: string; content: string }>,
): string {
  if (!toolResults?.length) return prompt
  return `${prompt}\n\nTool results:\n${toolResults.map((result) => `${result.id}: ${result.content}`).join("\n")}`
}

export interface AuthMaterial {
  kind: "cli" | "api-key" | "native"
  apiKey?: string
  accessToken?: string
  refreshToken?: string
}

export const FALLBACK_MODELS: CursorModel[] = [
  { id: "auto-cursor-balanced", name: "Auto-Cursor-Balanced", contextWindow: 200000, maxTokens: 32000 },
  { id: "auto-cursor-cost", name: "Auto-Cursor-Cost", contextWindow: 200000, maxTokens: 32000 },
  { id: "auto-cursor-intelligence", name: "Auto-Cursor-Intelligence", contextWindow: 200000, maxTokens: 32000 },
  { id: "auto", name: "Auto-Cursor-Balanced", contextWindow: 200000, maxTokens: 32000 },
  { id: "composer-2.5", name: "Composer 2.5", contextWindow: 200000, maxTokens: 32000 },
  { id: "composer-2", name: "Composer 2", contextWindow: 200000, maxTokens: 32000 },
]
