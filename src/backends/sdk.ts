import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import type { BackendEvent, BackendRunRequest, CursorBackend, CursorModel } from "./types.js"
import { FALLBACK_MODELS, MODEL_CONTEXT_WINDOW, MODEL_MAX_TOKENS } from "./types.js"
import { expandSdkModels, type SdkListedModel } from "./sdk-models.js"
import { assertNodeForSdk, nodeBinary } from "./spawn.js"
import { modelSelectionKey } from "./auto-models.js"
import { compileCacheDir, sdkStateDir } from "../util/paths.js"
import { readCheckpoint, writeCheckpoint } from "./checkpoint.js"
import { log } from "../util/log.js"
import { mapCursorTool } from "../proxy/tools.js"

interface RunnerEvent {
  type: string
  id?: string
  name?: string
  text?: string
  message?: string
  arguments?: string
  agentId?: string
  models?: SdkListedModel[]
  ms?: number
  cwd?: string
  prewarmed?: boolean
}

class SdkRunner {
  readonly events: RunnerEvent[] = []
  private waiters: Array<(event: RunnerEvent) => void> = []
  private child: ChildProcessWithoutNullStreams
  agentId: string | undefined
  alive = true

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child
    const lines = createInterface({ input: child.stdout })
    lines.on("line", (line) => {
      let event: RunnerEvent
      try {
        event = JSON.parse(line) as RunnerEvent
      } catch {
        return
      }
      if (event.type === "session" && event.agentId) this.agentId = event.agentId
      if (event.type === "warn" && event.message) log("warn", "sdk runner", event.message)
      if (event.type === "idle" || event.type === "pong" || event.type === "warn") return
      this.push(event)
    })
    child.on("exit", (code) => {
      this.alive = false
      this.push({ type: "error", message: `Cursor SDK runner exited (${code ?? "signal"})` })
    })
  }

  private push(event: RunnerEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(event)
    else this.events.push(event)
  }

  send(message: unknown): void {
    this.child.stdin.write(JSON.stringify(message) + "\n")
  }

  next(): Promise<RunnerEvent> {
    const queued = this.events.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  cancel(): void {
    try {
      this.send({ type: "cancel" })
    } catch {
      // Process may already be gone.
    }
    this.child.kill()
    this.alive = false
  }
}

function stampModels(models: SdkListedModel[]): CursorModel[] {
  return expandSdkModels(models).map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: MODEL_CONTEXT_WINDOW,
    maxTokens: MODEL_MAX_TOKENS,
    ...(model.isDefault ? { isDefault: true } : {}),
  }))
}

function runnerScript(): string {
  return fileURLToPath(new URL("./sdk-runner.mjs", import.meta.url))
}

function startRunner(): SdkRunner {
  if (!process.env.CURSOR_ACP_NODE_BIN) assertNodeForSdk()
  const child = spawn(nodeBinary(), [runnerScript()], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      NODE_COMPILE_CACHE: compileCacheDir(),
    },
  }) as ChildProcessWithoutNullStreams
  child.stderr.on("data", (chunk) => log("warn", "sdk runner", chunk.toString().trim()))
  return new SdkRunner(child)
}

export interface RememberedAgent {
  agentId: string
  modelKey: string
}

/** Resume only when the stored agent was created for this model and its params. */
export function resumeAgentId(
  model: string,
  modelParams: Array<{ id: string; value: string }> | undefined,
  live: RememberedAgent | undefined,
  saved: { agentId: string; model: string } | undefined,
): string | undefined {
  const modelKey = modelSelectionKey(model, modelParams)
  if (live?.modelKey === modelKey) return live.agentId
  if (!saved) return undefined
  if (saved.model === modelKey) return saved.agentId
  // Checkpoints written before selection keys stored the plain Cursor id.
  // Auto Router always has params, so an old "auto-smart" id is not enough to resume a Cost or Intelligence turn.
  if (saved.model === model && !(modelParams?.length)) return saved.agentId
  return undefined
}

/** One long-lived Node worker. Chat sessions reuse it by resuming different agent IDs inside the same process. */
export class SdkBackend implements CursorBackend {
  readonly id = "sdk" as const
  private warm: SdkRunner | undefined
  private sessionAgents = new Map<string, RememberedAgent>()
  private lock: Promise<void> = Promise.resolve()

  constructor(private readonly apiKey: () => Promise<string>) {}

