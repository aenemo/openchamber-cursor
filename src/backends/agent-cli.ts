import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { CursorBackend, CursorModel, BackendRunRequest, BackendEvent } from "./types.js"
import { FALLBACK_MODELS, MODEL_CONTEXT_WINDOW, MODEL_MAX_TOKENS, promptWithToolResults } from "./types.js"
import { parseModelList, parseStreamJsonLine } from "./stream-json.js"
import { collectLaunch, spawnCommand, spawnLaunch } from "./spawn.js"
import { resolveAgentRuntime, resolveCursorAgentLaunch, type Launch } from "../util/windows.js"
import { cacheDir, compileCacheDir } from "../util/paths.js"
import { log } from "../util/log.js"
import { mapCursorTool } from "../proxy/tools.js"

function argvScript(): string {
  return fileURLToPath(new URL("./agent-argv.mjs", import.meta.url))
}

function writePrompt(prompt: string): string {
  const file = path.join(cacheDir(), "prompts", `${randomBytes(8).toString("hex")}.txt`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, prompt)
  return file
}

export class AgentCliBackend implements CursorBackend {
  readonly id = "cli" as const

  constructor(private readonly launch: Launch | undefined = resolveCursorAgentLaunch(process.env.CURSOR_AGENT_BIN)) {}

  private requireLaunch(): Launch {
    if (!this.launch) {
      throw new Error("cursor-agent is not on PATH. Install the Cursor CLI and run `cursor-agent login`.")
    }
    return this.launch
  }

  async listModels(): Promise<CursorModel[]> {
    const launch = this.launch
    if (!launch) return FALLBACK_MODELS
    try {
      const listed = await collectLaunch(launch, ["--list-models"], process.cwd())
      const parsed = parseModelList(listed.output)
      if (parsed.length === 0) return FALLBACK_MODELS
      return parsed.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: MODEL_CONTEXT_WINDOW,
        maxTokens: MODEL_MAX_TOKENS,
      }))
    } catch (error) {
      log("warn", "cursor-agent model list failed", error instanceof Error ? error.message : error)
      return FALLBACK_MODELS
    }
  }

  async *run(request: BackendRunRequest): AsyncIterable<BackendEvent> {
    const launch = this.requireLaunch()
    const args = ["--print", "--output-format", "stream-json", "--stream-partial-output", "--workspace", request.cwd]
    if (process.env.CURSOR_ACP_TRUST_WORKSPACE !== "false" && process.env.CURSOR_ACP_TRUST_WORKSPACE !== "0") args.push("--trust")
    if (request.tools.length === 0) args.push("--mode", "ask")
    const cliModel = request.cliModel || request.model
    if (cliModel && cliModel !== "auto") args.push("--model", cliModel)
    const prompt = promptWithToolResults(request.prompt, request.toolResults)
    log("info", "cursor-agent run", { model: cliModel, cwd: request.cwd, promptChars: prompt.length })
    const runtime = resolveAgentRuntime(launch)
    const promptFile = runtime ? writePrompt(prompt) : undefined
    const { child, lines, stderr } = runtime && promptFile
      ? spawnCommand(runtime.node, [argvScript(), promptFile, runtime.index, ...args], request.cwd, request.signal, {
        ...process.env,
        CURSOR_INVOKED_AS: process.env.CURSOR_INVOKED_AS || "cursor-agent",
        NODE_COMPILE_CACHE: compileCacheDir(),
      })
      : spawnLaunch(launch, [...args, prompt], request.cwd, request.signal)
    if (promptFile) child.once("close", () => fs.rmSync(promptFile, { force: true }))
    const advertised = new Set(request.tools.map((tool) => tool.name))
    let sawDone = false
    let streamed = ""
    for await (const line of lines) {
      for (const event of parseStreamJsonLine(line)) {
        if (event.type === "text") {
          if (streamed && event.text === streamed) continue
          streamed += event.text
        }
        if (event.type === "tool_call") {
          const mapped = mapCursorTool(event.name, advertised)
          if (mapped) {
            yield { ...event, name: mapped }
            child.kill()
            return
          }
          continue
        }
        if (event.type === "done") sawDone = true
        yield event
      }
    }
    const code = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null || child.signalCode) resolve(child.exitCode)
      else child.once("close", resolve)
    })
    if (!sawDone) {
      if (code && code !== 0) {
        const detail = stderr().trim().replace(/\s+/g, " ").slice(0, 500)
        yield { type: "error", message: detail ? `cursor-agent exited with code ${code}: ${detail}` : `cursor-agent exited with code ${code}` }
      }
      else yield { type: "done" }
    }
  }
}
