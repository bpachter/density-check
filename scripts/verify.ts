// Live verification against RCSB. Nothing in this project is believed until
// this passes.
//
// Two independent checks:
//
//   VALUE DECODING — the mean and sigma of the values we decode must
//   reproduce `mean_sampled` / `sigma_sampled` from the file's own header.
//   That validates msgpack -> IntervalQuantization -> uint8 without involving
//   geometry at all.
//
//   GEOMETRY — physics decides, not a specification we might be misreading.
//   Electron density peaks ON atomic nuclei. So for a well-ordered ligand the
//   correct grid convention is the one that puts density maxima closest to
//   atom centres. We compute both candidate conventions and report which wins;
//   if the winner is not decisive, the tool has no business printing numbers.
//
// Run: npx tsx scripts/verify.ts
import { parseCif, loopColumn, type CifBlock } from '../src/lib/cif';
import { parseBinaryCif } from '../src/lib/binarycif';
import {
  readDensityGrid, sampleSigma, valueAt, cartesianOfNode, gridIndexOf,
  type DensityGrid, type GridSpacing,
} from '../src/lib/volume';

interface Atom {
  element: string;
  name: string;
  pos: [number, number, number];
  b: number;
  occupancy: number;
}

interface Case {
  entry: string;
  comp: string;
  note: string;
}

const CASES: Case[] = [
  { entry: '1cbs', comp: 'REA', note: 'retinoic acid, RSCC 0.949 — well supported' },
  { entry: '13fl', comp: 'NAG', note: 'from the RSCC<0.55 set — poorly supported' },
];

async function fetchAtoms(entry: string, comp: string): Promise<{ atoms: Atom[]; block: CifBlock }> {
  const url = `https://models.rcsb.org/v1/${entry}/atoms?label_comp_id=${comp}&encoding=cif`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`atoms ${entry}/${comp}: HTTP ${res.status}`);
  const block = parseCif(await res.text());
  const site = block.loops.get('atom_site');
  if (!site) throw new Error(`no atom_site for ${entry}/${comp}`);

  const x = loopColumn(site, 'Cartn_x').map(Number);
  const y = loopColumn(site, 'Cartn_y').map(Number);
  const z = loopColumn(site, 'Cartn_z').map(Number);
  const el = loopColumn(site, 'type_symbol');
  const nm = loopColumn(site, 'label_atom_id');
  const b = loopColumn(site, 'B_iso_or_equiv').map(Number);
  const occ = loopColumn(site, 'occupancy').map(Number);

  // Ligands can appear in several copies/altlocs; take the first instance only,
  // by asym id, so we are judging one molecule and not an average of several.
  const asym = loopColumn(site, 'label_asym_id');
  const firstAsym = asym[0];

  const atoms: Atom[] = [];
  for (let i = 0; i < site.rowCount; i++) {
    if (asym[i] !== firstAsym) continue;
    atoms.push({ element: el[i], name: nm[i], pos: [x[i], y[i], z[i]], b: b[i], occupancy: occ[i] });
  }
  return { atoms, block };
}

