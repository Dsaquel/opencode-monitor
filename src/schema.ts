import { Schema } from "effect"

export const DEFAULT_INTERVAL_MS = 3000
export const MIN_INTERVAL_MS = 500
export const DEFAULT_TIMEOUT_MS = 0

export const MonitorInput = Schema.Struct({
  command: Schema.String.annotate({
    description: "Shell command to run and monitor in the background",
  }),
  description: Schema.optionalKey(Schema.String).annotate({
    description: "Human-readable label for notifications",
  }),
  timeout: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: `Timeout in milliseconds. 0 means no timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
  }),
  interval: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_INTERVAL_MS))).annotate({
    description: `Minimum interval between notifications in ms (>= ${MIN_INTERVAL_MS}). Defaults to ${DEFAULT_INTERVAL_MS}.`,
  }),
  filter: Schema.optionalKey(Schema.String).annotate({
    description: "Regex pattern; only lines matching this pattern are delivered",
  }),
  until: Schema.optionalKey(Schema.String).annotate({
    description:
      "Regex pattern; when a line matches (stdout or stderr), it is delivered and the monitor completes",
  }),
})

export const MonitorOutput = Schema.Struct({
  monitorID: Schema.String,
  status: Schema.Literal("monitoring"),
})

export const StopInput = Schema.Struct({
  monitorID: Schema.String.annotate({
    description: "The monitor ID returned by the monitor tool",
  }),
})

export const StopOutput = Schema.Struct({
  monitorID: Schema.String,
  status: Schema.String,
})

export const ListInput = Schema.Struct({
  all: Schema.optionalKey(Schema.Boolean).annotate({
    description: "If true, list monitors across all sessions. Default: current session only.",
  }),
})

export const ListOutput = Schema.Struct({
  monitors: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      command: Schema.String,
      description: Schema.String,
      startedAt: Schema.Number,
      lineCount: Schema.Number,
    }),
  ),
})
