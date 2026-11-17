import { createNotifier, type BatchedNotifier } from "./notifier.js"
import { spawnMonitor, type MonitorProcess, type OutputStream } from "./process.js"
import type {
  MonitorID,
  MonitorOptions,
  MonitorState,
  MonitorSummary,
  SessionID,
  StopReason,
  SyntheticSender,
} from "./types.js"

interface ManagedMonitor {
  readonly options: MonitorOptions
  readonly startedAt: number
  readonly process: MonitorProcess
  readonly notifier: BatchedNotifier
  readonly timeout: ReturnType<typeof setTimeout> | undefined
  readonly stopReason: StopReason | undefined
}

export interface MonitorManager {
  readonly start: (options: MonitorOptions) => MonitorID
  readonly stop: (id: MonitorID) => Promise<{ readonly lineCount: number } | undefined>
  readonly list: (sessionID?: SessionID) => ReadonlyArray<MonitorSummary>
  readonly stopSession: (sessionID: SessionID) => void
  readonly stopAll: () => Promise<void>
}

let counter = 0

function generateID(): MonitorID {
  counter += 1
  return `mon-${Date.now().toString(36)}-${counter.toString(36)}` as MonitorID
}

function resolveState(code: number | null, reason: StopReason | undefined): MonitorState {
  if (reason === "timeout") return "timeout"
  if (reason === "until") return "completed"
  if (reason !== undefined) return "cancelled"
  return code === 0 ? "completed" : "error"
}

function formatExitInfo(code: number | null, signal: NodeJS.Signals | null, reason: StopReason | undefined): string {
  const parts = [
    ...(code !== null ? [`exit code: ${code}`] : []),
    ...(signal !== null ? [`signal: ${signal}`] : []),
    ...(reason !== undefined ? [`reason: ${reason}`] : []),
  ]
  return parts.length > 0 ? `[${parts.join(", ")}]` : "[exited]"
}

function formatLine(line: string, stream: OutputStream): string {
  return stream === "stderr" ? `[stderr] ${line}` : line
}

export function createManager(send: SyntheticSender): MonitorManager {
  let monitors = new Map<MonitorID, ManagedMonitor>()

  function take(id: MonitorID): ManagedMonitor | undefined {
    const existing = monitors.get(id)
    if (!existing) return undefined
    const next = new Map(monitors)
    next.delete(id)
    monitors = next
    clearTimeout(existing.timeout)
    return existing
  }

  function takeWhere(predicate: (managed: ManagedMonitor) => boolean): ReadonlyArray<ManagedMonitor> {
    const ids = Array.from(monitors).filter(([, managed]) => predicate(managed)).map(([id]) => id)
    return ids.flatMap((id) => take(id) ?? [])
  }

  function requestStop(id: MonitorID, reason: StopReason): void {
    const existing = monitors.get(id)
    if (!existing || existing.stopReason !== undefined) return
    clearTimeout(existing.timeout)
    monitors = new Map(monitors).set(id, { ...existing, stopReason: reason, timeout: undefined })
    existing.process.kill()
  }

  function handleLine(id: MonitorID, line: string, stream: OutputStream): void {
    const managed = monitors.get(id)
    if (!managed || managed.stopReason !== undefined) return
    const { filter, until } = managed.options
    if (until?.test(line)) {
      managed.notifier.push(formatLine(line, stream))
      requestStop(id, "until")
      return
    }
    if (filter === undefined || filter.test(line)) managed.notifier.push(formatLine(line, stream))
  }

  function handleClose(id: MonitorID, code: number | null, signal: NodeJS.Signals | null): void {
    const managed = take(id)
    if (!managed) return
    const state = resolveState(code, managed.stopReason)
    void managed.notifier.flush(state, formatExitInfo(code, signal, managed.stopReason))
  }

  function handleError(id: MonitorID, error: Error): void {
    const managed = take(id)
    if (!managed) return
    managed.process.kill()
    void managed.notifier.flush("error", `[spawn error: ${error.message}]`)
  }

  return {
    start(options: MonitorOptions): MonitorID {
      const id = generateID()
      const notifier = createNotifier({
        monitorID: id,
        sessionID: options.sessionID,
        description: options.description,
        interval: options.interval,
        send,
      })

      let child: MonitorProcess
      try {
        child = spawnMonitor(
          { command: options.command, cwd: options.cwd },
          {
            onLine: (line, stream) => handleLine(id, line, stream),
            onClose: (code, signal) => handleClose(id, code, signal),
            onError: (error) => handleError(id, error),
          },
        )
      } catch (error) {
        notifier.dispose()
        throw error
      }

      const timeout = options.timeout > 0 ? setTimeout(() => requestStop(id, "timeout"), options.timeout) : undefined
      monitors = new Map(monitors).set(id, {
        options,
        startedAt: Date.now(),
        process: child,
        notifier,
        timeout,
        stopReason: undefined,
      })
      return id
    },

    async stop(id: MonitorID): Promise<{ readonly lineCount: number } | undefined> {
      const managed = take(id)
      if (!managed) return undefined
      managed.process.kill()
      await managed.notifier.flush("cancelled", formatExitInfo(null, null, "manual"))
      return { lineCount: managed.notifier.lineCount() }
    },

    list(sessionID?: SessionID): ReadonlyArray<MonitorSummary> {
      return Array.from(monitors)
        .filter(([, managed]) => sessionID === undefined || managed.options.sessionID === sessionID)
        .map(([id, managed]) => ({
          id,
          command: managed.options.command,
          sessionID: managed.options.sessionID,
          description: managed.options.description,
          startedAt: managed.startedAt,
          lineCount: managed.notifier.lineCount(),
        }))
    },

    stopSession(sessionID: SessionID): void {
      for (const managed of takeWhere((m) => m.options.sessionID === sessionID)) {
        managed.process.kill()
        managed.notifier.dispose()
      }
    },

    async stopAll(): Promise<void> {
      const stopped = takeWhere(() => true)
      for (const managed of stopped) managed.process.kill()
      await Promise.all(
        stopped.map((managed) => managed.notifier.flush("cancelled", formatExitInfo(null, null, "plugin-unload"))),
      )
    },
  }
}
