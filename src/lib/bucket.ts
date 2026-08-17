// Shard addressing, shared by the build pipeline and the client.
//
// Both sides MUST compute the same bucket for the same key, so this file is
// imported by the emitter and the app rather than reimplemented in each.
//
// FNV-1a 32 rather than SHA-1 because crypto.subtle is async and a lookup has
// to be synchronous to stay inside one frame. Measured ~2.3 us/hash.

export const LIGAND_BUCKETS = 4096;
export const NAME_BUCKETS = 1024;

export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(input);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0');
}

/** Shard filename (without extension) holding a UniProt accession's ligands. */
export function ligandShard(accession: string): string {
  return hex4(fnv1a32(accession) % LIGAND_BUCKETS);
}

/** Shard filename holding a normalised name -> accession mapping. */
export function nameShard(normalised: string): string {
  return hex4(fnv1a32(normalised) % NAME_BUCKETS);
}

/** Lowercase, strip everything that is not a letter or digit. */
export function normaliseName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** UniProt accession pattern, per UniProt's own specification. */
export const ACCESSION_RE = /^([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2})$/;

export function looksLikeAccession(input: string): boolean {
  return ACCESSION_RE.test(input.trim().toUpperCase());
}

// ── uint8 quantisation ──────────────────────────────────────────────
// 255 always means absent. The step is ~0.4% of the metric range, far below
// the reproducibility of the metric itself.

export const ABSENT = 255;

export function quantiseRscc(v: number | null | undefined): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return ABSENT;
  return Math.max(0, Math.min(254, Math.round(((v + 1) / 2) * 254)));
}

export function dequantiseRscc(q: number): number | null {
  if (q === ABSENT) return null;
  return (q / 254) * 2 - 1;
}

export function quantiseUnit(v: number | null | undefined): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return ABSENT;
  return Math.max(0, Math.min(254, Math.round(Math.min(v, 1) * 254)));
}

export function dequantiseUnit(q: number): number | null {
  if (q === ABSENT) return null;
  return q / 254;
}

// ── row flags ───────────────────────────────────────────────────────
export const FLAG_SOI = 1;        // the ligand this structure is about
export const FLAG_HAS_RSCC = 2;
export const FLAG_XRAY = 4;
export const FLAG_EM = 8;
export const FLAG_OTHER_METHOD = 16;
export const FLAG_ADDITIVE = 32;  // ion / buffer / cryoprotectant / small sugar
export const FLAG_BEST_INSTANCE = 64;
export const FLAG_PRIMARY_TARGET = 128;

/**
 * Ions, buffers, cryoprotectants and common glycans. Magnesium alone is 37% of
 * all ligand instances in the archive; without this the tool would open on a
 * wall of ions every time.
 */
export const ADDITIVES = new Set([
  'MG', 'ZN', 'CA', 'NA', 'CL', 'K', 'SO4', 'PO4', 'EDO', 'GOL', 'PEG', 'PG4', 'PGE',
  'DMS', 'ACT', 'MPD', 'TRS', 'EPE', 'FMT', 'IOD', 'BR', 'NO3', 'CO3', 'ACY', 'OHX',
  'NAG', 'BMA', 'MAN', 'FUC', 'NDG', 'GAL', 'HOH', 'MN', 'FE', 'NI', 'CU', 'CD', 'CO',
]);

/** Resolution shells, frozen. Quantile-derived shells would drift weekly and
 *  silently change the percentile of rows whose data never changed. */
export const SHELL_EDGES = [1.20, 1.50, 1.75, 2.00, 2.25, 2.50, 2.80, 3.20, 3.60, 4.00];

export function shellOf(resolution: number | null): number {
  if (resolution === null || !Number.isFinite(resolution)) return SHELL_EDGES.length;
  for (let i = 0; i < SHELL_EDGES.length; i++) if (resolution < SHELL_EDGES[i]) return i;
  return SHELL_EDGES.length;
}

/**
 * Ligand size buckets, by the atom count the density server actually scored.
 *
 * RSCC depends on size as well as resolution: a 6-atom fragment can sit in
 * noise and still correlate well, while a 60-atom macrocycle has far more
 * ways to be wrong. Ranking on resolution alone therefore flatters small
 * ligands and punishes large ones. These buckets are the second axis.
 */
export const SIZE_EDGES = [10, 20, 35];

export function sizeOf(natoms: number | null): number {
  if (natoms === null || !Number.isFinite(natoms) || natoms === ABSENT) return SIZE_EDGES.length;
  for (let i = 0; i < SIZE_EDGES.length; i++) if (natoms < SIZE_EDGES[i]) return i;
  return SIZE_EDGES.length;
}

export const SIZE_LABELS = ['< 10 atoms', '10–19 atoms', '20–34 atoms', '35+ atoms'];
export const N_SIZE_BUCKETS = SIZE_EDGES.length + 1;
