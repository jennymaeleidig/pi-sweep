/**
 * The single findings contract shared by detectors, the gate, apply, and
 * sub-agent exemption manifests. Findings are plain JSON-serializable data.
 */

export type Tier = 0 | 1 | 2;

export type GateAction = "apply" | "skip" | "ask";

export interface Finding {
  id: string;
  file: string;
  line: number;
  rule: string;
  evidence: string;
  tier: Tier;
  detector: string;
  category?: string;
  proposedFix?: string;
  action?: GateAction;
  reason?: string;
}

/** A detector's normalized output, before identity and tier policy are applied. */
export type FindingDraft = Omit<Finding, "id" | "tier" | "action">;

export interface GateFile {
  file: string;
  findings: Finding[];
}

export interface GateTable {
  files: GateFile[];
  totals: Record<Tier, number>;
}

export interface SweepReport {
  mode: "diff" | "full";
  baseRef: string | null;
  resolvedBase: string | null;
  files: string[];
  findings: Finding[];
  gate: GateTable;
}
