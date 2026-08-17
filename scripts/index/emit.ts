// Stage 2 build, part 2: turn the raw crawl into the shipped index.
//
// This stage is PURE: same raw snapshot + same code = byte-identical output.
// The network stage is cached, this stage is deterministic, and that split is
// what makes the build idempotent and reviewable.
//
// Attribution rule that decides the whole size budget: a ligand belongs to the
// accessions it physically CONTACTS (rcsb_target_neighbors), never to every
// accession in the entry. Contact attribution yields ~1.9M (ligand, accession)
// pairs; naive co-occurrence yields ~56M — a 29x difference, and the naive
// version is also wrong, since it claims a ligand is "in" a protein it never
// touches.
//
// Run: npm run index:emit
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forEachEntry } from './crawl';
import {
  LIGAND_BUCKETS, NAME_BUCKETS, ligandShard, nameShard, normaliseName,
  quantiseRscc, quantiseUnit, shellOf, sizeOf, SHELL_EDGES, N_SIZE_BUCKETS, SIZE_EDGES, ADDITIVES, ABSENT,
  FLAG_SOI, FLAG_HAS_RSCC, FLAG_XRAY, FLAG_EM, FLAG_OTHER_METHOD,
  FLAG_ADDITIVE, FLAG_BEST_INSTANCE, FLAG_PRIMARY_TARGET,
} from '../../src/lib/bucket';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = join(ROOT, '.index-raw');
const OUT = join(ROOT, 'public', 'index');

interface Row {
  accession: string;
  entry: string;
  comp: string;
  chain: string;
  seq: number;
  rscc: number;
  rsr: number;
  fit: number;
  natoms: number;
  targets: number;
  flags: number;
  resolution: number;   // *100, 65535 absent
  year: number;
}

const MIN_REF_PER_SHELL = 2000;
const MIN_REF_PER_CELL = 500;   // below this a 99-point distribution is noise

function methodFlag(method: string | null | undefined): number {
  const m = (method ?? '').toUpperCase();
  if (m.includes('X-RAY') || m.includes('NEUTRON')) return FLAG_XRAY;
  if (m.includes('ELECTRON MICROSCOPY') || m.includes('EM')) return FLAG_EM;
  return FLAG_OTHER_METHOD;
}

