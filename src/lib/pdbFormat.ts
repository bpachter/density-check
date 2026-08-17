// Minimal PDB coordinate reader, for the bring-your-own path.
//
// Column positions, not whitespace splitting: the PDB format is fixed-width and
// fields genuinely run together in real files (a four-character atom name
// against a residue name, a negative coordinate against the one before it).
// Splitting on spaces works until it silently doesn't.

import type { Atom } from './evidence';

export interface LocalResidue {
  key: string;
  compId: string;
  chain: string;
  seq: number;
  atoms: Atom[];
  isHetatm: boolean;
}

const WATER = new Set(['HOH', 'DOD', 'WAT', 'H2O']);

export function parsePdb(text: string): { atoms: Atom[]; residues: LocalResidue[] } {
  const atoms: Atom[] = [];
  const byResidue = new Map<string, LocalResidue>();

  for (const line of text.split('\n')) {
    const record = line.slice(0, 6);
    if (record !== 'ATOM  ' && record !== 'HETATM') continue;

    // An altloc other than blank/A is a second interpretation of the same atom;
    // taking both would double-count the residue.
    const altLoc = line[16];
    if (altLoc !== ' ' && altLoc !== 'A') continue;

    const element = (line.slice(76, 78).trim() || line.slice(12, 14).trim().replace(/[^A-Za-z]/g, '')).toUpperCase();
    if (element === 'H' || element === 'D') continue;

    const x = Number(line.slice(30, 38));
    const y = Number(line.slice(38, 46));
    const z = Number(line.slice(46, 54));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

    const compId = line.slice(17, 20).trim();
    const chain = line.slice(21, 22).trim();
    const seq = Number(line.slice(22, 26));
    const occupancy = Number(line.slice(54, 60)) || 1;
    const b = Number(line.slice(60, 66)) || 0;

    const atom: Atom = {
      name: line.slice(12, 16).trim(),
      element: element.charAt(0) + element.slice(1).toLowerCase(),
      pos: [x, y, z],
      b,
      occupancy,
      compId,
      authSeqId: seq,
      authAsymId: chain,
    };
    atoms.push(atom);

    const key = `${chain}/${compId}/${seq}`;
    let residue = byResidue.get(key);
    if (!residue) {
      residue = { key, compId, chain, seq, atoms: [], isHetatm: record === 'HETATM' };
      byResidue.set(key, residue);
    }
    residue.atoms.push(atom);
  }

  return { atoms, residues: [...byResidue.values()] };
}

/** Candidate ligands: het groups that are not water and have more than one atom. */
export function ligandCandidates(residues: LocalResidue[]): LocalResidue[] {
  return residues
    .filter((r) => r.isHetatm && !WATER.has(r.compId.toUpperCase()) && r.atoms.length > 1)
    .sort((a, b) => b.atoms.length - a.atoms.length);
}
