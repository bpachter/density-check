// Where structural knowledge exists for a protein — and where it is predicted.
//
// The honest framing this module has to preserve: an AlphaFold model is a
// PREDICTION, not a measurement. Everything else in this tool asks "what did
// the experiment see"; this asks "where has anyone looked at all, and where are
// we relying on a model instead". Those are different claims and the UI must
// never merge them into one number.
//
// What makes the join free: AlphaFold keys on UniProt accession, which is the
// same key the ligand index already uses.
//
// Both sources verified live with `Access-Control-Allow-Origin: *`.

import { parseCif, loopColumn } from './cif';

const AF_API = 'https://alphafold.ebi.ac.uk/api/prediction';
const PDBE_BEST = 'https://www.ebi.ac.uk/pdbe/api/mappings/best_structures';

export interface AlphaFoldSummary {
  accession: string;
  description: string;
  gene: string | null;
  organism: string | null;
  sequenceLength: number;
  /** Mean pLDDT over the model. */
  meanPlddt: number | null;
  fractions: { veryHigh: number; confident: number; low: number; veryLow: number } | null;
  /** URLs come FROM the API. Constructing them breaks: the DB is on v6 and
   *  hand-built v4 paths 404. */
  cifUrl: string | null;
  paeUrl: string | null;
  modelVersion: number | null;
  modelCreated: string | null;
}

export interface ExperimentalSpan {
  pdbId: string;
  chainId: string;
  method: string;
  resolution: number | null;
  start: number;
  end: number;
}

export interface Coverage {
  length: number;
  /** Per residue (1-indexed into a length+1 array): how many structures cover it. */
  depth: Uint16Array;
  /** Best (lowest) resolution covering each residue, or 0. */
  bestResolution: Float32Array;
  spans: ExperimentalSpan[];
  xrayCount: number;
  emCount: number;
}

export async function fetchAlphaFold(accession: string): Promise<AlphaFoldSummary | null> {
  const res = await fetch(`${AF_API}/${accession.toUpperCase()}`);
  if (!res.ok) return null;               // plenty of accessions have no model
  const list = await res.json() as any[];
  const e = list?.[0];
  if (!e) return null;

  const f = [e.fractionPlddtVeryHigh, e.fractionPlddtConfident, e.fractionPlddtLow, e.fractionPlddtVeryLow];
  return {
    accession: e.uniprotAccession ?? accession,
    description: e.uniprotDescription ?? '',
    gene: e.gene ?? null,
    organism: e.organismScientificName ?? null,
    sequenceLength: (e.uniprotSequence ?? e.sequence ?? '').length || (e.uniprotEnd ?? 0),
    meanPlddt: Number.isFinite(e.globalMetricValue) ? e.globalMetricValue : null,
    fractions: f.every((v) => Number.isFinite(v))
      ? { veryHigh: f[0], confident: f[1], low: f[2], veryLow: f[3] }
      : null,
    cifUrl: e.cifUrl ?? null,
    paeUrl: e.paeDocUrl ?? null,
    modelVersion: e.latestVersion ?? null,
    modelCreated: e.modelCreatedDate ?? null,
  };
}

/**
 * Per-residue pLDDT, read from the model's B-factor column — which is where
 * AlphaFold stores it. One value per residue, taken from the CA atom.
 *
 * This downloads the predicted model (hundreds of KB to a few MB), so it is
 * only ever called behind an explicit user action.
 */
export async function fetchPlddt(cifUrl: string): Promise<{ plddt: Float32Array; first: number; last: number } | null> {
  const res = await fetch(cifUrl);
  if (!res.ok) return null;
  const block = parseCif(await res.text());
  const site = block.loops.get('atom_site');
  if (!site) return null;

  const names = loopColumn(site, 'label_atom_id');
  const seqIds = loopColumn(site, 'label_seq_id');
  const b = loopColumn(site, 'B_iso_or_equiv');

  let maxSeq = 0;
  for (let i = 0; i < site.rowCount; i++) {
    const n = Number(seqIds[i]);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
  }
  const plddt = new Float32Array(maxSeq + 1);
  let first = Infinity;
  let last = 0;
  for (let i = 0; i < site.rowCount; i++) {
    if (names[i] !== 'CA') continue;
    const seq = Number(seqIds[i]);
    const value = Number(b[i]);
    if (!Number.isFinite(seq) || !Number.isFinite(value)) continue;
    plddt[seq] = value;
    if (seq < first) first = seq;
    if (seq > last) last = seq;
  }
  return { plddt, first: Number.isFinite(first) ? first : 0, last };
}

/** Experimental coverage of the sequence, from PDBe's UniProt mappings. */
export async function fetchCoverage(accession: string, length: number): Promise<Coverage | null> {
  const acc = accession.toUpperCase();
  const res = await fetch(`${PDBE_BEST}/${acc}`);
  if (!res.ok) return null;
  const json = await res.json() as Record<string, any[]>;
  const list = json?.[acc] ?? json?.[acc.toLowerCase()];
  if (!Array.isArray(list)) return null;

  // Several chains of the same entry cover the same span; count an entry once
  // per distinct span so "depth" means structures, not chains.
  const seen = new Set<string>();
  const spans: ExperimentalSpan[] = [];
  for (const s of list) {
    const start = Number(s.unp_start);
    const end = Number(s.unp_end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const key = `${s.pdb_id}:${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push({
      pdbId: String(s.pdb_id).toUpperCase(),
      chainId: s.chain_id ?? '',
      method: s.experimental_method ?? '',
      resolution: Number.isFinite(s.resolution) ? s.resolution : null,
      start, end,
    });
  }

  const size = Math.max(length, ...spans.map((s) => s.end)) + 1;
  const depth = new Uint16Array(size);
  const bestResolution = new Float32Array(size);
  let xrayCount = 0;
  let emCount = 0;

  for (const s of spans) {
    if (/x-ray/i.test(s.method)) xrayCount++;
    else if (/electron microscopy|em/i.test(s.method)) emCount++;
    for (let r = Math.max(1, s.start); r <= Math.min(size - 1, s.end); r++) {
      depth[r]++;
      if (s.resolution !== null && (bestResolution[r] === 0 || s.resolution < bestResolution[r])) {
        bestResolution[r] = s.resolution;
      }
    }
  }

  return { length: size - 1, depth, bestResolution, spans, xrayCount, emCount };
}

/** AlphaFold's own confidence bands, using their published thresholds. */
export function plddtBand(v: number): 'veryHigh' | 'confident' | 'low' | 'veryLow' {
  if (v >= 90) return 'veryHigh';
  if (v >= 70) return 'confident';
  if (v >= 50) return 'low';
  return 'veryLow';
}

export const PLDDT_COLOUR: Record<string, string> = {
  veryHigh: '#2f6fd0',
  confident: '#66c2e6',
  low: '#f4d35e',
  veryLow: '#f28b50',
};
