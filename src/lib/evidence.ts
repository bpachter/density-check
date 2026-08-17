// Per-atom evidence: how much of the experimental measurement stands behind
// each atom of a modelled ligand.
//
// The honest framing, which the UI must repeat:
//
//   - 2Fo-Fc is the map the depositor refined INTO. It contains the ligand it
//     is being used to judge, so high density there is partly circular. It
//     answers "is there density here", not "is the model unbiased".
//   - Fo-Fc is the difference map: positive means unmodelled density (something
//     is there that the model does not explain), negative means the model puts
//     an atom where the experiment saw nothing. Negative Fo-Fc on a ligand atom
//     is the least model-biased evidence of a wrong atom we can get from these
//     two maps, so the UI leads with it.
//   - Raw sigma is NOT comparable between entries: it confounds resolution,
//     B-factor, occupancy and atomic number. Cross-entry ranking must use the
//     published normalised metrics (RSCC/RSR/RSZD). Within one map, sigma is a
//     legitimate localisation signal, and that is all we use it for.

import { type DensityGrid, sampleSigma } from './volume';

export interface Atom {
  name: string;
  element: string;
  pos: [number, number, number];
  b: number;
  occupancy: number;
  /** Residue identity, needed to join against PDBe's residue-level contacts. */
  compId: string;
  authSeqId: number;
  authAsymId: string;
}

export interface AtomEvidence extends Atom {
  /** 2Fo-Fc value at the atom centre, in sigma of the source map. */
  sigma2FoFc: number;
  /** Fo-Fc value at the atom centre, in sigma. Negative = modelled into nothing. */
  sigmaFoFc: number;
  /**
   * Within-map z-score against well-ordered protein atoms of the SAME element
   * in a comparable B-factor range. Null when there is no comparable reference
   * population — which is honest, not a failure.
   */
  z: number | null;
}

export interface LigandEvidence {
  entry: string;
  comp: string;
  atoms: AtomEvidence[];
  /** Fraction of atoms under 1 sigma in 2Fo-Fc. */
  fractionWeak: number;
  meanSigma: number;
  /** Atoms with Fo-Fc below -3 sigma: modelled where nothing was measured. */
  refuted: AtomEvidence[];
  /** Present only when the reference population was large enough to be meaningful. */
  reference: ReferencePopulation | null;
}

export interface ReferencePopulation {
  /** Per element: mean and sd of 2Fo-Fc sigma over well-ordered protein atoms. */
  byElement: Map<string, { mean: number; sd: number; n: number }>;
  bRange: [number, number];
  n: number;
}

/**
 * Build the within-map reference from surrounding protein atoms.
 * Only atoms in a comparable B-factor band count: a correctly modelled carbon
 * at B=70 legitimately sits lower than one at B=15, and comparing across that
 * gap is how a tool becomes most confidently wrong exactly where it matters.
 */
export function buildReference(
  proteinAtoms: Atom[],
  grid: DensityGrid,
  ligandB: number,
  bTolerance = 15,
): ReferencePopulation | null {
  const bLo = ligandB - bTolerance;
  const bHi = ligandB + bTolerance;
  const buckets = new Map<string, number[]>();

  for (const a of proteinAtoms) {
    if (a.b < bLo || a.b > bHi) continue;
    if (a.occupancy < 0.99) continue;
    const s = sampleSigma(grid, a.pos);
    if (!Number.isFinite(s)) continue;
    if (!buckets.has(a.element)) buckets.set(a.element, []);
    buckets.get(a.element)!.push(s);
  }

  const byElement = new Map<string, { mean: number; sd: number; n: number }>();
  let total = 0;
  for (const [element, values] of buckets) {
    // Under ~20 samples the sd is noise; refuse rather than publish a z-score
    // built on nothing.
    if (values.length < 20) continue;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
    byElement.set(element, { mean, sd: Math.sqrt(variance), n: values.length });
    total += values.length;
  }

  if (!byElement.size) return null;
  return { byElement, bRange: [bLo, bHi], n: total };
}

export function computeEvidence(
  entry: string,
  comp: string,
  ligandAtoms: Atom[],
  map2FoFc: DensityGrid,
  mapFoFc: DensityGrid,
  reference: ReferencePopulation | null,
): LigandEvidence {
  const atoms: AtomEvidence[] = ligandAtoms.map((a) => {
    const sigma2FoFc = sampleSigma(map2FoFc, a.pos);
    const sigmaFoFc = sampleSigma(mapFoFc, a.pos);
    const ref = reference?.byElement.get(a.element);
    const z = ref && ref.sd > 1e-6 ? (sigma2FoFc - ref.mean) / ref.sd : null;
    return { ...a, sigma2FoFc, sigmaFoFc, z };
  });

  const finite = atoms.filter((a) => Number.isFinite(a.sigma2FoFc));
  const meanSigma = finite.length
    ? finite.reduce((s, a) => s + a.sigma2FoFc, 0) / finite.length
    : NaN;

  return {
    entry,
    comp,
    atoms,
    meanSigma,
    fractionWeak: finite.length ? finite.filter((a) => a.sigma2FoFc < 1).length / finite.length : NaN,
    refuted: atoms.filter((a) => Number.isFinite(a.sigmaFoFc) && a.sigmaFoFc < -3),
    reference,
  };
}

/** A one-line verdict, deliberately conservative in its wording. */
export function verdict(e: LigandEvidence): { label: string; tone: 'supported' | 'partial' | 'unsupported' } {
  if (!Number.isFinite(e.meanSigma)) return { label: 'no density available', tone: 'partial' };
  if (e.refuted.length) {
    return { label: `${e.refuted.length} atom${e.refuted.length > 1 ? 's' : ''} modelled into negative difference density`, tone: 'unsupported' };
  }
  if (e.fractionWeak > 0.3) return { label: `${Math.round(e.fractionWeak * 100)}% of atoms below 1σ`, tone: 'unsupported' };
  if (e.fractionWeak > 0.05) return { label: `${Math.round(e.fractionWeak * 100)}% of atoms below 1σ`, tone: 'partial' };
  return { label: 'every atom supported above 1σ', tone: 'supported' };
}
