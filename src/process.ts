import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import type { BatchedNotifier } from "./notifier.js"

const SIGKILL_DELAY_MS = 3000

interface SpawnConfig {
  readonly command: string
  readonly cwd: string
  readonly timeout: number
  readonly filter: RegExp | undefined
  readonly until: RegExp | undefined
}

interface ProcessCallbacks {
  readonly onClose: (code: number | null, signal: NodeJS.Signals | null) => void
  readonly onError: (error: Error) => void
}

function matchesFilter(line: string, filter: RegExp | undefined): boolean {
  if (filter === undefined) return true
  return filter.test(line)
}

function attachLineReaders(
  child: ChildProcess,
  notifier: BatchedNotifier,
  config: SpawnConfig,
  callbacks: ProcessCallbacks,
): void {
  const handleLine = (line: string, prefix?: string) => {
    const text = prefix ? `${prefix} ${line}` : line
    if (config.until && config.until.test(line)) {
      notifier.push(text)
      killProcessGroup(child)
      return
    }
    if (matchesFilter(line, config.filter)) {
      notifier.push(text)
    }
  }

  if (child.stdout) {
    const reader = createInterface({ input: child.stdout })
    reader.on("line", (line) => handleLine(line))
  }

  if (child.stderr) {
    const reader = createInterface({ input: child.stderr })
    reader.on("line", (line) => handleLine(line, "[stderr]"))
  }

  child.on("error", callbacks.onError)
  // `close` fires after stdio streams end, unlike `exit`
  child.on("close", callbacks.onClose)
}

function killProcessGroup(child: ChildProcess): void {
  if (!child.pid) return
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, "SIGTERM")
    } else {
      child.kill("SIGTERM")
    }
  } catch {
    // Process may have already exited
  }

  setTimeout(() => {
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, "SIGKILL")
      } else {
        child.kill("SIGKILL")
      }
    } catch {
      // Process may have already exited
    }
  }, SIGKILL_DELAY_MS)
}

function createTimeout(
  child: ChildProcess,
  timeoutMs: number,
): ReturnType<typeof setTimeout> | null {
  if (timeoutMs <= 0) return null
  return setTimeout(() => killProcessGroup(child), timeoutMs)
}

export interface MonitorProcess {
  readonly process: ChildProcess
  readonly kill: () => void
}

export function spawnMonitor(
  config: SpawnConfig,
  notifier: BatchedNotifier,
  callbacks: ProcessCallbacks,
): MonitorProcess {
  const detached = process.platform !== "win32"
  const child = spawn(config.command, {
    shell: true,
    cwd: config.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached,
  })

  attachLineReaders(child, notifier, config, callbacks)

  const timeoutHandle = createTimeout(child, config.timeout)

  return {
    process: child,
    kill(): void {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle)
      }
      killProcessGroup(child)
    },
  }
}
