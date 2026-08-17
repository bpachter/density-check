// Ranking ligand instances across entries.
//
// The trap this module exists to avoid: RSCC is resolution-dependent. A ligand
// at RSCC 0.85 in a 3.0 A structure is unremarkable; the same 0.85 at 1.2 A is
// poor. Sorting the archive by raw RSCC therefore surfaces low-resolution
// structures rather than badly-modelled ligands, and the tool would be most
// confidently wrong exactly where it claims to be useful.
//
// So a ligand is ranked by where it sits WITHIN ITS OWN RESOLUTION SHELL,
// against the empirical distribution of every scored ligand in that shell.
// "4th percentile for its resolution" is a claim the archive itself supports;
// "RSCC 0.62" on its own is not.

/** Shell edges in Angstrom. A ligand belongs to the first shell it fits. */
export const RESOLUTION_SHELLS: Array<{ id: string; max: number }> = [
  { id: '<1.5', max: 1.5 },
  { id: '1.5-2.0', max: 2.0 },
  { id: '2.0-2.5', max: 2.5 },
  { id: '2.5-3.0', max: 3.0 },
  { id: '>3.0', max: Infinity },
];

export function shellFor(resolution: number | null): string | null {
  if (resolution === null || !Number.isFinite(resolution)) return null;
  for (const s of RESOLUTION_SHELLS) if (resolution < s.max) return s.id;
  return RESOLUTION_SHELLS[RESOLUTION_SHELLS.length - 1].id;
}

/**
 * Per shell, RSCC at each percentile 1..99, ascending. Built from the archive
 * during the index build; shipped with the app so a percentile costs no
 * network call.
 */
export type QuantileTable = Record<string, number[]>;

/**
 * Percentile of `rscc` within its shell: the share of archive ligands in that
 * shell scoring at or below this one. Lower = worse than its peers.
 * Null when we have no distribution to compare against — which is honest.
 */
export function percentileFor(
  rscc: number | null,
  resolution: number | null,
  table: QuantileTable,
): number | null {
  if (rscc === null || !Number.isFinite(rscc)) return null;
  const shell = shellFor(resolution);
  if (!shell) return null;
  const quantiles = table[shell];
  if (!quantiles?.length) return null;

  // quantiles[i] is the RSCC at percentile i+1.
  let lo = 0;
  let hi = quantiles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (quantiles[mid] < rscc) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, Math.min(99, lo + 1));
}

export interface RankableInstance {
  rscc: number | null;
  resolution: number | null;
}

/**
 * Sort key: worst evidence first.
 *
 * Instances with no published RSCC are NOT treated as bad — they are unknown,
 * and unknown is not a finding. They sort after everything scored, so a target
 * list never opens with "worst ligand: one we know nothing about".
 */
export function evidenceRank(inst: RankableInstance, table: QuantileTable): number {
  const p = percentileFor(inst.rscc, inst.resolution, table);
  if (p !== null) return p;              // 1..99, low = worse than its peers
  if (inst.rscc !== null) return 100 + inst.rscc * 100;  // scored, unknown shell
  return 1e6;                             // unscored: last, deliberately
}

export function sortWorstFirst<T extends RankableInstance>(items: T[], table: QuantileTable): T[] {
  return [...items].sort((a, b) => evidenceRank(a, table) - evidenceRank(b, table));
}

/** Wording for a percentile, kept conservative. */
export function percentileLabel(p: number | null): string {
  if (p === null) return 'no published score';
  if (p <= 5) return `${ordinal(p)} percentile for its resolution — worse than almost every comparable ligand`;
  if (p <= 25) return `${ordinal(p)} percentile for its resolution`;
  if (p >= 90) return `${ordinal(p)} percentile for its resolution`;
  return `${ordinal(p)} percentile for its resolution`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/** Build the quantile table from raw (rscc, resolution) pairs during the index build. */
export function buildQuantileTable(
  rows: Array<{ rscc: number | null; resolution: number | null }>,
): { table: QuantileTable; counts: Record<string, number> } {
  const buckets = new Map<string, number[]>();
  for (const r of rows) {
    if (r.rscc === null || !Number.isFinite(r.rscc)) continue;
    const shell = shellFor(r.resolution);
    if (!shell) continue;
    if (!buckets.has(shell)) buckets.set(shell, []);
    buckets.get(shell)!.push(r.rscc);
  }

  const table: QuantileTable = {};
  const counts: Record<string, number> = {};
  for (const [shell, values] of buckets) {
    // Under 200 samples a 99-point quantile table is mostly noise; keep the
    // count so the UI can say the shell is thin rather than pretend.
    values.sort((a, b) => a - b);
    counts[shell] = values.length;
    if (values.length < 200) continue;
    const q: number[] = [];
    for (let p = 1; p <= 99; p++) {
      const idx = Math.min(values.length - 1, Math.floor((p / 100) * values.length));
      q.push(Number(values[idx].toFixed(4)));
    }
    table[shell] = q;
  }
  return { table, counts };
}
