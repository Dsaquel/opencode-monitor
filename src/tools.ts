import type { PermissionDomain } from "@opencode/plugin/promise/permission"
import { Error as ToolError, type Info, type ToolEditor } from "@opencode/plugin/promise/tool"
import type { MonitorManager } from "./monitor.js"
import { shellResources } from "./permission.js"
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  ListInput,
  ListOutput,
  MonitorInput,
  MonitorOutput,
  StopInput,
  StopOutput,
} from "./schema.js"
import type { MonitorID, MonitorOptions, SessionID } from "./types.js"

export interface ToolDeps {
  readonly manager: MonitorManager
  readonly cwd: string
  readonly assertPermission: PermissionDomain["assert"]
}

const MONITOR_DESCRIPTION = [
  "Start a background monitor that streams output from a shell command in real time.",
  "Returns a monitor ID immediately.",
  "Output is delivered as periodic <monitor> notifications while the command runs, and a final notification arrives when it exits, matches `until`, times out, or is stopped.",
  "Use filter/until regexes to control which lines are delivered and when to stop.",
  "The command runs through the system shell (/bin/sh on Unix) with output piped, so prefer line-buffered output (grep --line-buffered, python -u, stdbuf -oL).",
  "Shell permission rules apply to the command.",
].join(" ")

function parseRegex(field: string, pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined) return undefined
  try {
    return new RegExp(pattern)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ToolError({ message: `Invalid ${field} regex: ${reason}` })
  }
}

function buildOptions(input: typeof MonitorInput.Type, sessionID: SessionID, cwd: string): MonitorOptions {
  if (input.command.trim().length === 0) throw new ToolError({ message: "Command must not be empty" })
  return {
    command: input.command,
    sessionID,
    cwd,
    description: input.description ?? input.command,
    timeout: input.timeout ?? DEFAULT_TIMEOUT_MS,
    interval: input.interval ?? DEFAULT_INTERVAL_MS,
    filter: parseRegex("filter", input.filter),
    until: parseRegex("until", input.until),
  }
}

function monitorTool(deps: ToolDeps): Info<typeof MonitorInput, typeof MonitorOutput> {
  return {
    name: "monitor",
    description: MONITOR_DESCRIPTION,
    input: MonitorInput,
    output: MonitorOutput,
    options: { permission: "shell", codemode: false },

    async execute(input, context) {
      const options = buildOptions(input, context.sessionID, deps.cwd)
      const resources = shellResources(options.command)
      await deps.assertPermission({
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
        action: "shell",
        resources,
        save: resources,
        metadata: { command: options.command, description: options.description, cwd: deps.cwd },
      })
      if (context.signal.aborted) throw new ToolError({ message: "Monitor was cancelled before it started" })

      const id = deps.manager.start(options)
      return {
        output: { monitorID: id, status: "monitoring" },
        content: [
          {
            type: "text",
            text: [
              `Monitor started (ID: ${id}).`,
              `Command: ${options.command}`,
              `Working directory: ${deps.cwd}`,
              "Notifications will arrive periodically. Continue with other work.",
              "DO NOT poll for status. Use monitor_list to check active monitors.",
            ].join("\n"),
          },
        ],
        metadata: { monitorID: id, status: "monitoring" },
      }
    },
  }
}

function stopTool(deps: ToolDeps): Info<typeof StopInput, typeof StopOutput> {
  return {
    name: "monitor_stop",
    description: "Stop a running background monitor by its ID.",
    input: StopInput,
    output: StopOutput,
    options: { codemode: false },

    async execute(input) {
      const result = await deps.manager.stop(input.monitorID as MonitorID)
      if (!result) {
        return {
          output: { monitorID: input.monitorID, status: "not_found" },
          content: [{ type: "text", text: `No active monitor with ID: ${input.monitorID}` }],
          metadata: { monitorID: input.monitorID, status: "not_found" },
        }
      }
      return {
        output: { monitorID: input.monitorID, status: "cancelled" },
        content: [{ type: "text", text: `Monitor ${input.monitorID} stopped. ${result.lineCount} lines captured.` }],
        metadata: { monitorID: input.monitorID, status: "cancelled", lineCount: result.lineCount },
      }
    },
  }
}

function listTool(deps: ToolDeps): Info<typeof ListInput, typeof ListOutput> {
  return {
    name: "monitor_list",
    description: "List all active background monitors for the current session.",
    input: ListInput,
    output: ListOutput,
    options: { codemode: false },

    async execute(input, context) {
      const monitors = deps.manager.list(input.all ? undefined : context.sessionID).map((m) => ({
        id: m.id,
        command: m.command,
        description: m.description,
        startedAt: m.startedAt,
        lineCount: m.lineCount,
      }))
      const text =
        monitors.length === 0
          ? "No active monitors."
          : monitors.map((m) => `- ${m.id}: ${m.description} (${m.lineCount} lines)`).join("\n")
      return {
        output: { monitors },
        content: [{ type: "text", text }],
        metadata: { count: monitors.length },
      }
    },
  }
}

export function registerTools(editor: ToolEditor, deps: ToolDeps): void {
  editor.add(monitorTool(deps))
  editor.add(stopTool(deps))
  editor.add(listTool(deps))
}
