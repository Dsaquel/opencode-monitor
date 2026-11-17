import { appendBounded, fitBatch, formatNotification, type Batch, type BoundedLines } from "./batch.js"
import type { MonitorID, MonitorState, SessionID, SyntheticSender } from "./types.js"

export interface NotifierConfig {
  readonly monitorID: MonitorID
  readonly sessionID: SessionID
  readonly description: string
  readonly interval: number
  readonly send: SyntheticSender
}

interface NotifierState {
  readonly pending: BoundedLines
  readonly totalLines: number
  readonly disposed: boolean
  readonly inflight: Promise<void> | null
}

export interface BatchedNotifier {
  readonly push: (line: string) => void
  readonly flush: (state: MonitorState, extra: string) => Promise<void>
  readonly dispose: () => void
  readonly lineCount: () => number
}

const EMPTY: BoundedLines = { lines: [], dropped: 0 }

function sendBatch(
  config: NotifierConfig,
  batch: Batch,
  totalLines: number,
  state: MonitorState,
  resume: boolean,
): Promise<void> {
  const text = formatNotification({
    monitorID: config.monitorID,
    description: config.description,
    state,
    totalLines,
    batch,
  })
  return config
    .send({
      sessionID: config.sessionID,
      text,
      description: `[monitor:${config.monitorID}] ${config.description}`,
      metadata: { source: "monitor", monitorID: config.monitorID, state, totalLines },
      delivery: "steer",
      resume,
    })
    .then(
      () => undefined,
      (error: unknown) => {
        console.error(`[opencode-monitor] failed to deliver ${state} notification for ${config.monitorID}:`, error)
      },
    )
}

export function createNotifier(config: NotifierConfig): BatchedNotifier {
  let state: NotifierState = { pending: EMPTY, totalLines: 0, disposed: false, inflight: null }

  function drain(): Batch {
    const batch = fitBatch(state.pending)
    state = { ...state, pending: EMPTY }
    return batch
  }

  async function tick(): Promise<void> {
    if (state.disposed || state.inflight !== null || state.pending.lines.length === 0) return
    const inflight = sendBatch(config, drain(), state.totalLines, "streaming", false)
    state = { ...state, inflight }
    await inflight
    state = { ...state, inflight: null }
  }

  const timer = setInterval(() => void tick(), config.interval)

  function stop(): void {
    clearInterval(timer)
    state = { ...state, disposed: true }
  }

  return {
    push(line: string): void {
      if (state.disposed) return
      state = { ...state, pending: appendBounded(state.pending, line), totalLines: state.totalLines + 1 }
    },

    async flush(finalState: MonitorState, extra: string): Promise<void> {
      if (state.disposed) return
      stop()
      if (state.inflight !== null) await state.inflight
      const batch = drain()
      await sendBatch(config, { ...batch, lines: [...batch.lines, extra] }, state.totalLines, finalState, true)
    },

    dispose: stop,

    lineCount(): number {
      return state.totalLines
    },
  }
}