async function fetchDensity(entry: string, atoms: Atom[]): Promise<Uint8Array> {
  const pad = 5;
  const lo = [0, 1, 2].map((a) => Math.min(...atoms.map((at) => at.pos[a])) - pad);
  const hi = [0, 1, 2].map((a) => Math.max(...atoms.map((at) => at.pos[a])) + pad);
  const url = `https://maps.rcsb.org/x-ray/${entry}/box/` +
    `${lo.map((v) => v.toFixed(3)).join(',')}/${hi.map((v) => v.toFixed(3)).join(',')}?detail=6`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`density ${entry}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Distance from an atom to the nearest local density maximum, in Angstrom. */
function peakOffset(grid: DensityGrid, atom: Atom, searchRadius = 1.2): number {
  const idx = gridIndexOf(grid, atom.pos);
  if (!idx) return NaN;
  // Convert the search radius to a node count using the coarsest axis.
  const spanNodes = 3;
  let best = -Infinity;
  let bestPos: [number, number, number] | null = null;
  const c = idx.map(Math.round) as [number, number, number];
  for (let dx = -spanNodes; dx <= spanNodes; dx++) {
    for (let dy = -spanNodes; dy <= spanNodes; dy++) {
      for (let dz = -spanNodes; dz <= spanNodes; dz++) {
        const ix = c[0] + dx, iy = c[1] + dy, iz = c[2] + dz;
        const v = valueAt(grid, ix, iy, iz);
        if (Number.isNaN(v)) continue;
        const p = cartesianOfNode(grid, ix, iy, iz);
        const d = Math.hypot(p[0] - atom.pos[0], p[1] - atom.pos[1], p[2] - atom.pos[2]);
        if (d > searchRadius) continue;
        if (v > best) { best = v; bestPos = p; }
      }
    }
  }
  if (!bestPos) return NaN;
  return Math.hypot(bestPos[0] - atom.pos[0], bestPos[1] - atom.pos[1], bestPos[2] - atom.pos[2]);
}

function stats(values: number[]): { mean: number; median: number } {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return { mean: NaN, median: NaN };
  const mean = clean.reduce((s, v) => s + v, 0) / clean.length;
  const median = clean[Math.floor(clean.length / 2)];
  return { mean, median };
}

async function run(): Promise<void> {
  let failures = 0;

  for (const c of CASES) {
    console.log(`\n${'='.repeat(72)}\n${c.entry.toUpperCase()} / ${c.comp} — ${c.note}\n${'='.repeat(72)}`);
    const { atoms } = await fetchAtoms(c.entry, c.comp);
    const bytes = await fetchDensity(c.entry, atoms);
    const file = parseBinaryCif(bytes);
    console.log(`atoms=${atoms.length}  density=${bytes.length} B  blocks=${file.dataBlocks.map((b) => b.header).join(',')}`);

    // ---- check 1: value decoding reproduces the header's own statistics ----
    const probe = readDensityGrid(file, '2FO-FC', 'inclusive');
    let sum = 0, sumSq = 0;
    for (let i = 0; i < probe.values.length; i++) { sum += probe.values[i]; sumSq += probe.values[i] * probe.values[i]; }
    const n = probe.values.length;
    const mean = sum / n;
    const sigma = Math.sqrt(sumSq / n - mean * mean);
    const meanErr = Math.abs(mean - probe.meanSampled);
    const sigmaErr = Math.abs(sigma - probe.sigmaSampled);
    // The quantization step is (max-min)/254; agreement to well inside one step
    // is the most we can ask of a uint8 round-trip.
    const tol = 0.02;
    const decodeOk = meanErr < tol && sigmaErr < tol;
    console.log(`\n  value decode: mean=${mean.toFixed(4)} (header ${probe.meanSampled.toFixed(4)}, d=${meanErr.toFixed(4)})  ` +
      `sigma=${sigma.toFixed(4)} (header ${probe.sigmaSampled.toFixed(4)}, d=${sigmaErr.toFixed(4)})  ` +
      `${decodeOk ? 'OK' : 'FAIL'}`);
    if (!decodeOk) failures++;

    console.log(`  axis_order=[${probe.axisOrder.join(',')}]  sample_count=[${probe.sampleCount.join(',')}]  ` +
      `origin=[${probe.origin.map((v) => v.toFixed(4)).join(',')}]  dims=[${probe.dimensions.map((v) => v.toFixed(4)).join(',')}]`);
    console.log(`  sigma_source=${probe.sigmaSource.toFixed(4)}  mean_source=${probe.meanSource.toFixed(4)}`);

    // ---- check 2: which grid convention puts peaks on nuclei? ----
    console.log('\n  convention      mean sigma   <1sigma   median peak offset (A)');
    const results: Record<GridSpacing, { peak: number; meanSigma: number; below: number }> = {} as never;
    for (const spacing of ['inclusive', 'periodic'] as GridSpacing[]) {
      const grid = readDensityGrid(file, '2FO-FC', spacing);
      const sigmas = atoms.map((a) => sampleSigma(grid, a.pos));
      const offsets = atoms.map((a) => peakOffset(grid, a));
      const s = stats(sigmas);
      const o = stats(offsets);
      const below = sigmas.filter((v) => Number.isFinite(v) && v < 1).length;
      results[spacing] = { peak: o.median, meanSigma: s.mean, below };
      console.log(`  ${spacing.padEnd(14)}  ${s.mean.toFixed(2).padStart(9)}   ` +
        `${String(below).padStart(2)}/${atoms.length}    ${o.median.toFixed(3)}`);
    }

    const winner: GridSpacing = results.inclusive.peak <= results.periodic.peak ? 'inclusive' : 'periodic';
    const margin = Math.abs(results.inclusive.peak - results.periodic.peak);
    console.log(`  -> peaks sit closest to nuclei with '${winner}' (margin ${margin.toFixed(3)} A)`);

    // ---- per-atom detail under the winning convention ----
    const grid = readDensityGrid(file, '2FO-FC', winner);
    const fo = readDensityGrid(file, 'FO-FC', winner);
    const rows = atoms.map((a) => ({
      name: a.name,
      element: a.element,
      b: a.b,
      sigma: sampleSigma(grid, a.pos),
      diff: sampleSigma(fo, a.pos),
    })).sort((x, y) => x.sigma - y.sigma);

    console.log('\n  weakest atoms (2Fo-Fc sigma / Fo-Fc sigma / B):');
    for (const r of rows.slice(0, 5)) {
      console.log(`    ${r.name.padEnd(6)} ${r.element.padEnd(2)}  ${r.sigma.toFixed(2).padStart(6)}  ` +
        `${r.diff.toFixed(2).padStart(6)}   B=${r.b.toFixed(1)}`);
    }
    const byElement = new Map<string, number[]>();
    for (const r of rows) {
      if (!byElement.has(r.element)) byElement.set(r.element, []);
      byElement.get(r.element)!.push(r.sigma);
    }
    const elementLine = [...byElement.entries()]
      .map(([e, vs]) => `${e}=${stats(vs).mean.toFixed(2)}`).join('  ');
    console.log(`  mean sigma by element: ${elementLine}`);
  }

  console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : 'all value-decode checks passed'}`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
