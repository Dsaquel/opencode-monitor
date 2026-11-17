import type { MonitorID, MonitorState } from "./types.js"

export const MAX_LINES_PER_BATCH = 200
export const MAX_BYTES_PER_BATCH = 32_000
export const MAX_CHARS_PER_LINE = 4_000

export interface Batch {
  readonly lines: ReadonlyArray<string>
  readonly omitted: number
}

export interface BoundedLines {
  readonly lines: ReadonlyArray<string>
  readonly dropped: number
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

export function clipLine(line: string): string {
  if (line.length <= MAX_CHARS_PER_LINE) return line
  const end = isHighSurrogate(line.charCodeAt(MAX_CHARS_PER_LINE - 1)) ? MAX_CHARS_PER_LINE - 1 : MAX_CHARS_PER_LINE
  return `${line.slice(0, end)}… [${line.length - end} chars truncated]`
}

export function appendBounded(buffer: BoundedLines, line: string): BoundedLines {
  const lines = [...buffer.lines, clipLine(line)]
  const overflow = Math.max(0, lines.length - MAX_LINES_PER_BATCH)
  return { lines: overflow > 0 ? lines.slice(overflow) : lines, dropped: buffer.dropped + overflow }
}

export function fitBatch(buffer: BoundedLines): Batch {
  let bytes = 0
  let start = buffer.lines.length
  while (start > 0) {
    const size = Buffer.byteLength(buffer.lines[start - 1], "utf8") + 1
    if (bytes + size > MAX_BYTES_PER_BATCH) break
    bytes += size
    start -= 1
  }
  return { lines: buffer.lines.slice(start), omitted: buffer.dropped + start }
}

export function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", " ")
}

export function formatNotification(input: {
  readonly monitorID: MonitorID
  readonly description: string
  readonly state: MonitorState
  readonly totalLines: number
  readonly batch: Batch
}): string {
  const attributes = [
    `id="${escapeAttribute(input.monitorID)}"`,
    `description="${escapeAttribute(input.description)}"`,
    `state="${input.state}"`,
    `totalLines="${input.totalLines}"`,
  ].join(" ")
  const omittedNote = input.batch.omitted > 0 ? [`[${input.batch.omitted} earlier lines omitted]`] : []
  const body = [...omittedNote, ...input.batch.lines].join("\n")
  return `<monitor ${attributes}>\n${body}\n</monitor>`
}
