import type { Session } from "@opencode/schema/session"
import type {
  ActiveMonitor,
  MonitorID,
  MonitorOptions,
  MonitorResult,
  MonitorState,
  StopReason,
  SyntheticSender,
} from "./types.js"
import { createNotifier, type BatchedNotifier } from "./notifier.js"
import { spawnMonitor, type MonitorProcess } from "./process.js"

let counter = 0

function generateID(): MonitorID {
  counter += 1
  const timestamp = Date.now().toString(36)
  const seq = counter.toString(36)
  return `mon-${timestamp}-${seq}` as MonitorID
}

interface ManagedMonitor {
  readonly monitor: ActiveMonitor
  readonly process: MonitorProcess
  readonly notifier: BatchedNotifier
  readonly stopReason: StopReason
}

export interface MonitorManager {
  readonly start: (options: MonitorOptions) => MonitorResult
  readonly stop: (id: MonitorID) => Promise<MonitorResult | undefined>
  readonly list: (sessionID?: Session.ID) => ReadonlyArray<ActiveMonitor & { readonly lineCount: number }>
  readonly stopAll: () => Promise<void>
  readonly stopSession: (sessionID: Session.ID) => Promise<void>
}

export function createManager(send: SyntheticSender): MonitorManager {
  let monitors = new Map<MonitorID, ManagedMonitor>()

  function removeMonitor(id: MonitorID): ManagedMonitor | undefined {
    const existing = monitors.get(id)
    if (!existing) return undefined
    const next = new Map(monitors)
    next.delete(id)
    monitors = next
    return existing
  }

  function resolveState(code: number | null, signal: NodeJS.Signals | null, reason: StopReason): MonitorState {
    if (reason === "timeout") return "timeout"
    if (reason === "manual" || reason === "session-deleted" || reason === "plugin-unload") return "cancelled"
    if (reason === "until") return "completed"
    if (code === 0) return "completed"
    if (signal) return "error"
    return "error"
  }

  function formatExitInfo(code: number | null, signal: NodeJS.Signals | null, reason: StopReason): string {
    const parts: string[] = []
    if (code !== null) parts.push(`exit code: ${code}`)
    if (signal) parts.push(`signal: ${signal}`)
    if (reason !== "natural") parts.push(`reason: ${reason}`)
    return parts.length > 0 ? parts.join(", ") : "exited"
  }

  async function finalize(
    managed: ManagedMonitor,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const state = resolveState(code, signal, managed.stopReason)
    const extra = formatExitInfo(code, signal, managed.stopReason)
    try {
      await managed.notifier.flush(state, extra)
    } catch {
      // Notification delivery failure is non-fatal (session may be gone)
    }
  }

  function handleClose(
    id: MonitorID,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const managed = removeMonitor(id)
    if (!managed) return
    void finalize(managed, code, signal)
  }

  function handleError(id: MonitorID, error: Error): void {
    const managed = removeMonitor(id)
    if (!managed) return
    void managed.notifier.flush("error", `spawn error: ${error.message}`).catch(() => {})
  }

  function setStopReason(id: MonitorID, reason: StopReason): void {
    const existing = monitors.get(id)
    if (!existing) return
    monitors = new Map(monitors).set(id, { ...existing, stopReason: reason })
  }

  return {
    start(options: MonitorOptions): MonitorResult {
      const id = generateID()

      const notifier = createNotifier({
        monitorID: id,
        sessionID: options.sessionID,
        description: options.description,
        interval: options.interval,
        send,
      })

      let monitorProcess: MonitorProcess
      try {
        monitorProcess = spawnMonitor(
          {
            command: options.command,
            cwd: options.cwd,
            timeout: options.timeout,
            filter: options.filter,
            until: options.until,
          },
          notifier,
          {
            onClose: (code, signal) => handleClose(id, code, signal),
            onError: (error) => handleError(id, error),
          },
        )
      } catch (error) {
        notifier.dispose()
        throw error
      }

      const stopReason: StopReason = options.until ? "until" : options.timeout > 0 ? "timeout" : "natural"

      const activeMonitor: ActiveMonitor = {
        id,
        command: options.command,
        sessionID: options.sessionID,
        description: options.description,
        state: "streaming",
        process: monitorProcess.process,
        startedAt: Date.now(),
      }

      monitors = new Map(monitors).set(id, {
        monitor: activeMonitor,
        process: monitorProcess,
        notifier,
        stopReason,
      })

      return {
        id,
        state: "streaming",
        exitCode: null,
        signal: null,
        lineCount: 0,
        stopReason,
      }
    },

    async stop(id: MonitorID): Promise<MonitorResult | undefined> {
      setStopReason(id, "manual")
      const managed = removeMonitor(id)
      if (!managed) return undefined

      managed.process.kill()
      await managed.notifier.flush("cancelled", "stopped by user")
        .catch(() => {})

      return {
        id,
        state: "cancelled",
        exitCode: null,
        signal: null,
        lineCount: managed.notifier.lineCount(),
        stopReason: "manual",
      }
    },

    list(sessionID?: Session.ID): ReadonlyArray<ActiveMonitor & { readonly lineCount: number }> {
      const entries = Array.from(monitors.values())
      const filtered = sessionID === undefined
        ? entries
        : entries.filter((m) => m.monitor.sessionID === sessionID)
      return filtered.map((m) => ({
        ...m.monitor,
        lineCount: m.notifier.lineCount(),
      }))
    },

    async stopAll(): Promise<void> {
      const entries = Array.from(monitors.values())
      monitors = new Map()
      for (const m of entries) {
        m.process.kill()
        m.notifier.dispose()
      }
    },

    async stopSession(sessionID: Session.ID): Promise<void> {
      const toStop: ManagedMonitor[] = []
      const remaining = new Map<MonitorID, ManagedMonitor>()
      for (const [id, managed] of monitors) {
        if (managed.monitor.sessionID === sessionID) {
          toStop.push(managed)
        } else {
          remaining.set(id, managed)
        }
      }
      monitors = remaining
      for (const m of toStop) {
        m.process.kill()
        m.notifier.dispose()
      }
    },
  }
}
