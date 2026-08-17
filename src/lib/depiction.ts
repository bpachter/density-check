// 2D depiction of a ligand, tinted by how much density supports each atom.
//
// The mapping problem, and why it is solved this way: a 2D drawing is only
// useful here if each drawn atom can be traced back to a measured sigma. So
// rather than fetching a prebuilt SDF and guessing at index correspondence, we
// read the chemical component definition — which carries BOTH atom names and
// bond orders — and build the molblock ourselves, in the same order as the
// model atoms we already have. Atom i in the drawing is then atom i in the
// evidence table, by construction.
//
// RDKit's WASM build is 6.6 MB, so it is loaded only when the user asks for a
// depiction, never on first paint.

import { parseCif, loopColumn } from './cif';
import type { AtomEvidence } from './evidence';

const LIGAND_FILES = 'https://files.rcsb.org/ligands/download';

interface ChemComp {
  /** Heavy-atom names in definition order. */
  atoms: Array<{ name: string; element: string }>;
  bonds: Array<{ a: string; b: string; order: number }>;
}

const ccdCache = new Map<string, Promise<ChemComp>>();

const BOND_ORDER: Record<string, number> = { SING: 1, DOUB: 2, TRIP: 3, QUAD: 4, AROM: 4 };

async function fetchChemComp(compId: string): Promise<ChemComp> {
  let p = ccdCache.get(compId);
  if (p) return p;

  p = (async () => {
    const res = await fetch(`${LIGAND_FILES}/${compId.toUpperCase()}.cif`);
    if (!res.ok) throw new Error(`chemical component ${compId}: HTTP ${res.status}`);
    const block = parseCif(await res.text());

    const atomLoop = block.loops.get('chem_comp_atom');
    if (!atomLoop) throw new Error(`no atom list in the ${compId} definition`);
    const names = loopColumn(atomLoop, 'atom_id');
    const elements = loopColumn(atomLoop, 'type_symbol');
    const atoms = names
      .map((name, i) => ({ name, element: elements[i] }))
      .filter((a) => a.element.toUpperCase() !== 'H' && a.element.toUpperCase() !== 'D');

    const bonds: ChemComp['bonds'] = [];
    const bondLoop = block.loops.get('chem_comp_bond');
    if (bondLoop) {
      const a1 = loopColumn(bondLoop, 'atom_id_1');
      const a2 = loopColumn(bondLoop, 'atom_id_2');
      const order = loopColumn(bondLoop, 'value_order');
      for (let i = 0; i < bondLoop.rowCount; i++) {
        bonds.push({ a: a1[i], b: a2[i], order: BOND_ORDER[order[i]?.toUpperCase()] ?? 1 });
      }
    }
    return { atoms, bonds };
  })();

  ccdCache.set(compId, p);
  return p;
}

/**
 * V2000 molblock whose atom order matches `modelAtoms` exactly.
 * Atoms in the model but absent from the definition (alternate naming, or a
 * modified residue) are kept with no bonds rather than dropped — losing an atom
 * silently would break the correspondence this whole feature rests on.
 */
function buildMolblock(compId: string, modelAtoms: AtomEvidence[], ccd: ChemComp): string {
  const index = new Map<string, number>();
  modelAtoms.forEach((a, i) => index.set(a.name, i));

  const bonds = ccd.bonds
    .map((b) => ({ i: index.get(b.a), j: index.get(b.b), order: b.order }))
    .filter((b): b is { i: number; j: number; order: number } => b.i !== undefined && b.j !== undefined);

  const pad = (s: string, n: number) => s.padStart(n);
  const lines: string[] = [
    compId,
    '  DensityCheck',
    '',
    `${pad(String(modelAtoms.length), 3)}${pad(String(bonds.length), 3)}  0  0  0  0  0  0  0  0999 V2000`,
  ];

  // Real 3D coordinates go in; RDKit replaces them with a 2D layout. Giving it
  // the true geometry first means stereochemistry is perceived from the
  // deposited structure rather than invented.
  for (const a of modelAtoms) {
    const [x, y, z] = a.pos;
    lines.push(
      `${x.toFixed(4).padStart(10)}${y.toFixed(4).padStart(10)}${z.toFixed(4).padStart(10)} ` +
      `${a.element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`,
    );
  }
  for (const b of bonds) {
    lines.push(`${pad(String(b.i + 1), 3)}${pad(String(b.j + 1), 3)}${pad(String(b.order), 3)}  0  0  0  0`);
  }
  lines.push('M  END');
  return lines.join('\n');
}

