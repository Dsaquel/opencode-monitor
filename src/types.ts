import type { ChildProcess } from "node:child_process"
import type { Session } from "@opencode/schema/session"

export type MonitorID = string & { readonly __brand: "MonitorID" }

export type MonitorState = "streaming" | "completed" | "error" | "cancelled" | "timeout"

export type StopReason = "natural" | "until" | "timeout" | "manual" | "session-deleted" | "plugin-unload"

export interface MonitorOptions {
  readonly command: string
  readonly sessionID: Session.ID
  readonly description: string
  readonly timeout: number
  readonly interval: number
  readonly filter: RegExp | undefined
  readonly until: RegExp | undefined
  readonly cwd: string
}

export interface ActiveMonitor {
  readonly id: MonitorID
  readonly command: string
  readonly sessionID: Session.ID
  readonly description: string
  readonly state: MonitorState
  readonly process: ChildProcess
  readonly startedAt: number
}

export interface MonitorResult {
  readonly id: MonitorID
  readonly state: MonitorState
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly lineCount: number
  readonly stopReason: StopReason
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | Array<JsonValue>
  | { [key: string]: JsonValue }

export type SyntheticSender = (input: {
  readonly sessionID: Session.ID
  readonly text: string
  readonly description: string
  readonly metadata: { [key: string]: JsonValue }
  readonly delivery: "steer" | "queue"
  readonly resume?: boolean
}) => Promise<unknown>
