import type { Tier } from "./contract.ts";

export function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Render a markdown table with one left-aligned row per finding. */
export function renderTable(headers: string[], rows: string[][]): string {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${row.join(" | ")} |`);
  }
  return lines.join("\n");
}

export function renderTotals(totals: Record<Tier, number>): string {
  return `**Totals:** Tier 0: ${totals[0]}, Tier 1: ${totals[1]}, Tier 2: ${totals[2]}`;
}
