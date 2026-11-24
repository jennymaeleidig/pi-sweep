/**
 * The exact text of lines [start, end] from file content, preserving a
 * trailing newline only when the fragment stops before the last line.
 */
export function fragmentText(
  content: string,
  start: number,
  end: number,
): string | undefined {
  const lines = content.split("\n");
  if (start < 1 || end < start || start > lines.length) {
    return undefined;
  }
  const selected = lines.slice(start - 1, end);
  if (selected.length === 0) {
    return undefined;
  }
  const trailing = end < lines.length ? "\n" : "";
  return `${selected.join("\n")}${trailing}`;
}
