import { Plugin } from "@opencode/plugin"
import { createManager, type MonitorManager } from "./monitor.js"
import { registerTools } from "./tools.js"
import type { SessionID, SyntheticSender } from "./types.js"

function watchDeletedSessions(ctx: Plugin.Context, manager: MonitorManager, signal: AbortSignal): void {
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ types: ["session.deleted"], signal })) {
        manager.stopSession(event.data.sessionID as SessionID)
      }
    } catch (error) {
      if (!signal.aborted) console.error("[opencode-monitor] event stream error:", error)
    }
  })()
}

export default Plugin.define({
  id: "opencode-monitor",

  async setup(ctx) {
    const send: SyntheticSender = (input) => ctx.session.synthetic(input)
    const manager = createManager(send)
    const abortController = new AbortController()

    watchDeletedSessions(ctx, manager, abortController.signal)

    await ctx.tool.transform((editor) =>
      registerTools(editor, {
        manager,
        cwd: ctx.location.directory,
        assertPermission: (input) => ctx.permission.assert(input),
      }),
    )

    return async () => {
      abortController.abort()
      await manager.stopAll()
    }
  },
})
