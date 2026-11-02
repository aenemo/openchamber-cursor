import path from "node:path"
import readline from "node:readline"
import { randomUUID } from "node:crypto"
import { Agent, Cursor, JsonlLocalAgentStore, configureCursorSdk, createAgentPlatform } from "@cursor/sdk"

const major = Number(process.versions.node.split(".")[0] ?? 0)
const minor = Number(process.versions.node.split(".")[1] ?? 0)
if (major < 22 || (major === 22 && minor < 13)) {
  process.stdout.write(JSON.stringify({ type: "error", message: `Cursor SDK needs Node.js 22.13 or newer (this runner is ${process.version}). Set CURSOR_ACP_NODE_BIN to a newer node.` }) + "\n")
  process.exit(1)
}

/** Long-lived hosts: avoid re-walking the tree every 20s (SDK default). Override with CURSOR_RIPWALK_CACHE_TTL_MS. */
const WORKSPACE_SCAN_TTL_MS = Number(process.env.CURSOR_RIPWALK_CACHE_TTL_MS || 30 * 60 * 1000)

const waiters = new Map()
let agent = null
let activeModel = null
let activeSession = null
let runHandle = null
let busy = false
/** Bumped when a run is force-cleared so a superseded turn's finally does not clear the new turn's busy flag. */
let turnGeneration = 0
let store = null
let storeRoot = null
let platform = null
let prewarmRelease = null
let prewarmedCwd = null
let prewarmedApiKey = null

function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\n")
}

function customTools(tools) {
  const defined = {}
  for (const tool of tools ?? []) {
    defined[tool.name] = {
      description: tool.description || `Host tool ${tool.name}. OpenCode runs it and returns the result.`,
      inputSchema: tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object", additionalProperties: true },
      execute(_args, context) {
        const id = context?.toolCallId || randomUUID()
        emit({ type: "tool", id, name: tool.name, arguments: JSON.stringify(_args ?? {}) })
        return new Promise((resolve) => {
          waiters.set(id, resolve)
        })
      },
    }
  }
  return defined
}

/** Same shape as modelSelectionKey() in auto-models.ts. The runner cannot import that TypeScript module. */
function modelKey(cmd) {
  const params = Array.isArray(cmd.modelParams)
    ? cmd.modelParams.map((param) => ({ id: String(param.id), value: String(param.value) })).sort((left, right) => left.id.localeCompare(right.id))
    : []
  return JSON.stringify({ id: cmd.model || "auto-smart", params })
}

async function clearStuckRun() {
  turnGeneration += 1
  const pending = runHandle
  runHandle = null
  for (const [, resolve] of waiters) resolve("(cancelled)")
  waiters.clear()
  if (pending) {
    try {
      await pending.cancel()
    } catch {
      // Already terminal or store already marked cancelled.
    }
  }
  busy = false
}

function ensureStore(stateRoot) {
  if (store && storeRoot === stateRoot) return
  storeRoot = stateRoot
  store = new JsonlLocalAgentStore(stateRoot)
  configureCursorSdk({
    local: {
      store,
      useHttp1ForAgent: process.env.CURSOR_SDK_HTTP1 === "1",
      workspaceScanCacheTtlMs: Number.isFinite(WORKSPACE_SCAN_TTL_MS) ? WORKSPACE_SCAN_TTL_MS : 30 * 60 * 1000,
    },
  })
}

function agentLocalOptions(cmd, tools) {
  return {
    cwd: cmd.cwd,
    store,
    settingSources: [],
    customTools: tools && Object.keys(tools).length ? tools : undefined,
  }
}