  private ensureWarm(): SdkRunner {
    if (this.warm?.alive) return this.warm
    this.warm = startRunner()
    log("info", "sdk worker started")
    return this.warm
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.lock
    this.lock = new Promise((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }

  async warmUp(cwd: string): Promise<CursorModel[]> {
    return this.withLock(async () => {
      const started = Date.now()
      const apiKey = await this.apiKey()
      const runner = this.ensureWarm()
      runner.send({
        type: "warm",
        id: "warm",
        apiKey,
        cwd,
        stateRoot: sdkStateDir(cwd),
      })
      const event = await runner.next()
      if (event.type === "error") throw new Error(event.message || "SDK warm-up failed")
      const models = stampModels(event.models ?? [])
      log("info", "sdk worker warmed", {
        ms: event.ms ?? Date.now() - started,
        models: models.length,
        prewarmed: event.prewarmed === true,
        cwd: event.cwd || cwd,
      })
      return models.length > 0 ? models : FALLBACK_MODELS
    })
  }

  async listModels(): Promise<CursorModel[]> {
    return this.withLock(async () => {
      const apiKey = await this.apiKey()
      const runner = this.ensureWarm()
      runner.send({ type: "models", id: "models", apiKey })
      const event = await runner.next()
      if (event.type === "error") {
        log("warn", "sdk model list failed", event.message)
        return FALLBACK_MODELS
      }
      const models = stampModels(event.models ?? [])
      if (models.length === 0) return FALLBACK_MODELS
      return models
    })
  }

  async *run(request: BackendRunRequest): AsyncIterable<BackendEvent> {
    let release!: () => void
    const previous = this.lock
    this.lock = new Promise((resolve) => {
      release = resolve
    })
    await previous
    const turnStarted = Date.now()
    try {
      yield* this.runLocked(request, turnStarted)
    } finally {
      release()
    }
  }

  private async *runLocked(request: BackendRunRequest, turnStarted: number): AsyncIterable<BackendEvent> {
    const apiKey = await this.apiKey()
    const advertised = new Set(request.tools.map((tool) => tool.name))
    const hostTools = request.tools.filter((tool) => mapCursorTool(tool.name, advertised))
    const runner = this.ensureWarm()
    const saved = readCheckpoint(request.sessionKey)
    const resumeId = resumeAgentId(request.model, request.modelParams, this.sessionAgents.get(request.sessionKey), saved)
    const promptToSend = resumeId && request.lastUserPrompt ? request.lastUserPrompt : request.prompt
    const dispatchAt = Date.now()

    if (request.continuation && resumeId && request.toolResults?.length) {
      for (const result of request.toolResults) {
        runner.send({ type: "tool_result", id: result.id, content: result.content })
      }
    } else {
      runner.send({
        type: "turn",
        apiKey,
        model: request.model,
        modelParams: request.modelParams,
        cwd: request.cwd,
        stateRoot: sdkStateDir(request.cwd),
        prompt: promptToSend,
        tools: hostTools,
        agentId: resumeId,
        sessionKey: request.sessionKey,
      })
    }

    const onAbort = () => {
      try {
        runner.send({ type: "cancel" })
      } catch {
        // Ignore.
      }
    }
    request.signal.addEventListener("abort", onAbort, { once: true })
    let firstTokenAt: number | undefined
    try {
      while (!request.signal.aborted) {
        const event = await runner.next()
        if (event.type === "text" && event.text) {
          firstTokenAt ??= Date.now()
          yield { type: "text", text: event.text }
        } else if (event.type === "reasoning" && event.text) {
          firstTokenAt ??= Date.now()
          yield { type: "reasoning", text: event.text }
        } else if (event.type === "tool") {
          firstTokenAt ??= Date.now()
          const name = mapCursorTool(event.name || "", advertised) || event.name || "tool"
          yield {
            type: "tool_call",
            id: event.id || "tool",
            name,
            arguments: event.arguments || "{}",
          }
          this.logTiming(request, turnStarted, dispatchAt, firstTokenAt, "tool")
          return
        } else if (event.type === "error") {
          this.logTiming(request, turnStarted, dispatchAt, firstTokenAt, "error")
          yield { type: "error", message: event.message || "Cursor SDK failed" }
          return
        } else if (event.type === "done") {
          if (runner.agentId) {
            const modelKey = modelSelectionKey(request.model, request.modelParams)
            this.sessionAgents.set(request.sessionKey, { agentId: runner.agentId, modelKey })
            writeCheckpoint(request.sessionKey, { agentId: runner.agentId, model: modelKey })
          }
          this.logTiming(request, turnStarted, dispatchAt, firstTokenAt, "done")
          yield { type: "done", text: event.text }
          return
        } else if (event.type === "session" && event.agentId) {
          this.sessionAgents.set(request.sessionKey, {
            agentId: event.agentId,
            modelKey: modelSelectionKey(request.model, request.modelParams),
          })
        }
      }
    } finally {
      request.signal.removeEventListener("abort", onAbort)
    }
  }

  private logTiming(
    request: BackendRunRequest,
    turnStarted: number,
    dispatchAt: number,
    firstTokenAt: number | undefined,
    outcome: string,
  ): void {
    const now = Date.now()
    log("info", "turn timing", {
      backend: "sdk",
      model: request.model,
      sessionKey: request.sessionKey,
      outcome,
      startupMs: dispatchAt - turnStarted,
      ttftMs: firstTokenAt ? firstTokenAt - turnStarted : undefined,
      totalMs: now - turnStarted,
      promptChars: request.prompt.length,
    })
  }

  async dispose(): Promise<void> {
    this.warm?.cancel()
    this.warm = undefined
    this.sessionAgents.clear()
  }
}
