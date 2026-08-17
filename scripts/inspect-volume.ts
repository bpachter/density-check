// Print the real shape of a VolumeServer BinaryCIF response.
// Run: npx tsx scripts/inspect-volume.ts
// This exists because the encoding chain and the axis_order permutation are
// the two things that silently produce plausible-but-wrong density values.
import { decode } from '@msgpack/msgpack';
import { parseCif, loopColumn } from '../src/lib/cif';

const ENTRY = '1cbs';
const COMP = 'REA';

async function main(): Promise<void> {
  const atomsUrl = `https://models.rcsb.org/v1/${ENTRY}/atoms?label_comp_id=${COMP}&encoding=cif`;
  const cifText = await (await fetch(atomsUrl)).text();
  const block = parseCif(cifText);
  const site = block.loops.get('atom_site');
  if (!site) throw new Error('no atom_site loop');

  const xs = loopColumn(site, 'Cartn_x').map(Number);
  const ys = loopColumn(site, 'Cartn_y').map(Number);
  const zs = loopColumn(site, 'Cartn_z').map(Number);
  const el = loopColumn(site, 'type_symbol');
  console.log(`atoms: ${site.rowCount}  elements: ${[...new Set(el)].join(',')}`);
  console.log('columns:', site.columns.join(' '));

  const pad = 5;
  const box = {
    x1: Math.min(...xs) - pad, y1: Math.min(...ys) - pad, z1: Math.min(...zs) - pad,
    x2: Math.max(...xs) + pad, y2: Math.max(...ys) + pad, z2: Math.max(...zs) + pad,
  };
  console.log('box:', JSON.stringify(box));

  const volUrl = `https://maps.rcsb.org/x-ray/${ENTRY}/box/` +
    `${box.x1.toFixed(3)},${box.y1.toFixed(3)},${box.z1.toFixed(3)}/` +
    `${box.x2.toFixed(3)},${box.y2.toFixed(3)},${box.z2.toFixed(3)}?detail=6`;
  console.log('GET', volUrl);

  const res = await fetch(volUrl);
  const buf = new Uint8Array(await res.arrayBuffer());
  console.log(`density bytes: ${buf.length}  status ${res.status}  type ${res.headers.get('content-type')}`);

  const bcif = decode(buf) as any;
  console.log('\n=== top level ===');
  console.log('keys:', Object.keys(bcif));
  console.log('encoder:', bcif.encoder, 'version:', bcif.version);

  for (const dataBlock of bcif.dataBlocks) {
    console.log(`\n=== dataBlock ${dataBlock.header} ===`);
    for (const cat of dataBlock.categories) {
      console.log(`\n-- category ${cat.name}  rowCount=${cat.rowCount}`);
      for (const col of cat.columns) {
        const enc = col.data.encoding.map((e: any) => {
          const bits = [`kind=${e.kind}`];
          for (const k of ['type', 'srcType', 'byteCount', 'numSteps', 'min', 'max', 'origin', 'factor', 'srcSize']) {
            if (e[k] !== undefined) bits.push(`${k}=${e[k]}`);
          }
          return bits.join(' ');
        });
        const size = col.data.data?.length ?? 0;
        console.log(`   ${col.name}: bytes=${size}  mask=${col.mask ? 'yes' : 'no'}`);
        console.log(`      encoding: ${enc.join('  ->  ')}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
