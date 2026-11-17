import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"

const SIGKILL_DELAY_MS = 3000
const IS_WINDOWS = process.platform === "win32"

export type OutputStream = "stdout" | "stderr"

export interface SpawnConfig {
  readonly command: string
  readonly cwd: string
}

export interface ProcessCallbacks {
  readonly onLine: (line: string, stream: OutputStream) => void
  readonly onClose: (code: number | null, signal: NodeJS.Signals | null) => void
  readonly onError: (error: Error) => void
}

export interface MonitorProcess {
  readonly kill: () => void
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH"
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    if (IS_WINDOWS) child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (!isMissingProcess(error)) {
      console.error(`[opencode-monitor] failed to send ${signal} to process group ${child.pid}:`, error)
    }
  }
}

function readLines(stream: Readable | null, onLine: (line: string) => void): void {
  if (stream === null) return
  createInterface({ input: stream, crlfDelay: Infinity }).on("line", onLine)
}

export function spawnMonitor(config: SpawnConfig, callbacks: ProcessCallbacks): MonitorProcess {
  const child = spawn(config.command, {
    shell: true,
    cwd: config.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !IS_WINDOWS,
  })

  let closed = false
  let escalation: ReturnType<typeof setTimeout> | undefined

  readLines(child.stdout, (line) => callbacks.onLine(line, "stdout"))
  readLines(child.stderr, (line) => callbacks.onLine(line, "stderr"))
  child.on("error", callbacks.onError)
  child.on("close", (code, signal) => {
    closed = true
    if (escalation !== undefined) clearTimeout(escalation)
    callbacks.onClose(code, signal)
  })

  return {
    kill(): void {
      if (closed || escalation !== undefined) return
      signalGroup(child, "SIGTERM")
      escalation = setTimeout(() => signalGroup(child, "SIGKILL"), SIGKILL_DELAY_MS)
    },
  }
}
