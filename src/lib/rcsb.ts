// RCSB data access. Every endpoint here was verified live to return
// `Access-Control-Allow-Origin: *` with no authentication, so this app runs as
// a static site with no backend and no proxy.
//
//   models.rcsb.org  — coordinates (ModelServer)
//   maps.rcsb.org    — electron density boxes (VolumeServer), BinaryCIF
//   data.rcsb.org    — published validation metrics (RSCC/RSR and friends)
//
// All PDB archive data is CC0 1.0.

import { parseCif, loopColumn } from './cif';
import { parseBinaryCif } from './binarycif';
import { readDensityGrid, type DensityGrid } from './volume';
import type { Atom } from './evidence';

export interface LigandCoordinates {
  atoms: Atom[];
  /** Which copy of the ligand this is, e.g. 'B'. */
  asymId: string;
  /** Author-facing chain, for display and for the validation lookup. */
  authAsymId: string;
  compName: string;
}

const MODELS = 'https://models.rcsb.org/v1';
const MAPS = 'https://maps.rcsb.org/x-ray';
const DATA = 'https://data.rcsb.org/rest/v1/core';

async function fetchText(url: string, what: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} from ${url}`);
  return res.text();
}

function atomsFromCif(text: string, restrictToFirstAsym: boolean): {
  atoms: Atom[]; asymId: string; authAsymId: string;
} {
  const block = parseCif(text);
  const site = block.loops.get('atom_site');
  if (!site) throw new Error('no atom_site loop in coordinates response');

  const x = loopColumn(site, 'Cartn_x');
  const y = loopColumn(site, 'Cartn_y');
  const z = loopColumn(site, 'Cartn_z');
  const el = loopColumn(site, 'type_symbol');
  const nm = loopColumn(site, 'label_atom_id');
  const b = loopColumn(site, 'B_iso_or_equiv');
  const occ = loopColumn(site, 'occupancy');
  const asym = loopColumn(site, 'label_asym_id');
  let authAsym: string[] = asym;
  try { authAsym = loopColumn(site, 'auth_asym_id'); } catch { /* optional */ }

  const target = asym[0] ?? '';
  const atoms: Atom[] = [];
  for (let i = 0; i < site.rowCount; i++) {
    if (restrictToFirstAsym && asym[i] !== target) continue;
    atoms.push({
      name: nm[i],
      element: el[i],
      pos: [Number(x[i]), Number(y[i]), Number(z[i])],
      b: Number(b[i]),
      occupancy: Number(occ[i]),
    });
  }
  return { atoms, asymId: target, authAsymId: authAsym[0] ?? target };
}

/** Coordinates of one copy of a ligand, by chemical component id (e.g. 'REA'). */
export async function fetchLigand(entry: string, comp: string): Promise<LigandCoordinates> {
  const text = await fetchText(
    `${MODELS}/${entry.toLowerCase()}/atoms?label_comp_id=${encodeURIComponent(comp)}&encoding=cif`,
    `ligand ${entry}/${comp}`,
  );
  const { atoms, asymId, authAsymId } = atomsFromCif(text, true);
  if (!atoms.length) throw new Error(`no atoms found for ${comp} in ${entry}`);
  const block = parseCif(text);
  return { atoms, asymId, authAsymId, compName: block.items.get('_entity.pdbx_description') ?? comp };
}

/** Protein atoms around a ligand — the within-map reference population. */
export async function fetchSurroundings(entry: string, comp: string, radius = 8): Promise<Atom[]> {
  const text = await fetchText(
    `${MODELS}/${entry.toLowerCase()}/residueSurroundings` +
    `?label_comp_id=${encodeURIComponent(comp)}&radius=${radius}&encoding=cif`,
    `surroundings ${entry}/${comp}`,
  );
  const { atoms } = atomsFromCif(text, false);
  // Exclude the ligand itself and waters: the reference is the ordered protein.
  return atoms.filter((a) => a.element !== 'H');
}

export interface DensityMaps {
  map2FoFc: DensityGrid;
  mapFoFc: DensityGrid;
  bytes: number;
}

/** Both maps for a box around the given atoms, in ONE request. */
export async function fetchDensity(entry: string, atoms: Atom[], pad = 5): Promise<DensityMaps> {
  const lo = [0, 1, 2].map((a) => Math.min(...atoms.map((at) => at.pos[a])) - pad);
  const hi = [0, 1, 2].map((a) => Math.max(...atoms.map((at) => at.pos[a])) + pad);
  const url = `${MAPS}/${entry.toLowerCase()}/box/` +
    `${lo.map((v) => v.toFixed(3)).join(',')}/${hi.map((v) => v.toFixed(3)).join(',')}?detail=6`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`density ${entry}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const file = parseBinaryCif(buf);
  return {
    map2FoFc: readDensityGrid(file, '2FO-FC'),
    mapFoFc: readDensityGrid(file, 'FO-FC'),
    bytes: buf.length,
  };
}

export interface PublishedValidation {
  /** Real-space correlation coefficient, as published. The cross-entry metric. */
  rscc: number | null;
  /** Real-space R. */
  rsr: number | null;
  /** Number of atoms the electron-density server scored. */
  natomsEds: number | null;
  intoResolution: number | null;
}

/**
 * The depositor-independent, already-normalised metrics. We rank on these
 * across entries rather than on our own sigma, which is not comparable between
 * structures.
 *
 * NOTE: this endpoint keys on the LABEL asym id, not the author chain. For
 * 1CBS the ligand is label asym 'B' while its author chain is 'A' — passing the
 * author chain 404s on every entry, silently blanking the one number that IS
 * comparable across structures.
 */
export async function fetchValidation(entry: string, labelAsymId: string): Promise<PublishedValidation> {
  const empty: PublishedValidation = { rscc: null, rsr: null, natomsEds: null, intoResolution: null };
  try {
    const res = await fetch(`${DATA}/nonpolymer_entity_instance/${entry.toUpperCase()}/${labelAsymId}`);
    if (!res.ok) return empty;
    const json = await res.json() as any;
    const scores = json?.rcsb_nonpolymer_instance_validation_score;
    const first = Array.isArray(scores) ? scores[0] : scores;
    return {
      rscc: first?.RSCC ?? null,
      rsr: first?.RSR ?? null,
      natomsEds: first?.natoms_eds ?? null,
      intoResolution: null,
    };
  } catch {
    return empty;
  }
}

export async function fetchResolution(entry: string): Promise<number | null> {
  try {
    const res = await fetch(`${DATA}/entry/${entry.toUpperCase()}`);
    if (!res.ok) return null;
    const json = await res.json() as any;
    const r = json?.rcsb_entry_info?.resolution_combined;
    return Array.isArray(r) ? r[0] ?? null : r ?? null;
  } catch {
    return null;
  }
}