// ── RDKit, loaded on demand ─────────────────────────────────────────
let rdkitPromise: Promise<any> | null = null;

function loadRDKit(): Promise<any> {
  rdkitPromise ??= new Promise((resolve, reject) => {
    const base = new URL('rdkit/', document.baseURI).href;
    const script = document.createElement('script');
    script.src = `${base}RDKit_minimal.js`;
    script.onload = () => {
      const init = (window as any).initRDKitModule;
      if (!init) { reject(new Error('RDKit loaded but did not register')); return; }
      init({ locateFile: (f: string) => `${base}${f}` }).then(resolve).catch(reject);
    };
    script.onerror = () => reject(new Error('could not load the chemistry engine'));
    document.head.appendChild(script);
  });
  return rdkitPromise;
}

/** Colour for an atom, from its density support. Matches the 3D view's grammar. */
function colourFor(atom: AtomEvidence): [number, number, number] {
  if (Number.isFinite(atom.sigmaFoFc) && atom.sigmaFoFc < -3) return [1.0, 0.36, 0.36];   // modelled into nothing
  if (!Number.isFinite(atom.sigma2FoFc)) return [0.55, 0.6, 0.66];
  if (atom.sigma2FoFc < 1) return [0.91, 0.71, 0.29];                                      // unsupported
  if (atom.sigma2FoFc < 2) return [0.52, 0.68, 0.78];
  return [0.36, 0.78, 0.96];                                                               // well supported
}

export interface Depiction {
  svg: string;
  bondedAtoms: number;
  totalAtoms: number;
}

export async function depictLigand(
  compId: string,
  atoms: AtomEvidence[],
  options: { width: number; height: number; highlight?: string | null },
): Promise<Depiction> {
  const [rdkit, ccd] = await Promise.all([loadRDKit(), fetchChemComp(compId)]);
  const molblock = buildMolblock(compId, atoms, ccd);

  const mol = rdkit.get_mol(molblock);
  if (!mol) throw new Error(`could not build a structure for ${compId}`);

  try {
    // Lay the molecule out in 2D; without this RDKit draws a flat projection of
    // the crystal conformation, which is unreadable.
    mol.set_new_coords(true);

    const atomColours: Record<number, [number, number, number]> = {};
    atoms.forEach((a, i) => { atomColours[i] = colourFor(a); });

    const highlightIndex = options.highlight
      ? atoms.findIndex((a) => a.name === options.highlight)
      : -1;

    const details = {
      width: options.width,
      height: options.height,
      atoms: atoms.map((_, i) => i),
      highlightColour: [0.36, 0.78, 0.96],
      highlightAtomColors: atomColours,
      // Small enough that neighbouring discs do not merge into a blob, large
      // enough to read as a colour rather than a dot.
      highlightRadii: Object.fromEntries(atoms.map((_, i) => [i, i === highlightIndex ? 0.48 : 0.28])),
      bondLineWidth: 1.6,
      backgroundColour: [0, 0, 0, 0],
      addStereoAnnotation: false,
      explicitMethyl: false,
    };

    const svg = mol.get_svg_with_highlights(JSON.stringify(details));
    const bonded = new Set<number>();
    const nameIndex = new Map(atoms.map((a, i) => [a.name, i]));
    for (const b of ccd.bonds) {
      const i = nameIndex.get(b.a); const j = nameIndex.get(b.b);
      if (i !== undefined && j !== undefined) { bonded.add(i); bonded.add(j); }
    }
    return { svg, bondedAtoms: bonded.size, totalAtoms: atoms.length };
  } finally {
    mol.delete();
  }
}
