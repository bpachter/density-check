import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
const OUT = 'public/index';
let raw = 0, gz = 0; const gzSizes: number[] = [];
for (const f of readdirSync(join(OUT, 'lig'))) {
  const b = readFileSync(join(OUT, 'lig', f));
  raw += b.length;
  const g = gzipSync(b, { level: 6 }).length;
  gz += g; gzSizes.push(g);
}
gzSizes.sort((a, b) => a - b);
console.log(`lig/ raw ${(raw/1048576).toFixed(1)} MB -> gz ${(gz/1048576).toFixed(1)} MB (${(raw/gz).toFixed(1)}x)`);
console.log(`  gz p50 ${gzSizes[gzSizes.length>>1]} B  p95 ${gzSizes[Math.floor(gzSizes.length*0.95)]} B  max ${gzSizes[gzSizes.length-1]} B`);
let nraw = 0, ngz = 0;
for (const f of readdirSync(join(OUT, 'name'))) {
  const b = readFileSync(join(OUT, 'name', f));
  nraw += b.length; ngz += gzipSync(b, { level: 6 }).length;
}
console.log(`name/ raw ${(nraw/1048576).toFixed(1)} MB -> gz ${(ngz/1048576).toFixed(1)} MB`);
const comps = readFileSync(join(OUT, 'comps.json'));
console.log(`comps raw ${(comps.length/1048576).toFixed(1)} MB -> gz ${(gzipSync(comps).length/1048576).toFixed(1)} MB`);
console.log(`TOTAL gz ~${((gz+ngz+gzipSync(comps).length)/1048576).toFixed(1)} MB`);

