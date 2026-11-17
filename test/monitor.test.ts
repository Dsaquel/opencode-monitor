import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createManager, type MonitorManager } from "../src/monitor.js"
import type { SessionID } from "../src/types.js"
import { finalNotification, isAlive, monitorOptions, recordingSender, SESSION, waitFor } from "./helpers.js"

const managers: MonitorManager[] = []

function setup() {
  const recorder = recordingSender()
  const manager = createManager(recorder.send)
  managers.push(manager)
  return { ...recorder, manager }
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stopAll()))
})

describe("final state", () => {
  test("a command that exits 0 before its timeout completes", async () => {
    const { manager, sent } = setup()
    manager.start(monitorOptions({ command: "echo done", timeout: 10_000 }))
    const final = await waitFor(() => finalNotification(sent))
    expect(final.metadata.state).toBe("completed")
    expect(final.text).toContain("done")
    expect(final.text).toContain("[exit code: 0]")
    expect(final.resume).toBe(true)
  })

  test("a non-zero exit is an error", async () => {
    const { manager, sent } = setup()
    manager.start(monitorOptions({ command: "exit 3" }))
    const final = await waitFor(() => finalNotification(sent))
    expect(final.metadata.state).toBe("error")
    expect(final.text).toContain("[exit code: 3]")
  })

  test("a command that never matches until and fails is an error, not completed", async () => {
    const { manager, sent } = setup()
    manager.start(monitorOptions({ command: "echo nope; exit 1", until: /READY/ }))
    const final = await waitFor(() => finalNotification(sent))
    expect(final.metadata.state).toBe("error")
  })

  test("a timeout kills the process and reports timeout", async () => {
    const { manager, sent } = setup()
    manager.start(monitorOptions({ command: "sleep 30", timeout: 200 }))
    const final = await waitFor(() => finalNotification(sent))
    expect(final.metadata.state).toBe("timeout")
    expect(final.text).toContain("reason: timeout")
    expect(manager.list()).toHaveLength(0)
  })

  test("a spawn failure is reported as an error", async () => {
    const { manager, sent } = setup()
    manager.start(monitorOptions({ command: "echo hi", cwd: "/definitely/not/a/dir" }))
    const final = await waitFor(() => finalNotification(sent))
    expect(final.metadata.state).toBe("error")
    expect(final.text).toContain("spawn error")
  })
})

describe("line handling", () => {
  test("until delivers the matching line, stops the process and ignores later output", async () => {
    const { manager, sent } = setup()
    manager.start(monitorOptions({ command: "echo starting; echo READY; echo after; sleep 30", description: "t", until: /READY/ }))
    const final = await waitFor(() => finalNotification(sent))
    const all = sent.map((n) => n.text).join("\n")
    expect(final.metadata.state).toBe("completed")
    expect(all).toContain("READY")
    expect(all).not.toContain("after")
    expect(final.text).toContain("reason: until")
  })

  test("filter only delivers matching lines and stderr is prefixed", async () => {
    const { manager, sent } = setup()
    manager.start(monitorOptions({ command: "echo keep 1; echo drop; echo keep 2 >&2", description: "t", filter: /keep/ }))
    await waitFor(() => finalNotification(sent))
    const all = sent.map((n) => n.text).join("\n")
    expect(all).toContain("keep 1")
    expect(all).toContain("[stderr] keep 2")
    expect(all).not.toContain("drop")
    expect(finalNotification(sent)?.metadata.totalLines).toBe(2)
  })

  test("streaming batches do not wake the session", async () => {
    const { manager, sent } = setup()
    manager.start(monitorOptions({ command: "echo one; sleep 0.4; echo two" }))
    await waitFor(() => finalNotification(sent))
    const streaming = sent.filter((n) => n.metadata.state === "streaming")
    expect(streaming.length).toBeGreaterThan(0)
    expect(streaming.every((n) => n.resume === false)).toBe(true)
  })
})

describe("stopping", () => {
  test("stop kills the whole process group and reports cancelled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "monitor-test-"))
    const pidFile = path.join(dir, "pid")
    try {
      const { manager, sent } = setup()
      const id = manager.start(monitorOptions({ command: `sleep 30 & echo $! > ${pidFile}; wait` }))
      const grandchild = await waitFor(
        async () => Number((await readFile(pidFile, "utf8").catch(() => "")).trim()) || undefined,
      )
      expect(isAlive(grandchild)).toBe(true)

      const result = await manager.stop(id)
      expect(result).toEqual({ lineCount: 0 })
      expect(finalNotification(sent)?.metadata.state).toBe("cancelled")
      await waitFor(() => (isAlive(grandchild) ? undefined : true))
      expect(await manager.stop(id)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("stopSession silently stops only that session's monitors", async () => {
    const { manager, sent } = setup()
    const other = "ses_other" as SessionID
    manager.start(monitorOptions({ command: "sleep 30" }))
    manager.start(monitorOptions({ command: "sleep 30", sessionID: other }))

    manager.stopSession(SESSION)
    expect(manager.list().map((m) => m.sessionID)).toEqual([other])
    await Bun.sleep(100)
    expect(sent).toHaveLength(0)
  })

  test("stopAll notifies every monitor that the plugin unloaded", async () => {
    const { manager, sent } = setup()
    manager.start(monitorOptions({ command: "sleep 30" }))
    manager.start(monitorOptions({ command: "sleep 30" }))
    await manager.stopAll()
    expect(sent).toHaveLength(2)
    expect(sent.every((n) => n.metadata.state === "cancelled" && n.text.includes("plugin-unload"))).toBe(true)
    expect(manager.list()).toHaveLength(0)
  })

  test("list filters by session and reports line counts", async () => {
    const { manager } = setup()
    const id = manager.start(monitorOptions({ command: "echo a; echo b; sleep 30" }))
    manager.start(monitorOptions({ command: "sleep 30", sessionID: "ses_other" as SessionID }))
    await waitFor(() => (manager.list(SESSION)[0]?.lineCount === 2 ? true : undefined))
    expect(manager.list(SESSION).map((m) => m.id)).toEqual([id])
    expect(manager.list()).toHaveLength(2)
  })
})
