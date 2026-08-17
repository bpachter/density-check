// The validation gate.
//
// This tool's entire premise is that its number is worth more than the
// depositor's picture. A tool making that claim has to be able to prove its own
// arithmetic, in the user's browser, on the user's machine — not in a CI run
// they cannot see.
//
// So on load the app re-runs the full pipeline (fetch -> BinaryCIF decode ->
// axis reordering -> trilinear sampling -> per-atom sigma) against a reference
// entry and compares the result to fixtures generated only after the decoder
// was proven byte-identical to Mol*. If it does not reproduce them, the app
// refuses to display numbers. A silently wrong sigma is worse than no sigma.

import fixtures from './fixtures.json';
import { fetchLigand, fetchSurroundings, fetchDensity } from './rcsb';
import { buildReference, computeEvidence } from './evidence';

export interface GateResult {
  ok: boolean;
  checks: Array<{ name: string; expected: number; actual: number; tolerance: number; ok: boolean }>;
  error?: string;
  elapsedMs: number;
}

const REFERENCE = { entry: '1cbs', comp: 'REA' } as const;

export async function runValidationGate(): Promise<GateResult> {
  const started = performance.now();
  const checks: GateResult['checks'] = [];
  const expect = (fixtures as Record<string, any>)[`${REFERENCE.entry}/${REFERENCE.comp}`];

  try {
    const ligand = await fetchLigand(REFERENCE.entry, REFERENCE.comp);
    const [surroundings, maps] = await Promise.all([
      fetchSurroundings(REFERENCE.entry, REFERENCE.comp),
      fetchDensity(REFERENCE.entry, ligand.atoms),
    ]);
    const meanB = ligand.atoms.reduce((s, a) => s + a.b, 0) / ligand.atoms.length;
    const reference = buildReference(surroundings, maps.map2FoFc, meanB);
    const ev = computeEvidence(REFERENCE.entry, REFERENCE.comp, ligand.atoms, maps.map2FoFc, maps.mapFoFc, reference);

    const add = (name: string, expected: number, actual: number, tolerance: number) => {
      checks.push({ name, expected, actual, tolerance, ok: Math.abs(expected - actual) <= tolerance });
    };

    add('atom count', expect.atomCount, ev.atoms.length, 0);
    add('sigma of source map', expect.sigmaSource, maps.map2FoFc.sigmaSource, 1e-6);
    // The axis permutation shows up here first: a wrong order changes the
    // canonical sample counts, and every coordinate after it.
    add('grid samples (x)', expect.sampleCount[0], maps.map2FoFc.sampleCount[0], 0);
    add('grid samples (y)', expect.sampleCount[1], maps.map2FoFc.sampleCount[1], 0);
    add('grid samples (z)', expect.sampleCount[2], maps.map2FoFc.sampleCount[2], 0);
    add('mean density at atoms', expect.meanSigma, ev.meanSigma, 0.01);
    add('reference population', expect.referenceN, ev.reference?.n ?? 0, 0);

    for (const a of expect.atoms as Array<{ name: string; sigma2FoFc: number; sigmaFoFc: number }>) {
      const got = ev.atoms.find((x) => x.name === a.name);
      add(`${a.name} 2Fo-Fc`, a.sigma2FoFc, got?.sigma2FoFc ?? NaN, 0.005);
      add(`${a.name} Fo-Fc`, a.sigmaFoFc, got?.sigmaFoFc ?? NaN, 0.005);
    }

    return {
      ok: checks.every((c) => c.ok),
      checks,
      elapsedMs: performance.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      checks,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: performance.now() - started,
    };
  }
}
