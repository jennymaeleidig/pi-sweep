import type { FindingDraft } from "../contract.ts";
import { detect as detectJscpd } from "../adapters/jscpd.ts";
import { detect as detectLinters } from "../adapters/linters.ts";
import {
  detectZeroFanout,
  type LensClient,
} from "../adapters/zero-fanout.ts";
import type { Detector, DetectorInput } from "../pipeline.ts";

export interface CodeSweepOptions {
  lens?: LensClient;
}

/**
 * The code-sweep pre-flight: repo-declared linters, duplication, and
 * pi-lens zero-fanout with string-grep corroboration.
 */
export function codeDetectors(options: CodeSweepOptions = {}): Detector[] {
  let unavailable: string[] = [];

  const zeroFanout: Detector = {
    name: "zero-fanout",
    async detect(input: DetectorInput): Promise<FindingDraft[]> {
      const result = await detectZeroFanout({ ...input, lens: options.lens });
      unavailable = result.available
        ? []
        : [result.reason ?? "pi-lens module_report is unavailable"];
      return result.drafts;
    },
    async unavailable(): Promise<string[]> {
      return unavailable;
    },
  };

  return [
    { name: "linters", detect: (input) => detectLinters(input) },
    { name: "jscpd", detect: (input) => detectJscpd(input) },
    zeroFanout,
  ];
}