async function ensurePrewarm(cmd) {
  if (!cmd.cwd || !cmd.apiKey) return
  ensureStore(cmd.stateRoot || path.join(cmd.cwd, ".openchamber-cursor-sdk"))
  if (prewarmRelease && prewarmedCwd === cmd.cwd && prewarmedApiKey === cmd.apiKey) return
  if (prewarmRelease) {
    try {
      await prewarmRelease()
    } catch {
      // Best effort; a later send() rebuilds.
    }
    prewarmRelease = null
    prewarmedCwd = null
    prewarmedApiKey = null
  }
  if (!platform) platform = await createAgentPlatform()
  try {
    prewarmRelease = await platform.prewarmLocalWorkspace({
      apiKey: cmd.apiKey,
      model: { id: "auto-smart" },
      name: "openchamber-cursor",
      local: {
        cwd: cmd.cwd,
        store,
        settingSources: [],
      },
    })
    prewarmedCwd = cmd.cwd
    prewarmedApiKey = cmd.apiKey
  } catch (error) {
    emit({
      type: "warn",
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function ensureAgent(cmd) {
  const requestedModel = modelKey(cmd)
  const sessionKey = cmd.sessionKey || "default"
  if (
    agent
    && activeModel === requestedModel
    && activeSession === sessionKey
    && (!cmd.agentId || agent.agentId === cmd.agentId)
  ) {
    return agent
  }
  ensureStore(cmd.stateRoot)
  await ensurePrewarm(cmd)
  const tools = customTools(cmd.tools)
  const model = { id: cmd.model || "auto-smart" }
  if (Array.isArray(cmd.modelParams) && cmd.modelParams.length) model.params = cmd.modelParams
  const options = {
    apiKey: cmd.apiKey,
    model,
    name: "openchamber-cursor",
    local: agentLocalOptions(cmd, tools),
  }
  if (cmd.tools?.length) {
    options.tools = ["mcp"]
    options.disallowedTools = ["shell", "read", "edit", "grep", "glob", "delete", "task"]
  }
  // Resume only when the parent sends an agentId. A model change omits it, so this creates a new agent.
  agent = cmd.agentId ? await Agent.resume(cmd.agentId, options) : await Agent.create(options)
  activeModel = requestedModel
  activeSession = sessionKey
  emit({ type: "session", agentId: agent.agentId })
  return agent
}

async function startRun(current, prompt) {
  // local.force expires orphaned activeRunId left by abort/crash/retry (Cursor SDK docs).
  try {
    return await current.send(prompt, { local: { force: true } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/already has active run/i.test(message)) throw error
    const pending = runHandle
    runHandle = null
    for (const [, resolve] of waiters) resolve("(cancelled)")
    waiters.clear()
    if (pending) {
      try {
        await pending.cancel()
      } catch {
        // Ignore.
      }
    }
    return current.send(prompt, { local: { force: true } })
  }
}

async function runTurn(cmd) {
  const toolContinue = (cmd.toolResults ?? []).length > 0
  if (toolContinue) {
    // Tool results are normally delivered as type=tool_result; keep this path from clearing busy.
    for (const result of cmd.toolResults ?? []) {
      const resolve = waiters.get(result.id)
      if (resolve) {
        waiters.delete(result.id)
        resolve(result.content ?? "")
      }
    }
    return
  }
  if (busy) {
    // OpenCode retried or sent a new user message while a previous run was wedged.
    await clearStuckRun()
  }
  const myGeneration = turnGeneration + 1
  turnGeneration = myGeneration
  busy = true
  try {
    const current = await ensureAgent(cmd)
    const run = await startRun(current, cmd.prompt || "")
    if (myGeneration !== turnGeneration) return
    runHandle = run
    let sent = ""
    for await (const event of run.stream()) {
      if (myGeneration !== turnGeneration) return
      if (event.type === "assistant") {
        const blocks = event.message?.content ?? []
        for (const block of blocks) {
          if (block.type !== "text" || typeof block.text !== "string") continue
          const text = block.text.startsWith(sent) ? block.text.slice(sent.length) : block.text
          sent = block.text.startsWith(sent) ? block.text : sent + block.text
          if (text) emit({ type: "text", text })
        }
      } else if (event.type === "thinking" && event.text) {
        emit({ type: "reasoning", text: event.text })
      } else if (event.type === "status" && (event.status === "ERROR" || event.status === "CANCELLED")) {
        emit({ type: "error", message: event.message || event.status })
      }
    }
    const result = await run.wait()
    if (myGeneration !== turnGeneration) return
    runHandle = null
    if (result.status === "error") emit({ type: "error", message: result.error?.message || "Cursor run failed" })
    else emit({ type: "done", text: result.result })
  } catch (error) {
    if (myGeneration === turnGeneration) {
      emit({ type: "error", message: error instanceof Error ? error.message : String(error) })
    }
  } finally {
    if (myGeneration === turnGeneration) {
      busy = false
      emit({ type: "idle" })
    }
  }
}

async function listModels(cmd) {
  try {
    const models = await Cursor.models.list({ apiKey: cmd.apiKey })
    emit({
      type: "models",
      id: cmd.id,
      models: models.map((model) => ({ id: model.id, name: model.displayName || model.id })),
    })
  } catch (error) {
    emit({ type: "error", id: cmd.id, message: error instanceof Error ? error.message : String(error) })
  }
}

async function warm(cmd) {
  const started = Date.now()
  try {
    const modelsPromise = Cursor.models.list({ apiKey: cmd.apiKey }).catch((error) => {
      throw error
    })
    await ensurePrewarm(cmd)
    const models = await modelsPromise
    emit({
      type: "warm",
      id: cmd.id,
      ms: Date.now() - started,
      cwd: cmd.cwd,
      prewarmed: Boolean(prewarmRelease),
      models: models.map((model) => ({ id: model.id, name: model.displayName || model.id })),
    })
  } catch (error) {
    emit({ type: "error", id: cmd.id, message: error instanceof Error ? error.message : String(error) })
  }
}

const lines = readline.createInterface({ input: process.stdin })
lines.on("line", (line) => {
  let cmd
  try {
    cmd = JSON.parse(line)
  } catch {
    return
  }
  if (cmd.type === "tool_result") {
    const resolve = waiters.get(cmd.id)
    if (resolve) {
      waiters.delete(cmd.id)
      resolve(cmd.content ?? "")
    }
    return
  }
  if (cmd.type === "cancel") {
    void clearStuckRun()
    return
  }
  if (cmd.type === "ping") {
    emit({ type: "pong" })
    return
  }
  if (cmd.type === "models") {
    void listModels(cmd)
    return
  }
  if (cmd.type === "warm") {
    void warm(cmd)
    return
  }
  if (cmd.type === "turn") void runTurn(cmd)
})
