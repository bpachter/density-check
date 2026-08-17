// Client-side target lookup against the precomputed index.
//
// One request for an accession, two for a gene or protein name. No manifest to
// download first — the shard is addressed by hashing the key, so the first
// byte fetched is already the answer.
//
// Range requests were considered and rejected on evidence: GitHub Pages applies
// Range to the COMPRESSED representation, and since Accept-Encoding is a
// forbidden header the browser cannot opt out. A ranged fetch fails outright
// with ERR_CONTENT_DECODING_FAILED. Hash-bucketed whole files avoid the problem
// entirely and Pages gzips them transparently.

import {
  ligandShard, nameShard, normaliseName, looksLikeAccession,
  dequantiseRscc, dequantiseUnit, shellOf, sizeOf, ABSENT,
  FLAG_SOI, FLAG_HAS_RSCC, FLAG_XRAY, FLAG_EM, FLAG_ADDITIVE, FLAG_PRIMARY_TARGET,
} from './bucket';

export interface IndexMeta {
  v: number;
  built: string;
  shells: number[];
  counts: Record<string, number>;
  reference: { rule: string; perShell: number[]; minPerShell: number };
  cdfRscc: number[][];
  cdfRsccBySize?: Array<Array<number[] | null>>;
  sizes?: number[];
}

export interface TargetLigand {
  entry: string;
  comp: string;
  compName: string | null;
  chain: string;
  seq: number;
  rscc: number | null;
  rsr: number | null;
  rcsbFit: number | null;
  natoms: number | null;
  targets: number;
  resolution: number | null;
  year: number | null;
  isSubject: boolean;
  isAdditive: boolean;
  isPrimary: boolean;
  isXray: boolean;
  isEm: boolean;
  /** Percentile among comparable ligands, 0..100. Null = unscored. */
  percentile: number | null;
  /** Whether that percentile is size-aware or resolution-only. */
  percentileBasis: 'size' | 'resolution' | null;
}

export interface TargetResult {
  accession: string;
  protein: string;
  gene: string;
  organism: string;
  ligands: TargetLigand[];
  /** Rows excluded from the main list because they are ions/buffers. */
  additiveCount: number;
  unscoredCount: number;
}

const BASE = new URL('index/', document.baseURI).href;

let metaPromise: Promise<IndexMeta> | null = null;
let compsPromise: Promise<Record<string, [string, number | null]>> | null = null;
const shardCache = new Map<string, Promise<any>>();

export function loadMeta(): Promise<IndexMeta> {
  metaPromise ??= fetch(`${BASE}meta.json`).then((r) => {
    if (!r.ok) throw new Error(`index metadata unavailable (HTTP ${r.status})`);
    return r.json();
  });
  return metaPromise;
}

