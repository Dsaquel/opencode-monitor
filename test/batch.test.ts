import { describe, expect, test } from "bun:test"
import {
  appendBounded,
  clipLine,
  escapeAttribute,
  fitBatch,
  formatNotification,
  MAX_BYTES_PER_BATCH,
  MAX_CHARS_PER_LINE,
  MAX_LINES_PER_BATCH,
  type BoundedLines,
} from "../src/batch.js"
import type { MonitorID } from "../src/types.js"

const EMPTY: BoundedLines = { lines: [], dropped: 0 }

function fill(count: number, line: (i: number) => string): BoundedLines {
  return Array.from({ length: count }, (_, i) => line(i)).reduce(appendBounded, EMPTY)
}

describe("clipLine", () => {
  test("keeps short lines intact", () => {
    expect(clipLine("hello")).toBe("hello")
  })

  test("truncates long lines and reports how much was cut", () => {
    const clipped = clipLine("x".repeat(MAX_CHARS_PER_LINE + 10))
    expect(clipped.startsWith("x".repeat(MAX_CHARS_PER_LINE))).toBe(true)
    expect(clipped).toEndWith("[10 chars truncated]")
  })

  test("never splits a surrogate pair", () => {
    const line = `${"x".repeat(MAX_CHARS_PER_LINE - 1)}😀tail`
    const clipped = clipLine(line)
    expect(clipped.startsWith(`${"x".repeat(MAX_CHARS_PER_LINE - 1)}…`)).toBe(true)
  })
})

describe("appendBounded", () => {
  test("keeps only the newest lines and counts the dropped ones", () => {
    const buffer = fill(MAX_LINES_PER_BATCH + 5, (i) => `line ${i}`)
    expect(buffer.lines).toHaveLength(MAX_LINES_PER_BATCH)
    expect(buffer.lines[0]).toBe("line 5")
    expect(buffer.dropped).toBe(5)
  })

  test("does not mutate the previous buffer", () => {
    const before = fill(2, (i) => `line ${i}`)
    appendBounded(before, "next")
    expect(before.lines).toEqual(["line 0", "line 1"])
  })
})

describe("fitBatch", () => {
  test("keeps the newest lines within the byte budget", () => {
    const buffer = fill(MAX_LINES_PER_BATCH, (i) => `${i}:${"y".repeat(MAX_CHARS_PER_LINE - 10)}`)
    const batch = fitBatch(buffer)
    const bytes = batch.lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
    expect(bytes).toBeLessThanOrEqual(MAX_BYTES_PER_BATCH)
    expect(batch.lines.at(-1)).toStartWith(`${MAX_LINES_PER_BATCH - 1}:`)
    expect(batch.omitted).toBe(MAX_LINES_PER_BATCH - batch.lines.length)
  })

  test("always fits at least the newest line, even a huge one", () => {
    const batch = fitBatch(appendBounded(EMPTY, "z".repeat(1_000_000)))
    expect(batch.lines).toHaveLength(1)
    expect(batch.omitted).toBe(0)
  })

  test("includes lines dropped by the bounded buffer in the omitted count", () => {
    const batch = fitBatch(fill(MAX_LINES_PER_BATCH + 7, (i) => `${i}`))
    expect(batch.omitted).toBe(7)
  })
})

describe("formatNotification", () => {
  test("escapes attribute values so quotes in commands cannot break the header", () => {
    const text = formatNotification({
      monitorID: "mon-1" as MonitorID,
      description: `grep "error" <log> & more`,
      state: "streaming",
      totalLines: 3,
      batch: { lines: ["a", "b"], omitted: 1 },
    })
    expect(text).toBe(
      [
        `<monitor id="mon-1" description="grep &quot;error&quot; &lt;log&gt; &amp; more" state="streaming" totalLines="3">`,
        "[1 earlier lines omitted]",
        "a",
        "b",
        "</monitor>",
      ].join("\n"),
    )
  })

  test("flattens newlines in attributes", () => {
    expect(escapeAttribute("a\nb")).toBe("a b")
  })
})
