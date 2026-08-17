// Generate the golden fixtures the app checks itself against at runtime.
// Run: npx tsx scripts/make-fixtures.ts
//
// These numbers come from the pipeline only AFTER it was proven byte-identical
// to Mol* (scripts/crossvalidate.ts). Regenerating them is a deliberate act:
// if a change moves these values, either the change is wrong or the fixture
// needs a documented reason to move.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLigand, fetchSurroundings, fetchDensity } from '../src/lib/rcsb';
import { buildReference, computeEvidence } from '../src/lib/evidence';

const CASES = [
  { entry: '1cbs', comp: 'REA' },
  { entry: '13fl', comp: 'NAG' },
];

async function main(): Promise<void> {
  const fixtures: Record<string, unknown> = {};

  for (const c of CASES) {
    const ligand = await fetchLigand(c.entry, c.comp);
    const [surroundings, maps] = await Promise.all([
      fetchSurroundings(c.entry, c.comp),
      fetchDensity(c.entry, ligand.atoms),
    ]);
    const meanB = ligand.atoms.reduce((s, a) => s + a.b, 0) / ligand.atoms.length;
    const reference = buildReference(surroundings, maps.map2FoFc, meanB);
    const ev = computeEvidence(c.entry, c.comp, ligand.atoms, maps.map2FoFc, maps.mapFoFc, reference);

    const key = `${c.entry}/${c.comp}`;
    fixtures[key] = {
      atomCount: ev.atoms.length,
      meanSigma: +ev.meanSigma.toFixed(4),
      fractionWeak: +ev.fractionWeak.toFixed(4),
      refutedCount: ev.refuted.length,
      sigmaSource: +maps.map2FoFc.sigmaSource.toFixed(6),
      sampleCount: maps.map2FoFc.sampleCount,
      referenceN: reference?.n ?? 0,
      // A few named atoms pin the geometry: if the axis permutation or grid
      // step regresses, these move immediately.
      atoms: ev.atoms
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 4)
        .map((a) => ({ name: a.name, sigma2FoFc: +a.sigma2FoFc.toFixed(3), sigmaFoFc: +a.sigmaFoFc.toFixed(3) })),
    };

    console.log(`${key}: mean=${ev.meanSigma.toFixed(2)}σ  weak=${(ev.fractionWeak * 100).toFixed(0)}%  ` +
      `refuted=${ev.refuted.length}  refN=${reference?.n ?? 0}`);
  }

  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'fixtures.json');
  writeFileSync(out, JSON.stringify(fixtures, null, 2) + '\n');
  console.log(`wrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