function loadComps(): Promise<Record<string, [string, number | null]>> {
  // Deliberately not awaited before first paint: the list renders from comp
  // ids immediately and names fill in when this lands.
  compsPromise ??= fetch(`${BASE}comps.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return compsPromise;
}

function loadShard(dir: 'lig' | 'name', shard: string): Promise<any> {
  const key = `${dir}/${shard}`;
  let p = shardCache.get(key);
  if (!p) {
    p = fetch(`${BASE}${key}.json`).then((r) => {
      if (r.status === 404) return null;   // an empty bucket is a real answer
      if (!r.ok) throw new Error(`index shard ${key}: HTTP ${r.status}`);
      return r.json();
    });
    shardCache.set(key, p);
  }
  return p;
}

/** Resolve free text to candidate accessions. */
export async function resolveTarget(input: string): Promise<string[]> {
  const raw = input.trim();
  if (!raw) return [];
  if (looksLikeAccession(raw)) return [raw.toUpperCase()];

  const key = normaliseName(raw);
  if (!key) return [];
  const shard = await loadShard('name', nameShard(key));
  return shard?.n?.[key] ?? [];
}

/**
 * Percentile of a quantised RSCC among comparable ligands.
 *
 * Comparable means same resolution shell AND same size bucket where the index
 * has enough reference ligands for that cell — RSCC depends on how many atoms
 * are being correlated, so a 6-atom fragment and a 60-atom macrocycle are not
 * judged against each other. Where a cell is thin, this falls back to the
 * resolution-only table rather than inventing a distribution, and reports
 * which basis it used so the UI can say so.
 */
function percentileOf(
  meta: IndexMeta, q: number, resolutionHundredths: number, natoms: number,
): { value: number; basis: 'size' | 'resolution' } | null {
  if (q === ABSENT) return null;
  const shell = shellOf(resolutionHundredths === 65535 ? null : resolutionHundredths / 100);

  const cell = meta.cdfRsccBySize?.[shell]?.[sizeOf(natoms === ABSENT ? null : natoms)];
  if (cell?.length) return { value: (cell[q] / 65535) * 100, basis: 'size' };

  const table = meta.cdfRscc[shell];
  if (!table?.length) return null;
  if (table[254] === 0) return null;                // shell had too few references
  return { value: (table[q] / 65535) * 100, basis: 'resolution' };
}

// ── cryo-EM, deliberately a separate lookup ─────────────────────────
// Q-score measures how well an atom sits in a cryo-EM potential map;
// RSCC measures correlation with a crystallographic map. Every instance has
// one or the other, never both, and the two are not on a common scale. So this
// is a parallel index and a parallel ranking, and the UI shows them apart.

export interface EmLigand {
  entry: string;
  emdb: string;
  comp: string;
  compName: string | null;
  chain: string;
  seq: number;
  qScore: number | null;
  resolution: number | null;
  year: number | null;
  isSubject: boolean;
  isAdditive: boolean;
  targets: number;
  /** Percentile of this Q-score among EM ligands at comparable resolution. */
  percentile: number | null;
}

export interface EmMeta {
  v: number;
  metric: string;
  shells: number[];
  counts: Record<string, number>;
  reference: { rule: string; perShell: number[]; minPerShell: number };
  cdfQ: number[][];
}

let emMetaPromise: Promise<EmMeta | null> | null = null;

function loadEmMeta(): Promise<EmMeta | null> {
  emMetaPromise ??= fetch(`${BASE}em-meta.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return emMetaPromise;
}

function emShellOf(shells: number[], resolution: number | null): number {
  if (resolution === null || !Number.isFinite(resolution)) return shells.length;
  for (let i = 0; i < shells.length; i++) if (resolution < shells[i]) return i;
  return shells.length;
}

export async function fetchEmTarget(accession: string): Promise<EmLigand[]> {
  const acc = accession.toUpperCase();
  const [meta, shard] = await Promise.all([
    loadEmMeta(),
    fetch(`${BASE}em/${ligandShard(acc)}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const range = shard?.A?.[acc];
  if (!range || !meta) return [];

  const [start, count] = range;
  const comps = await loadComps().catch(() => ({} as Record<string, [string, number | null]>));
  const out: EmLigand[] = [];

  for (let i = start; i < start + count; i++) {
    const q = shard.q[i];
    const resolution = shard.R[i] === 65535 ? null : shard.R[i] / 100;
    const table = meta.cdfQ[emShellOf(meta.shells, resolution)];
    const comp = shard.C[shard.c[i]];
    out.push({
      entry: shard.E[shard.e[i]],
      emdb: shard.M?.[shard.m[i]] ?? '',
      comp,
      compName: comps[comp]?.[0] ?? null,
      chain: shard.h[i],
      seq: shard.s[i],
      qScore: dequantiseRscc(q),
      resolution,
      year: shard.y[i] === ABSENT ? null : shard.y[i] + 1970,
      isSubject: (shard.f[i] & FLAG_SOI) !== 0,
      isAdditive: (shard.f[i] & FLAG_ADDITIVE) !== 0,
      targets: shard.g[i],
      percentile: table?.length && table[254] !== 0 ? (table[q] / 65535) * 100 : null,
    });
  }

  out.sort((a, b) => {
    const an = a.percentile === null, bn = b.percentile === null;
    if (an !== bn) return an ? 1 : -1;
    if (!an && !bn && a.percentile !== b.percentile) return a.percentile! - b.percentile!;
    return (a.qScore ?? 1) - (b.qScore ?? 1);
  });
  return out;
}

export { loadEmMeta };

export async function fetchTarget(accession: string): Promise<TargetResult | null> {
  const acc = accession.toUpperCase();
  const [meta, shard] = await Promise.all([loadMeta(), loadShard('lig', ligandShard(acc))]);
  const range = shard?.A?.[acc];
  if (!range) return null;

  const [start, count] = range;
  const [protein, gene, organism] = shard.D?.[acc] ?? ['', '', ''];
  const comps = await loadComps().catch(() => ({} as Record<string, [string, number | null]>));

  const ligands: TargetLigand[] = [];
  let additiveCount = 0;
  let unscoredCount = 0;

  for (let i = start; i < start + count; i++) {
    const flags = shard.f[i];
    const comp = shard.C[shard.c[i]];
    const resolution = shard.R[i] === 65535 ? null : shard.R[i] / 100;
    const q = shard.q[i];
    const isAdditive = (flags & FLAG_ADDITIVE) !== 0;
    const pct = percentileOf(meta, q, shard.R[i], shard.n[i]);
    if (isAdditive) additiveCount++;
    if (!(flags & FLAG_HAS_RSCC)) unscoredCount++;

    ligands.push({
      entry: shard.E[shard.e[i]],
      comp,
      compName: comps[comp]?.[0] ?? null,
      chain: shard.h[i],
      seq: shard.s[i],
      rscc: dequantiseRscc(q),
      rsr: dequantiseUnit(shard.r[i]),
      rcsbFit: dequantiseUnit(shard.k[i]),
      natoms: shard.n[i] === ABSENT ? null : shard.n[i],
      targets: shard.g[i],
      resolution,
      year: shard.y[i] === ABSENT ? null : shard.y[i] + 1970,
      isSubject: (flags & FLAG_SOI) !== 0,
      isAdditive,
      isPrimary: (flags & FLAG_PRIMARY_TARGET) !== 0,
      isXray: (flags & FLAG_XRAY) !== 0,
      isEm: (flags & FLAG_EM) !== 0,
      percentile: pct?.value ?? null,
      percentileBasis: pct?.basis ?? null,
    });
  }

  ligands.sort(compare);
  return { accession: acc, protein, gene, organism, ligands, additiveCount, unscoredCount };
}

/**
 * Worst evidence first, as a total order so permalinks are stable.
 *
 * RSR enters only as a tie-break rather than a weighted blend: RSCC and RSR are
 * strongly correlated, and inventing a weighting would add a number that has to
 * be defended and buys nothing. RCSB's own ranking_model_fit is displayed
 * beside ours as an independent cross-check but never ranked on, because it is
 * not resolution-stratified.
 */
function compare(a: TargetLigand, b: TargetLigand): number {
  const aNull = a.percentile === null;
  const bNull = b.percentile === null;
  if (aNull !== bNull) return aNull ? 1 : -1;            // scored before unscored
  if (!aNull && !bNull && a.percentile !== b.percentile) return a.percentile! - b.percentile!;
  if (a.rscc !== null && b.rscc !== null && a.rscc !== b.rscc) return a.rscc - b.rscc;
  if (a.rsr !== null && b.rsr !== null && a.rsr !== b.rsr) return b.rsr - a.rsr;
  if (a.resolution !== null && b.resolution !== null && a.resolution !== b.resolution) {
    return a.resolution - b.resolution;                   // less excuse at high resolution
  }
  return a.entry.localeCompare(b.entry) || a.chain.localeCompare(b.chain) || a.seq - b.seq;
}