async function main(): Promise<void> {
  const started = Date.now();

  // ── chemical components: names + weights, and the additive rule ──
  const compRows = JSON.parse(gunzipSync(await readFile(join(RAW, 'comps.json.gz'))).toString());
  const compName = new Map<string, string>();
  const compWeight = new Map<string, number>();
  for (const c of compRows) {
    const id = c?.chem_comp?.id ?? c?.rcsb_id;
    if (!id) continue;
    if (c.chem_comp?.name) compName.set(id, c.chem_comp.name);
    if (Number.isFinite(c.chem_comp?.formula_weight)) compWeight.set(id, c.chem_comp.formula_weight);
  }
  console.log(`comps: ${compName.size} named, ${compWeight.size} weighed`);

  const isAdditive = (comp: string): boolean => {
    if (ADDITIVES.has(comp)) return true;
    const w = compWeight.get(comp);
    // Under ~250 Da a "ligand" is almost always a buffer, cryoprotectant or ion.
    return w !== undefined && w < 250;
  };

  // ── accession dictionary: display names for the header ──
  const accRows = JSON.parse(gunzipSync(await readFile(join(RAW, 'accessions.json.gz'))).toString());
  const display = new Map<string, [string, string, string]>();
  const namesToAccession = new Map<string, Set<string>>();
  // Several of these fields are arrays in the API (rcsb_uniprot_entry_name is
  // ["ISK4_PIG"], not "ISK4_PIG"), so normalise the container as well as the
  // string.
  const addName = (raw: string | string[] | undefined | null, acc: string) => {
    if (!raw) return;
    for (const one of Array.isArray(raw) ? raw : [raw]) {
      if (typeof one !== 'string') continue;
      const key = normaliseName(one);
      if (!key) continue;
      if (!namesToAccession.has(key)) namesToAccession.set(key, new Set());
      namesToAccession.get(key)!.add(acc);
    }
  };

  for (const pe of accRows) {
    for (const u of pe?.uniprots ?? []) {
      const acc = u?.rcsb_uniprot_accession?.[0] ?? u?.rcsb_id;
      if (!acc) continue;
      const protein = u?.rcsb_uniprot_protein?.name?.value ?? '';
      // gene is [{ name: [{ value }] }] — verified against a real record.
      const genes: string[] = [];
      for (const g of u?.rcsb_uniprot_protein?.gene ?? []) {
        for (const n of g?.name ?? []) if (n?.value) genes.push(n.value);
      }
      const gene = genes[0] ?? '';
      const organism = u?.rcsb_uniprot_protein?.source_organism?.scientific_name ?? '';
      if (!display.has(acc)) display.set(acc, [protein, gene, organism]);
      for (const g of genes) addName(g, acc);   // every synonym, not just the first
      addName(protein, acc);
      addName(u?.rcsb_uniprot_entry_name, acc);
      addName(acc, acc);
    }
  }
  console.log(`accessions: ${display.size} with display names, ${namesToAccession.size} searchable names`);

  // ── walk the crawl and emit one row per (ligand instance, contacted accession) ──
  const rows: Row[] = [];
  let instances = 0;
  let unattributed = 0;

  const stats = await forEachEntry((e) => {
    const info = e.rcsb_entry_info ?? {};
    const resolution = Array.isArray(info.resolution_combined) ? info.resolution_combined[0] : null;
    const resQ = Number.isFinite(resolution) ? Math.min(65534, Math.round(resolution * 100)) : 65535;
    const mflag = methodFlag(Array.isArray(info.experimental_method) ? info.experimental_method[0] : info.experimental_method);
    const released = e.rcsb_accession_info?.initial_release_date;
    const year = released ? Math.max(0, Math.min(254, Number(released.slice(0, 4)) - 1970)) : ABSENT;

    // entity_id -> accessions, for resolving contacts to targets
    const entityAccessions = new Map<string, string[]>();
    for (const pe of e.polymer_entities ?? []) {
      const ids = pe.rcsb_polymer_entity_container_identifiers;
      if (ids?.entity_id && ids.uniprot_ids?.length) entityAccessions.set(String(ids.entity_id), ids.uniprot_ids);
    }

    for (const ne of e.nonpolymer_entities ?? []) {
      for (const inst of ne.nonpolymer_entity_instances ?? []) {
        instances++;
        const ids = inst.rcsb_nonpolymer_entity_instance_container_identifiers ?? {};
        const comp = ids.comp_id;
        if (!comp) continue;
        const score = Array.isArray(inst.rcsb_nonpolymer_instance_validation_score)
          ? inst.rcsb_nonpolymer_instance_validation_score[0]
          : inst.rcsb_nonpolymer_instance_validation_score;

        // Which accessions does this ligand actually touch, and how strongly?
        const contactCount = new Map<string, number>();
        const contactMin = new Map<string, number>();
        for (const nb of inst.rcsb_target_neighbors ?? []) {
          const accs = entityAccessions.get(String(nb.target_entity_id));
          if (!accs) continue;
          for (const acc of accs) {
            contactCount.set(acc, (contactCount.get(acc) ?? 0) + 1);
            const d = Number(nb.distance);
            if (Number.isFinite(d)) contactMin.set(acc, Math.min(contactMin.get(acc) ?? Infinity, d));
          }
        }
        if (!contactCount.size) { unattributed++; continue; }

        // Primary target = most contacts, ties broken by closest approach.
        const ranked = [...contactCount.entries()].sort((a, b) => {
          const d = b[1] - a[1];
          if (d) return d;
          return (contactMin.get(a[0]) ?? 99) - (contactMin.get(b[0]) ?? 99);
        });

        const rscc = score?.RSCC ?? null;
        let flags = mflag;
        if (score?.is_subject_of_investigation === 'Y') flags |= FLAG_SOI;
        if (rscc !== null && Number.isFinite(rscc)) flags |= FLAG_HAS_RSCC;
        if (score?.is_best_instance === 'Y') flags |= FLAG_BEST_INSTANCE;
        if (isAdditive(comp)) flags |= FLAG_ADDITIVE;

        for (const [acc] of ranked) {
          rows.push({
            accession: acc,
            entry: e.rcsb_id,
            comp,
            chain: ids.auth_asym_id ?? '',
            seq: Number(ids.auth_seq_id ?? 0),
            rscc: quantiseRscc(rscc),
            rsr: quantiseUnit(score?.RSR ?? null),
            fit: quantiseUnit(score?.ranking_model_fit ?? null),
            natoms: Number.isFinite(score?.natoms_eds) ? Math.min(254, score.natoms_eds) : ABSENT,
            targets: Math.min(255, contactCount.size),
            flags: flags | (acc === ranked[0][0] ? FLAG_PRIMARY_TARGET : 0),
            resolution: resQ,
            year,
          });
        }
      }
    }
  });

  console.log(`entries: ${stats.entries} parsed (${stats.missing} ids not returned by the API)`);
  console.log(`ligand instances: ${instances}; unattributed (no UniProt-mapped contact): ${unattributed} (${(unattributed / instances * 100).toFixed(1)}%)`);
  console.log(`(ligand, accession) rows: ${rows.length} — amplification ${(rows.length / instances).toFixed(3)}x`);

  // ── ranking CDFs, built from the reference population ──
  // Reference = X-ray, RSCC present, and RCSB's own "the paper is about this
  // ligand" flag. Referencing against ALL rows would let magnesium ions define
  // "normal fit" and make every real ligand look bad.
  const refByShell: number[][] = Array.from({ length: SHELL_EDGES.length + 1 }, () => []);
  for (const r of rows) {
    if (!(r.flags & FLAG_XRAY) || !(r.flags & FLAG_HAS_RSCC) || !(r.flags & FLAG_SOI)) continue;
    if (!(r.flags & FLAG_PRIMARY_TARGET)) continue;  // count each instance once
    refByShell[shellOf(r.resolution === 65535 ? null : r.resolution / 100)].push(r.rscc);
  }

  /** Mid-rank CDF over quantised RSCC. A large tied mass must not collapse to 100%. */
  const cdfOf = (vals: number[]): number[] => {
    const counts = new Array(255).fill(0);
    for (const v of vals) if (v !== ABSENT) counts[v]++;
    const table = new Array(255).fill(0);
    let cum = 0;
    for (let q = 0; q < 255; q++) {
      table[q] = Math.round(((cum + 0.5 * counts[q]) / vals.length) * 65535);
      cum += counts[q];
    }
    return table;
  };

  const cdf: number[][] = [];
  const shellCounts: number[] = [];
  for (let s = 0; s < refByShell.length; s++) {
    const vals = refByShell[s];
    shellCounts.push(vals.length);
    cdf.push(vals.length >= MIN_REF_PER_SHELL ? cdfOf(vals) : new Array(255).fill(0));
  }
  console.log(`reference population per shell: ${shellCounts.join(', ')}`);

  // ── second axis: ligand SIZE ──
  // RSCC depends on how many atoms are being correlated, not just resolution.
  // Where a (shell, size) cell has enough reference ligands of its own, rank
  // against that cell; where it does not, fall back to the 1-D shell table
  // rather than inventing a distribution from a handful of ligands.
  const refByCell: number[][][] = Array.from({ length: SHELL_EDGES.length + 1 }, () =>
    Array.from({ length: N_SIZE_BUCKETS }, () => [] as number[]));
  for (const r of rows) {
    if (!(r.flags & FLAG_XRAY) || !(r.flags & FLAG_HAS_RSCC) || !(r.flags & FLAG_SOI)) continue;
    if (!(r.flags & FLAG_PRIMARY_TARGET)) continue;
    const s = shellOf(r.resolution === 65535 ? null : r.resolution / 100);
    const z = sizeOf(r.natoms === ABSENT ? null : r.natoms);
    refByCell[s][z].push(r.rscc);
  }

  const cdf2: Array<Array<number[] | null>> = [];
  const cellCounts: number[][] = [];
  let cellsBuilt = 0;
  for (let s = 0; s < refByCell.length; s++) {
    const row: Array<number[] | null> = [];
    const counts: number[] = [];
    for (let z = 0; z < N_SIZE_BUCKETS; z++) {
      const vals = refByCell[s][z];
      counts.push(vals.length);
      if (vals.length >= MIN_REF_PER_CELL) { row.push(cdfOf(vals)); cellsBuilt++; }
      else row.push(null);
    }
    cdf2.push(row);
    cellCounts.push(counts);
  }
  console.log(`size-stratified cells: ${cellsBuilt} of ${refByCell.length * N_SIZE_BUCKETS} have >= ${MIN_REF_PER_CELL} references`);

  // ── shard the rows ──
  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, 'lig'), { recursive: true });
  await mkdir(join(OUT, 'name'), { recursive: true });

  const byShard = new Map<string, Row[]>();
  for (const r of rows) {
    const shard = ligandShard(r.accession);
    if (!byShard.has(shard)) byShard.set(shard, []);
    byShard.get(shard)!.push(r);
  }

  let totalBytes = 0;
  const sizes: number[] = [];
  for (const [shard, shardRows] of byShard) {
    shardRows.sort((a, b) => a.accession.localeCompare(b.accession)
      || a.entry.localeCompare(b.entry) || a.chain.localeCompare(b.chain) || a.seq - b.seq);

    const E: string[] = []; const eIdx = new Map<string, number>();
    const C: string[] = []; const cIdx = new Map<string, number>();
    const A: Record<string, [number, number]> = {};
    const D: Record<string, [string, string, string]> = {};
    const cols = { e: [] as number[], c: [] as number[], h: [] as string[], s: [] as number[],
      q: [] as number[], r: [] as number[], k: [] as number[], n: [] as number[],
      g: [] as number[], f: [] as number[], R: [] as number[], y: [] as number[] };

    let start = 0;
    let current = '';
    shardRows.forEach((row, i) => {
      if (row.accession !== current) {
        if (current) A[current] = [start, i - start];
        current = row.accession;
        start = i;
        const d = display.get(current);
        if (d) D[current] = d;
      }
      let e = eIdx.get(row.entry);
      if (e === undefined) { e = E.length; E.push(row.entry); eIdx.set(row.entry, e); }
      let c = cIdx.get(row.comp);
      if (c === undefined) { c = C.length; C.push(row.comp); cIdx.set(row.comp, c); }
      cols.e.push(e); cols.c.push(c); cols.h.push(row.chain); cols.s.push(row.seq);
      cols.q.push(row.rscc); cols.r.push(row.rsr); cols.k.push(row.fit); cols.n.push(row.natoms);
      cols.g.push(row.targets); cols.f.push(row.flags); cols.R.push(row.resolution); cols.y.push(row.year);
    });
    if (current) A[current] = [start, shardRows.length - start];

    const payload = JSON.stringify({ v: 2, nb: LIGAND_BUCKETS, E, C, A, D, ...cols });
    await writeFile(join(OUT, 'lig', `${shard}.json`), payload);
    totalBytes += payload.length;
    sizes.push(payload.length);
  }

  sizes.sort((a, b) => a - b);
  console.log(`lig/: ${byShard.size} shards, ${(totalBytes / 1024 / 1024).toFixed(1)} MB raw, ` +
    `p50 ${sizes[Math.floor(sizes.length / 2)]} B, p95 ${sizes[Math.floor(sizes.length * 0.95)]} B, max ${sizes[sizes.length - 1]} B`);

  // ── name shards ──
  const nameByShard = new Map<string, Record<string, string[]>>();
  const ligandCount = new Map<string, number>();
  for (const r of rows) ligandCount.set(r.accession, (ligandCount.get(r.accession) ?? 0) + 1);

  for (const [name, accs] of namesToAccession) {
    const shard = nameShard(name);
    if (!nameByShard.has(shard)) nameByShard.set(shard, {});
    // Most ligand-bearing accession first: a user typing a gene symbol wants
    // the target that actually has structures.
    nameByShard.get(shard)![name] = [...accs]
      .sort((a, b) => (ligandCount.get(b) ?? 0) - (ligandCount.get(a) ?? 0))
      .slice(0, 8);
  }
  let nameBytes = 0;
  for (const [shard, map] of nameByShard) {
    const payload = JSON.stringify({ v: 2, n: map });
    await writeFile(join(OUT, 'name', `${shard}.json`), payload);
    nameBytes += payload.length;
  }
  console.log(`name/: ${nameByShard.size} shards, ${(nameBytes / 1024 / 1024).toFixed(1)} MB raw`);

  // ── comps + meta ──
  const compsOut: Record<string, [string, number | null]> = {};
  for (const [id, name] of compName) compsOut[id] = [name, compWeight.get(id) ?? null];
  await writeFile(join(OUT, 'comps.json'), JSON.stringify(compsOut));

  const meta = {
    v: 2,
    built: new Date().toISOString().slice(0, 10),
    buckets: { lig: LIGAND_BUCKETS, name: NAME_BUCKETS },
    hash: 'fnv1a32',
    shells: SHELL_EDGES,
    sizes: SIZE_EDGES,
    counts: {
      entries: stats.entries, missingEntries: stats.missing, instances,
      unattributed, rows: rows.length, accessions: display.size,
      shards: byShard.size, comps: compName.size,
    },
    reference: { rule: 'X-ray AND RSCC present AND is_subject_of_investigation=Y', perShell: shellCounts, minPerShell: MIN_REF_PER_SHELL, perCell: cellCounts, minPerCell: MIN_REF_PER_CELL },
    cdfRscc: cdf,
    cdfRsccBySize: cdf2,
  };
  await writeFile(join(OUT, 'meta.json'), JSON.stringify(meta));
  console.log(`meta.json: ${(JSON.stringify(meta).length / 1024).toFixed(0)} KB`);
  console.log(`emit complete in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });


