import { Plugin } from "@opencode/plugin"
import type { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { Schema } from "effect"
import { createManager } from "./monitor.js"
import type { MonitorID, MonitorOptions, SyntheticSender } from "./types.js"

const DEFAULT_INTERVAL_MS = 3000
const MIN_INTERVAL_MS = 500
const DEFAULT_TIMEOUT_MS = 0

const MonitorInput = Schema.Struct({
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

const MonitorOutput = Schema.Struct({
  monitorID: Schema.String,
  status: Schema.Literal("monitoring"),
})

const StopInput = Schema.Struct({
  monitorID: Schema.String.annotate({
    description: "The monitor ID returned by the monitor tool",
  }),
})

const StopOutput = Schema.Struct({
  monitorID: Schema.String,
  status: Schema.String,
})

const ListInput = Schema.Struct({
  all: Schema.optionalKey(Schema.Boolean).annotate({
    description: "If true, list monitors across all sessions. Default: current session only.",
  }),
})

const ListOutput = Schema.Struct({
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

function parseRegex(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined) return undefined
  try {
    return new RegExp(pattern)
  } catch {
    throw new Tool.Error({ message: `Invalid regex pattern: ${pattern}` })
  }
}

function buildOptions(
  input: typeof MonitorInput.Type,
  sessionID: Session.ID,
  cwd: string,
): MonitorOptions {
  return {
    command: input.command,
    sessionID,
    cwd,
    description: input.description ?? input.command,
    timeout: input.timeout ?? DEFAULT_TIMEOUT_MS,
    interval: input.interval ?? DEFAULT_INTERVAL_MS,
    filter: parseRegex(input.filter),
    until: parseRegex(input.until),
  }
}

function validateMonitorInput(input: typeof MonitorInput.Type): void {
  if (!input.command || input.command.trim().length === 0) {
    throw new Tool.Error({ message: "Command must not be empty" })
  }
}

export default Plugin.define({
  id: "opencode-monitor",

  async setup(ctx) {
    const send: SyntheticSender = (input) =>
      ctx.session.synthetic({
        sessionID: input.sessionID,
        text: input.text,
        description: input.description,
        metadata: input.metadata,
        delivery: input.delivery,
        resume: input.resume,
      })

    const manager = createManager(send)
    const cwd = ctx.location.directory

    const abortController = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abortController.signal })) {
          if (event.type === "session.deleted") {
            void manager.stopSession(event.data.sessionID as Session.ID)
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error("[opencode-monitor] event stream error:", error)
        }
      }
    })()

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "monitor",
        description: [
          "Start a background monitor that streams output from a shell command in real time.",
          "Returns a monitor ID immediately.",
          "Output is delivered as periodic notifications while the command runs.",
          "Use filter/until regexes to control which lines are delivered and when to stop.",
          "WARNING: This tool spawns shell commands. Review commands carefully before use.",
        ].join(" "),
        input: MonitorInput,
        output: MonitorOutput,
        options: { permission: "shell", codemode: false },

        async execute(input, context) {
          validateMonitorInput(input)
          const options = buildOptions(input, context.sessionID, cwd)
          const result = manager.start(options)

          return {
            output: {
              monitorID: result.id,
              status: "monitoring" as const,
            },
            content: [
              {
                type: "text" as const,
                text: [
                  `Monitor started (ID: ${result.id}).`,
                  `Command: ${input.command}`,
                  `Working directory: ${cwd}`,
                  `Notifications will arrive periodically. Continue with other work.`,
                  `DO NOT poll for status. Use monitor_list to check active monitors.`,
                ].join("\n"),
              },
            ],
            metadata: { monitorID: result.id, status: "monitoring" },
          }
        },
      })

      editor.add({
        name: "monitor_stop",
        description: "Stop a running background monitor by its ID.",
        input: StopInput,
        output: StopOutput,
        options: { codemode: false },

        async execute(input) {
          const result = await manager.stop(input.monitorID as MonitorID)
          if (!result) {
            return {
              output: { monitorID: input.monitorID, status: "not_found" },
              content: [{ type: "text" as const, text: `No active monitor with ID: ${input.monitorID}` }],
              metadata: { monitorID: input.monitorID, status: "not_found" },
            }
          }
          return {
            output: { monitorID: input.monitorID, status: "cancelled" },
            content: [{ type: "text" as const, text: `Monitor ${input.monitorID} stopped. ${result.lineCount} lines captured.` }],
            metadata: { monitorID: input.monitorID, status: "cancelled", lineCount: result.lineCount },
          }
        },
      })

      editor.add({
        name: "monitor_list",
        description: "List all active background monitors for the current session.",
        input: ListInput,
        output: ListOutput,
        options: { codemode: false },

        async execute(input, context) {
          const active = manager.list(input.all ? undefined : context.sessionID)
          const monitors = active.map((m) => ({
            id: m.id,
            command: m.command,
            description: m.description,
            startedAt: m.startedAt,
            lineCount: m.lineCount,
          }))
          const text = monitors.length === 0
            ? "No active monitors."
            : monitors.map((m) => `- ${m.id}: ${m.description} (${m.lineCount} lines)`).join("\n")
          return {
            output: { monitors },
            content: [{ type: "text" as const, text }],
            metadata: { count: monitors.length },
          }
        },
      })
    })

    return async () => {
      abortController.abort()
      await manager.stopAll()
    }
  },
})
