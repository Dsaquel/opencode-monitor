import type { Session } from "@opencode/schema/session"
import type { MonitorID, MonitorState, SyntheticSender } from "./types.js"

const MAX_LINES_PER_BATCH = 200
const MAX_BYTES_PER_BATCH = 32_000

interface NotifierConfig {
  readonly monitorID: MonitorID
  readonly sessionID: Session.ID
  readonly description: string
  readonly interval: number
  readonly send: SyntheticSender
}

interface NotifierState {
  readonly pendingLines: ReadonlyArray<string>
  readonly totalLines: number
  readonly timer: ReturnType<typeof setInterval> | null
  readonly disposed: boolean
  readonly inflight: Promise<unknown> | null
}

function formatNotification(
  monitorID: MonitorID,
  description: string,
  state: MonitorState,
  lines: ReadonlyArray<string>,
  totalLines: number,
  omitted: number,
): string {
  const header = `<monitor id="${monitorID}" description="${description}" state="${state}" totalLines="${totalLines}">`
  const footer = "</monitor>"
  const body = lines.join("\n")
  const omittedNote = omitted > 0 ? `\n[${omitted} lines omitted — too many for one batch]` : ""
  return `${header}\n${body}${omittedNote}\n${footer}`
}

function truncateLines(
  lines: ReadonlyArray<string>,
): { kept: ReadonlyArray<string>; omitted: number } {
  if (lines.length <= MAX_LINES_PER_BATCH) {
    let bytes = 0
    for (let i = 0; i < lines.length; i++) {
      bytes += lines[i].length + 1
      if (bytes > MAX_BYTES_PER_BATCH) {
        return { kept: lines.slice(0, i), omitted: lines.length - i }
      }
    }
    return { kept: lines, omitted: 0 }
  }
  const kept = lines.slice(lines.length - MAX_LINES_PER_BATCH)
  return { kept, omitted: lines.length - MAX_LINES_PER_BATCH }
}

function sendBatch(
  config: NotifierConfig,
  lines: ReadonlyArray<string>,
  totalLines: number,
  omitted: number,
  state: MonitorState,
  resume: boolean,
): Promise<unknown> {
  const text = formatNotification(
    config.monitorID,
    config.description,
    state,
    lines,
    totalLines,
    omitted,
  )
  return config.send({
    sessionID: config.sessionID,
    text,
    description: `[monitor:${config.monitorID}] ${config.description}`,
    metadata: {
      source: "monitor",
      monitorID: config.monitorID,
      state,
      totalLines,
    },
    delivery: "steer",
    resume,
  })
}

export interface BatchedNotifier {
  readonly push: (line: string) => void
  readonly flush: (state: MonitorState, extra?: string) => Promise<void>
  readonly dispose: () => void
  readonly lineCount: () => number
}

export function createNotifier(input: {
  readonly monitorID: MonitorID
  readonly sessionID: Session.ID
  readonly description: string
  readonly interval?: number
  readonly send: SyntheticSender
}): BatchedNotifier {
  const config: NotifierConfig = {
    monitorID: input.monitorID,
    sessionID: input.sessionID,
    description: input.description,
    interval: input.interval ?? 3000,
    send: input.send,
  }

  let state: NotifierState = {
    pendingLines: [],
    totalLines: 0,
    timer: null,
    disposed: false,
    inflight: null,
  }

  function drainPending(): { lines: ReadonlyArray<string>; omitted: number } {
    const { kept, omitted } = truncateLines(state.pendingLines)
    state = { ...state, pendingLines: [] }
    return { lines: kept, omitted }
  }

  async function tick(): Promise<void> {
    if (state.disposed || state.pendingLines.length === 0) return
    const { lines, omitted } = drainPending()
    const promise = sendBatch(config, lines, state.totalLines, omitted, "streaming", false)
      .catch(() => {})
    state = { ...state, inflight: promise }
    await promise
    state = { ...state, inflight: null }
  }

  const timer = setInterval(() => void tick(), config.interval)
  state = { ...state, timer }

  return {
    push(line: string): void {
      if (state.disposed) return
      state = {
        ...state,
        pendingLines: [...state.pendingLines, line],
        totalLines: state.totalLines + 1,
      }
    },

    async flush(finalState: MonitorState, extra?: string): Promise<void> {
      if (state.disposed) return
      if (state.timer !== null) {
        clearInterval(state.timer)
      }
      state = { ...state, timer: null, disposed: true }

      if (state.inflight) {
        await state.inflight.catch(() => {})
      }

      const { lines, omitted } = drainPending()
      const finalLines = extra
        ? [...lines, extra]
        : lines.length > 0
          ? lines
          : [`Process exited (state: ${finalState})`]

      await sendBatch(config, finalLines, state.totalLines, omitted, finalState, true)
        .catch(() => {})
    },

    dispose(): void {
      if (state.timer !== null) {
        clearInterval(state.timer)
      }
      state = { ...state, timer: null, disposed: true }
    },

    lineCount(): number {
      return state.totalLines
    },
  }
}
