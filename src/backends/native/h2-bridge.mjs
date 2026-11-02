import http2 from "node:http2"
import readline from "node:readline"

const client = http2.connect(process.env.CURSOR_BACKEND_URL || "https://api2.cursor.sh")
client.on("error", (error) => {
  process.stdout.write(JSON.stringify({ type: "error", message: error.message }) + "\n")
})

function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\n")
}

const lines = readline.createInterface({ input: process.stdin })
lines.on("line", (line) => {
  let cmd
  try {
    cmd = JSON.parse(line)
  } catch {
    return
  }
  if (cmd.type !== "request") return
  const headers = {
    ":method": "POST",
    ":path": cmd.path,
    "content-type": cmd.contentType || "application/connect+proto",
    "connect-protocol-version": "1",
    authorization: cmd.authorization,
  }
  const request = client.request(headers)
  let pending = Buffer.alloc(0)
  let status
  const emitFrame = (frame) => {
    emit({ id: cmd.id, type: "data", status, data: frame.toString("base64") })
  }
  request.on("response", (responseHeaders) => {
    status = responseHeaders[":status"]
    emit({ id: cmd.id, type: "headers", status })
  })
  request.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 5) {
      const length = pending.readUInt32BE(1)
      const frameLength = 5 + length
      if (pending.length < frameLength) break
      emitFrame(pending.subarray(0, frameLength))
      pending = pending.subarray(frameLength)
    }
  })
  request.on("end", () => {
    if (pending.length) emitFrame(pending)
    emit({ id: cmd.id, type: "end" })
  })
  request.on("error", (error) => emit({ id: cmd.id, type: "error", message: error.message }))
  request.end(Buffer.from(cmd.body, "base64"))
})
