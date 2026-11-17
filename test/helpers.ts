import type { MonitorOptions, SessionID, SyntheticSender } from "../src/types.js"

export type SentNotification = Parameters<SyntheticSender>[0]

export const SESSION = "ses_test" as SessionID

export function recordingSender(): { readonly send: SyntheticSender; readonly sent: SentNotification[] } {
  const sent: SentNotification[] = []
  return {
    sent,
    send: async (input) => {
      sent.push(input)
    },
  }
}

export async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

export function finalNotification(sent: ReadonlyArray<SentNotification>): SentNotification | undefined {
  return sent.find((n) => n.metadata.state !== "streaming")
}

export function monitorOptions(overrides: Partial<MonitorOptions> & Pick<MonitorOptions, "command">): MonitorOptions {
  return {
    sessionID: SESSION,
    description: overrides.command,
    timeout: 0,
    interval: 50,
    filter: undefined,
    until: undefined,
    cwd: process.cwd(),
    ...overrides,
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
