import type { ToolContext } from "@opencode/plugin/promise/tool"

export type SessionID = ToolContext["sessionID"]

export type MonitorID = string & { readonly __brand: "MonitorID" }

export type MonitorState = "streaming" | "completed" | "error" | "cancelled" | "timeout"

export type StopReason = "until" | "timeout" | "manual" | "plugin-unload"

export interface MonitorOptions {
  readonly command: string
  readonly sessionID: SessionID
  readonly description: string
  readonly timeout: number
  readonly interval: number
  readonly filter: RegExp | undefined
  readonly until: RegExp | undefined
  readonly cwd: string
}

export interface MonitorSummary {
  readonly id: MonitorID
  readonly command: string
  readonly sessionID: SessionID
  readonly description: string
  readonly startedAt: number
  readonly lineCount: number
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | Array<JsonValue>
  | { [key: string]: JsonValue }

export type SyntheticSender = (input: {
  readonly sessionID: SessionID
  readonly text: string
  readonly description: string
  readonly metadata: { [key: string]: JsonValue }
  readonly delivery: "steer" | "queue"
  readonly resume?: boolean
}) => Promise<unknown>
