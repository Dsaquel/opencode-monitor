import { afterEach, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { Error as ToolError, type Info, type ToolContext, type ToolEditor } from "@opencode/plugin/promise/tool"
import plugin from "../src/index.js"
import { finalNotification, recordingSender, SESSION, waitFor, type SentNotification } from "./helpers.js"

type AssertInput = Parameters<Plugin.Context["permission"]["assert"]>[0]
type DeletedEvent = { readonly type: "session.deleted"; readonly data: { readonly sessionID: string } }

interface Harness {
  readonly tools: Map<string, Info>
  readonly asserts: AssertInput[]
  readonly sent: SentNotification[]
  readonly subscriptions: Array<{ readonly types?: ReadonlyArray<string> }>
  readonly emit: (event: DeletedEvent) => void
  readonly cleanup: () => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

function eventStream(signal: AbortSignal | undefined) {
  const queue: DeletedEvent[] = []
  let wake: (() => void) | undefined
  const iterable = (async function* () {
    while (!signal?.aborted) {
      const next = queue.shift()
      if (next) yield next
      else await new Promise<void>((resolve) => (wake = resolve))
    }
  })()
  signal?.addEventListener("abort", () => wake?.())
  return { iterable, push: (event: DeletedEvent) => (queue.push(event), wake?.()) }
}

async function load(decide: (input: AssertInput) => Promise<void> = async () => {}): Promise<Harness> {
  const tools = new Map<string, Info>()
  const asserts: AssertInput[] = []
  const subscriptions: Array<{ readonly types?: ReadonlyArray<string> }> = []
  const { send, sent } = recordingSender()
  let push: (event: DeletedEvent) => void = () => {}

  const editor = { add: (tool: Info) => tools.set(tool.name, tool) } as unknown as ToolEditor
  const ctx = {
    location: { directory: process.cwd() },
    session: { synthetic: send },
    permission: { assert: async (input: AssertInput) => (asserts.push(input), decide(input)) },
    tool: { transform: async (callback: (editor: ToolEditor) => void) => callback(editor) },
    event: {
      subscribe: (options: { types?: ReadonlyArray<string>; signal?: AbortSignal }) => {
        subscriptions.push(options)
        const stream = eventStream(options.signal)
        push = stream.push
        return stream.iterable
      },
    },
  } as unknown as Plugin.Context

  const cleanup = (await plugin.setup(ctx)) as () => Promise<void>
  cleanups.push(cleanup)
  return { tools, asserts, sent, subscriptions, emit: (event) => push(event), cleanup }
}

function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: SESSION,
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    signal: new AbortController().signal,
    progress: async () => {},
    ...overrides,
  } as ToolContext
}

async function run(harness: Harness, name: string, input: unknown, context = toolContext()) {
  const tool = harness.tools.get(name)
  if (!tool) throw new Error(`tool ${name} was not registered`)
  return tool.execute(input as never, context)
}

describe("plugin", () => {
  test("registers the three monitor tools and subscribes only to session.deleted", async () => {
    const harness = await load()
    expect([...harness.tools.keys()]).toEqual(["monitor", "monitor_stop", "monitor_list"])
    expect(harness.tools.get("monitor")?.options).toEqual({ permission: "shell", codemode: false })
    expect(harness.subscriptions.map((s) => s.types)).toEqual([["session.deleted"]])
  })

  test("asks for shell permission on every command segment before spawning", async () => {
    const harness = await load()
    const result = await run(harness, "monitor", { command: "echo hi | tr a-z A-Z", description: "shout" })
    expect(harness.asserts).toEqual([
      {
        sessionID: SESSION,
        agent: "build",
        source: { type: "tool", messageID: "msg_1", id: "call_1" },
        action: "shell",
        resources: ["echo hi", "tr a-z A-Z"],
        save: ["echo hi", "tr a-z A-Z"],
        metadata: { command: "echo hi | tr a-z A-Z", description: "shout", cwd: process.cwd() },
      },
    ])
    expect(result.output).toMatchObject({ status: "monitoring" })
    const final = await waitFor(() => finalNotification(harness.sent))
    expect(final.text).toContain("HI")
    expect(final.description).toContain("shout")
  })

  test("a denied permission propagates and nothing is spawned", async () => {
    const harness = await load(async () => {
      throw new ToolError({ message: "denied by rule" })
    })
    await expect(run(harness, "monitor", { command: "echo hi" })).rejects.toThrow("denied by rule")
    expect((await run(harness, "monitor_list", {})).content).toEqual([{ type: "text", text: "No active monitors." }])
  })

  test("invalid regexes fail before asking for permission", async () => {
    const harness = await load()
    await expect(run(harness, "monitor", { command: "echo hi", filter: "(" })).rejects.toBeInstanceOf(ToolError)
    await expect(run(harness, "monitor", { command: "   " })).rejects.toThrow("Command must not be empty")
    expect(harness.asserts).toHaveLength(0)
  })

  test("an interrupted call does not start a monitor after permission resolves", async () => {
    const controller = new AbortController()
    const harness = await load(async () => controller.abort())
    await expect(run(harness, "monitor", { command: "sleep 30" }, toolContext({ signal: controller.signal }))).rejects.toThrow(
      "cancelled before it started",
    )
    expect((await run(harness, "monitor_list", { all: true })).output).toEqual({ monitors: [] })
  })

  test("monitor_stop and monitor_list round-trip", async () => {
    const harness = await load()
    const started = await run(harness, "monitor", { command: "sleep 30" })
    const monitorID = (started.output as { monitorID: string }).monitorID
    const listed = await run(harness, "monitor_list", {})
    expect((listed.output as { monitors: Array<{ id: string }> }).monitors.map((m) => m.id)).toEqual([monitorID])

    const stopped = await run(harness, "monitor_stop", { monitorID })
    expect(stopped.output).toEqual({ monitorID, status: "cancelled" })
    expect((await run(harness, "monitor_stop", { monitorID })).output).toEqual({ monitorID, status: "not_found" })
  })

  test("deleting a session stops its monitors without notifying", async () => {
    const harness = await load()
    await run(harness, "monitor", { command: "sleep 30" })
    harness.emit({ type: "session.deleted", data: { sessionID: SESSION } })
    await waitFor(async () => {
      const listed = await run(harness, "monitor_list", { all: true })
      return (listed.output as { monitors: unknown[] }).monitors.length === 0 ? true : undefined
    })
    expect(harness.sent).toHaveLength(0)
  })

  test("cleanup notifies running monitors that the plugin unloaded", async () => {
    const harness = await load()
    await run(harness, "monitor", { command: "sleep 30" })
    await harness.cleanup()
    expect(harness.sent.map((n) => n.metadata.state)).toEqual(["cancelled"])
    expect(harness.sent[0]?.text).toContain("plugin-unload")
  })
})
