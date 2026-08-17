// Verify the built index against known cases, reading the shards exactly as the
// client will. Run: npx tsx scripts/index/verify.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ligandShard, nameShard, normaliseName, shellOf, ABSENT, dequantiseRscc,
  FLAG_SOI, FLAG_HAS_RSCC, FLAG_ADDITIVE,
} from '../../src/lib/bucket';

const OUT = 'public/index';
const meta = JSON.parse(readFileSync(join(OUT, 'meta.json'), 'utf8'));

function shard(dir: string, key: string): any {
  const name = dir === 'lig' ? ligandShard(key) : nameShard(key);
  try { return JSON.parse(readFileSync(join(OUT, dir, `${name}.json`), 'utf8')); }
  catch { return null; }
}

function percentile(q: number, resHundredths: number): number | null {
  if (q === ABSENT) return null;
  const table = meta.cdfRscc[shellOf(resHundredths === 65535 ? null : resHundredths / 100)];
  if (!table?.length || table[254] === 0) return null;
  return (table[q] / 65535) * 100;
}

function lookup(acc: string) {
  const s = shard('lig', acc);
  const range = s?.A?.[acc];
  if (!range) return null;
  const [start, count] = range;
  const rows = [];
  for (let i = start; i < start + count; i++) {
    rows.push({
      entry: s.E[s.e[i]], comp: s.C[s.c[i]], chain: s.h[i], seq: s.s[i],
      rscc: dequantiseRscc(s.q[i]), q: s.q[i], flags: s.f[i],
      resolution: s.R[i] === 65535 ? null : s.R[i] / 100,
      pct: percentile(s.q[i], s.R[i]),
      targets: s.g[i],
    });
  }
  return { display: s.D?.[acc], rows };
}

let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

console.log(`index built ${meta.built}: ${meta.counts.rows.toLocaleString()} rows, ` +
  `${meta.counts.accessions.toLocaleString()} accessions, ${meta.counts.shards} shards`);

// ── name resolution ──
console.log('\nname resolution');
for (const [typed, expect] of [['CA2', 'P00918'], ['EGFR', 'P00533'], ['carbonic anhydrase 2', 'P00918']] as const) {
  const hits = shard('name', normaliseName(typed))?.n?.[normaliseName(typed)] ?? [];
  check(`"${typed}"`, hits.includes(expect), hits.slice(0, 4).join(', ') || 'no hits');
}

// ── carbonic anhydrase 2: the density-check poster child ──
console.log('\nP00918 (carbonic anhydrase 2)');
const ca2 = lookup('P00918');
if (!ca2) { check('shard lookup', false, 'accession absent'); }
else {
  check('display name', /carbonic anhydrase/i.test(ca2.display?.[0] ?? ''), ca2.display?.join(' / ') ?? '');
  check('has many ligands', ca2.rows.length > 1000, `${ca2.rows.length} rows`);

  const scored = ca2.rows.filter((r) => (r.flags & FLAG_HAS_RSCC) && r.pct !== null);
  scored.sort((a, b) => a.pct! - b.pct! || a.q - b.q);
  console.log('  worst-ranked, real ligands only:');
  const real = scored.filter((r) => !(r.flags & FLAG_ADDITIVE) && (r.flags & FLAG_SOI));
  for (const r of real.slice(0, 5)) {
    console.log(`    ${r.entry}/${r.comp} ${r.chain}${r.seq}  RSCC ${r.rscc!.toFixed(3)}  ` +
      `${r.resolution?.toFixed(2)}A  p${r.pct!.toFixed(1)}`);
  }
  check('worst is genuinely poor', (real[0]?.rscc ?? 1) < 0.45, `worst RSCC ${real[0]?.rscc?.toFixed(3)}`);
}

// ── the resolution-shell effect must actually bite ──
console.log('\nranking sanity');
const cdf = meta.cdfRscc;
const highRes = shellOf(1.1);
const lowRes = shellOf(3.5);
const q085 = Math.round(((0.85 + 1) / 2) * 254);
const pHigh = (cdf[highRes][q085] / 65535) * 100;
const pLow = (cdf[lowRes][q085] / 65535) * 100;
check('RSCC 0.85 ranks worse at 1.1A than at 3.5A', pHigh < pLow,
  `p${pHigh.toFixed(1)} vs p${pLow.toFixed(1)}`);
check('every shell has a reference population', meta.reference.perShell.every((n: number) => n >= meta.reference.minPerShell),
  meta.reference.perShell.join('/'));

// ── multi-target attribution ──
console.log('\ncontact attribution');
const fkbp = lookup('P62942');   // FKBP12: rapamycin should be here
const rapaInFkbp = fkbp?.rows.some((r) => r.entry === '1FAP' && r.comp === 'RAP');
const mtor = lookup('P42345');   // mTOR: the same rapamycin, secondary
const rapaInMtor = mtor?.rows.some((r) => r.entry === '1FAP' && r.comp === 'RAP');
check('1FAP rapamycin under FKBP12', !!rapaInFkbp, '');
check('1FAP rapamycin also under mTOR', !!rapaInMtor, 'multi-target ligands appear under both');

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : 'index verified'}`);
if (failures) process.exit(1);

