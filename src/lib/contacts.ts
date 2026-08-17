// Ligand–environment contacts, as typed by PDBe's Arpeggio pipeline.
//
// HONEST LIMITATION, stated in the UI as well as here: this endpoint returns
// contacts at RESIDUE level — `atom_names` comes back null — so we cannot draw
// the specific atom pair that makes each contact. What we draw is the closest
// approach between the ligand and that residue, which is where the contact is,
// but the endpoint is not telling us which atoms Arpeggio actually paired.
// Labelling that as an atom-level hydrogen bond would be inventing precision.

import type { Atom } from './evidence';

export interface Contact {
  /** Residue on the other side of the contact. */
  residue: string;
  chain: string;
  seq: number;
  /** Arpeggio interaction types, e.g. ['hbond','polar','vdw_clash']. */
  types: string[];
  isWater: boolean;
  /** Closest approach, filled in when we can match the residue in coordinates. */
  distance: number | null;
  from: [number, number, number] | null;
  to: [number, number, number] | null;
}

const PDBE = 'https://www.ebi.ac.uk/pdbe/graph-api/pdb/bound_molecule_interactions';

/** Interaction types worth drawing a line for; the rest are listed only. */
export const STRONG_TYPES = new Set(['hbond', 'ionic', 'vdw_clash', 'covalent', 'metal']);

export function contactTone(types: string[]): 'strong' | 'polar' | 'weak' {
  if (types.some((t) => STRONG_TYPES.has(t))) return 'strong';
  if (types.some((t) => t.includes('polar'))) return 'polar';
  return 'weak';
}

/**
 * Fetch contacts for a bound molecule. `bmId` is literally 'bm1' for the first
 * bound molecule in an entry; entries with several have bm2, bm3, ...
 */
export async function fetchContacts(
  entry: string,
  compId: string,
  authAsymId: string,
  environment: Atom[],
  ligandAtoms: Atom[],
  bmIds: string[] = ['bm1', 'bm2', 'bm3'],
): Promise<Contact[]> {
  const id = entry.toLowerCase();

  for (const bmId of bmIds) {
    let payload: any;
    try {
      const res = await fetch(`${PDBE}/${id}/${bmId}`);
      if (!res.ok) continue;
      payload = await res.json();
    } catch {
      continue; // PDBe being unavailable must not take the whole panel down
    }

    const molecules = payload?.[id];
    if (!Array.isArray(molecules)) continue;

    for (const mol of molecules) {
      // Only the bound molecule that IS our ligand instance.
      const ligands = mol?.composition?.ligands ?? [];
      const matches = ligands.some((l: any) =>
        l.chem_comp_id === compId && (!authAsymId || l.chain_id === authAsymId));
      if (!matches) continue;

      const out: Contact[] = [];
      for (const inter of mol.interactions ?? []) {
        // `begin` is the ligand side; `end` is the environment.
        const env = inter.end?.chem_comp_id === compId ? inter.begin : inter.end;
        if (!env) continue;
        const types: string[] = [
          ...(inter.interactions?.atom_atom ?? []),
          ...(inter.interactions?.atom_plane ?? []),
          ...(inter.interactions?.plane_plane ?? []),
          ...(inter.interactions?.group_group ?? []),
          ...(inter.interactions?.group_plane ?? []),
        ];
        if (!types.length) continue;

        const contact: Contact = {
          residue: env.chem_comp_id,
          chain: env.chain_id,
          seq: env.author_residue_number,
          types: [...new Set(types)],
          isWater: env.chem_comp_id === 'HOH',
          distance: null, from: null, to: null,
        };
        geometryFor(contact, environment, ligandAtoms);
        out.push(contact);
      }

      out.sort((a, b) => {
        const tone = { strong: 0, polar: 1, weak: 2 } as const;
        const d = tone[contactTone(a.types)] - tone[contactTone(b.types)];
        if (d) return d;
        return (a.distance ?? 99) - (b.distance ?? 99);
      });
      return out;
    }
  }

  return [];
}

/**
 * Closest approach between the ligand and the named residue, using the
 * coordinates we already hold. Residues we cannot locate keep null geometry
 * and are listed without a line rather than drawn at a guessed position.
 */
function geometryFor(contact: Contact, environment: Atom[], ligandAtoms: Atom[]): void {
  const residueAtoms = environment.filter(
    (a) => a.authSeqId === contact.seq && a.authAsymId === contact.chain && a.compId === contact.residue,
  );
  if (!residueAtoms.length) return;

  let best = Infinity;
  let from: [number, number, number] | null = null;
  let to: [number, number, number] | null = null;
  for (const l of ligandAtoms) {
    for (const r of residueAtoms) {
      const d = Math.hypot(l.pos[0] - r.pos[0], l.pos[1] - r.pos[1], l.pos[2] - r.pos[2]);
      if (d < best) { best = d; from = l.pos; to = r.pos; }
    }
  }
  if (from && to) { contact.distance = best; contact.from = from; contact.to = to; }
}
