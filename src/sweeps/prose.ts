import type { Detector, DetectorInput } from "../pipeline.ts";
import { detect as detectLychee } from "../adapters/lychee.ts";
import { detect as detectVale } from "../adapters/vale.ts";

const lycheeDetector: Detector = {
  name: "lychee",
  detect: (input: DetectorInput) => detectLychee(input),
};

const valeDetector: Detector = {
  name: "vale",
  detect: (input: DetectorInput) => detectVale(input),
};

/** Deterministic prose pre-flight. Agent axes run only on what these settle. */
export function proseDetectors(): Detector[] {
  return [lycheeDetector, valeDetector];
}
