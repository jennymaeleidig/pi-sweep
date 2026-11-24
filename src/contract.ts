/**
 * The single findings contract shared by detectors, the gate, apply, and
 * sub-agent exemption manifests. Findings are plain JSON-serializable data.
 */

export type Tier = 0 | 1 | 2;

/** Which sweep charter produced a finding. */
export type SweepCharter = "code" | "test" | "prose";

export type GateAction = "apply" | "skip" | "ask";

/** How a detector proved its finding: mechanically, or by agent judgment. */
export type EvidenceClass = "machine" | "agent";

/** A single structured text replacement a finding can apply and revert. */
export interface FindingEdit {
  oldText: string;
  newText: string;
}

export interface Finding {
  id: string;
  file: string;
  line: number;
  rule: string;
  evidence: string;
  tier: Tier;
  detector: string;
  /** How the detector proved this finding; machine evidence tiers below agent judgment. */
  evidenceClass?: EvidenceClass;
  /** Origin charter, set when findings from several sweeps are merged. */
  sweep?: SweepCharter;
  category?: string;
  proposedFix?: string;
  /** Detector-supplied measurements used by tier policy (duplicate size, etc.). */
  metrics?: { tokens?: number; lines?: number };
  edit?: FindingEdit;
  action?: GateAction;
  reason?: string;
}

import type { CommandRunner } from "./exec.ts";

/** Input every detector receives from the pipeline. */
export interface DetectorInput {
  files: string[];
  cwd: string;
  runner: CommandRunner;
  /** Extra no-assertion hook locations, consulted before the default candidates. */
  hookPaths?: string[];
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
  /** Detector coverage that was unavailable; absence is never reported as clean. */
  unavailable?: string[];
  detectors?: DetectorStatus[];
}

/** Whether a detector could run, so an unavailable tool is not mistaken for a clean one. */
export interface DetectorStatus {
  name: string;
  available: boolean;
  reason?: string;
}
