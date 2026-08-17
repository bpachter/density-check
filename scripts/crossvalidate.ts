// Independent cross-validation of our BinaryCIF decoder against Mol*'s.
//
// Mol* is the reference implementation of BinaryCIF and of the VolumeServer
// format. If our decoder and theirs disagree on a single voxel of the same
// response bytes, ours is wrong. This is the check that earns the right to
// print a number: not "it looks plausible", but "an independent implementation
// produces the identical array".
//
// Run: npx tsx scripts/crossvalidate.ts
// Explicit .js: molstar ships BOTH a `cif.js` file and a `cif/` directory, and
// the resolver picks the directory without it.
import { CIF } from 'molstar/lib/commonjs/mol-io/reader/cif.js';
import { parseBinaryCif, dataBlock, category, decodeColumn } from '../src/lib/binarycif';
import { readDensityGrid } from '../src/lib/volume';

const CASES = [
  { entry: '1cbs', box: ['14.555,16.075,9.848', '29.303,35.737,32.037'] },
  { entry: '13fl', box: ['24.062,3.126,26.262', '36.699,10.263,37.021'] },
];

async function main(): Promise<void> {
  let failures = 0;

  for (const c of CASES) {
    const url = `https://maps.rcsb.org/x-ray/${c.entry}/box/${c.box[0]}/${c.box[1]}?detail=6`;
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    console.log(`\n${c.entry.toUpperCase()}  ${bytes.length} B`);

    // ---- reference: Mol* ----
    const parsed = await CIF.parseBinary(bytes).run();
    if (parsed.isError) throw new Error(`molstar parse failed: ${parsed.message}`);
    const molBlock = parsed.result.blocks.find((b) => b.header === '2FO-FC');
    if (!molBlock) throw new Error('molstar: no 2FO-FC block');
    const molValues = molBlock.categories['volume_data_3d'].getField('values')!;
    const molInfo = molBlock.categories['volume_data_3d_info'];

    // ---- ours ----
    const ours = parseBinaryCif(bytes);
    const oursGrid = readDensityGrid(ours, '2FO-FC', 'periodic');

    // Element-wise comparison of the full value array.
    let maxDiff = 0;
    let firstBad = -1;
    if (molValues.rowCount !== oursGrid.values.length) {
      console.log(`  FAIL length: molstar ${molValues.rowCount} vs ours ${oursGrid.values.length}`);
      failures++;
      continue;
    }
    for (let i = 0; i < molValues.rowCount; i++) {
      const d = Math.abs(molValues.float(i) - oursGrid.values[i]);
      if (d > maxDiff) { maxDiff = d; if (d > 1e-6 && firstBad < 0) firstBad = i; }
    }
    const valuesOk = maxDiff < 1e-6;
    console.log(`  values: n=${molValues.rowCount}  max|diff|=${maxDiff.toExponential(2)}  ${valuesOk ? 'IDENTICAL' : `MISMATCH at ${firstBad}`}`);
    if (!valuesOk) failures++;

    // Header fields must agree too — these drive the geometry.
    const fields: Array<[string, number]> = [
      ['sigma_source', oursGrid.sigmaSource],
      ['mean_source', oursGrid.meanSource],
      ['sigma_sampled', oursGrid.sigmaSampled],
    ];
    for (const [name, ourValue] of fields) {
      const ref = molInfo.getField(name)!.float(0);
      const ok = Math.abs(ref - ourValue) < 1e-9;
      console.log(`  ${name.padEnd(14)} ours=${ourValue.toFixed(6)}  molstar=${ref.toFixed(6)}  ${ok ? 'ok' : 'MISMATCH'}`);
      if (!ok) failures++;
    }
    for (const name of ['axis_order', 'sample_count', 'origin', 'dimensions']) {
      const ref = [0, 1, 2].map((i) => molInfo.getField(`${name}[${i}]`)!.float(0));
      console.log(`  ${name.padEnd(14)} molstar raw=[${ref.map((v) => v.toFixed(4)).join(', ')}]`);
    }

    // And the string columns, which exercise the StringArray decoding path.
    const serverBlock = dataBlock(ours, 'SERVER');
    const serverCat = category(serverBlock, '_density_server_result');
    const ourVersion = (decodeColumn(serverCat.columns.find((x) => x.name === 'server_version')!) as string[])[0];
    const molServer = parsed.result.blocks.find((b) => b.header === 'SERVER')!;
    const refVersion = molServer.categories['density_server_result'].getField('server_version')!.str(0);
    const strOk = ourVersion === refVersion;
    console.log(`  StringArray    ours='${ourVersion}'  molstar='${refVersion}'  ${strOk ? 'ok' : 'MISMATCH'}`);
    if (!strOk) failures++;
  }

  console.log(`\n${failures ? `${failures} MISMATCH(ES) — our decoder is wrong` : 'decoder matches the reference implementation exactly'}`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
