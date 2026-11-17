const CONTROL_OPERATOR = /\|\||&&|\$\(|(?<![<>])&|[;|\n`()]/
const LEADING_KEYWORDS = /^(?:(?:if|then|elif|else|do|while|until|time|!|\{)\s+)+/
const NON_COMMAND = /^(?:fi|done|esac|then|else|do|\}|[<>]+)$/

export function shellResources(command: string): ReadonlyArray<string> {
  const segments = command
    .split(CONTROL_OPERATOR)
    .map((segment) => segment.trim().replace(LEADING_KEYWORDS, "").trim())
    .filter((segment) => segment.length > 0 && !NON_COMMAND.test(segment))
  return segments.length > 0 ? Array.from(new Set(segments)) : [command.trim()]
}
