// Emit the parallel cryo-EM index.
//
// Same shard layout and bucket function as lig/, so the client addresses it
// identically — but a SEPARATE tree, because Q-score and RSCC measure
// different things against different kinds of map. Merging them into one
// ranked list would produce a number nobody could defend.
//
// Run: npm run index:emit-em
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIGAND_BUCKETS, ligandShard, quantiseRscc, ADDITIVES, ABSENT,
  FLAG_SOI, FLAG_EM, FLAG_ADDITIVE, FLAG_BEST_INSTANCE, FLAG_PRIMARY_TARGET,
} from '../../src/lib/bucket';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = join(ROOT, '.index-raw');
const OUT = join(ROOT, 'public', 'index');

/**
 * Cryo-EM resolutions cluster where crystallographic ones do not, so the
 * crystallographic shells would put almost everything in one bin. These are
 * frozen constants for the same reason the X-ray ones are: quantile-derived
 * edges drift as the archive grows and would silently restate old percentiles.
 */
const EM_SHELL_EDGES = [2.0, 2.5, 3.0, 3.5, 4.0, 5.0];
const MIN_REF_PER_SHELL = 500;

function emShellOf(resolution: number | null): number {
  if (resolution === null || !Number.isFinite(resolution)) return EM_SHELL_EDGES.length;
  for (let i = 0; i < EM_SHELL_EDGES.length; i++) if (resolution < EM_SHELL_EDGES[i]) return i;
  return EM_SHELL_EDGES.length;
}

interface Row {
  accession: string; entry: string; comp: string; chain: string; seq: number;
  q: number; flags: number; resolution: number; year: number; targets: number; emdb: string;
}

async function main(): Promise<void> {
  const started = Date.now();
  const entries = JSON.parse(gunzipSync(await readFile(join(RAW, 'em.json.gz'))).toString());
  const compRows = JSON.parse(gunzipSync(await readFile(join(RAW, 'comps.json.gz'))).toString());
  const compWeight = new Map<string, number>();
  for (const c of compRows) {
    const id = c?.chem_comp?.id ?? c?.rcsb_id;
    if (id && Number.isFinite(c.chem_comp?.formula_weight)) compWeight.set(id, c.chem_comp.formula_weight);
  }
  const isAdditive = (comp: string) => ADDITIVES.has(comp) || (compWeight.get(comp) ?? 999) < 250;

  const rows: Row[] = [];
  let instances = 0;
  let unattributed = 0;
  let unscored = 0;

  for (const e of entries) {
    const info = e.rcsb_entry_info ?? {};
    const resolution = Array.isArray(info.resolution_combined) ? info.resolution_combined[0] : null;
    const resQ = Number.isFinite(resolution) ? Math.min(65534, Math.round(resolution * 100)) : 65535;
    const released = e.rcsb_accession_info?.initial_release_date;
    const year = released ? Math.max(0, Math.min(254, Number(released.slice(0, 4)) - 1970)) : ABSENT;
    const emdb = e.rcsb_entry_container_identifiers?.emdb_ids?.[0] ?? '';

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
        const qs = score?.Q_score;
        if (!Number.isFinite(qs)) { unscored++; continue; }

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

        const ranked = [...contactCount.entries()].sort((a, b) =>
          (b[1] - a[1]) || ((contactMin.get(a[0]) ?? 99) - (contactMin.get(b[0]) ?? 99)));

        let flags = FLAG_EM;
        if (score?.is_subject_of_investigation === 'Y') flags |= FLAG_SOI;
        if (score?.is_best_instance === 'Y') flags |= FLAG_BEST_INSTANCE;
        if (isAdditive(comp)) flags |= FLAG_ADDITIVE;

        for (const [acc] of ranked) {
          rows.push({
            accession: acc, entry: e.rcsb_id, comp,
            chain: ids.auth_asym_id ?? '', seq: Number(ids.auth_seq_id ?? 0),
            q: quantiseRscc(qs),   // same -1..1 quantisation; Q-score shares the range
            flags: flags | (acc === ranked[0][0] ? FLAG_PRIMARY_TARGET : 0),
            resolution: resQ, year, targets: Math.min(255, contactCount.size), emdb,
          });
        }
      }
    }
  }

  console.log(`EM instances ${instances}; unscored ${unscored}; unattributed ${unattributed}; rows ${rows.length}`);

  // Reference population, on the same principle as the X-ray side: the
  // structure's own subject ligand, so metals do not define a normal fit.
  const refByShell: number[][] = Array.from({ length: EM_SHELL_EDGES.length + 1 }, () => []);
  for (const r of rows) {
    if (!(r.flags & FLAG_SOI) || !(r.flags & FLAG_PRIMARY_TARGET)) continue;
    refByShell[emShellOf(r.resolution === 65535 ? null : r.resolution / 100)].push(r.q);
  }
  const cdf: number[][] = [];
  const shellCounts: number[] = [];
  for (const vals of refByShell) {
    shellCounts.push(vals.length);
    const table = new Array(255).fill(0);
    if (vals.length >= MIN_REF_PER_SHELL) {
      const counts = new Array(255).fill(0);
      for (const v of vals) counts[v]++;
      let cum = 0;
      for (let q = 0; q < 255; q++) { table[q] = Math.round(((cum + 0.5 * counts[q]) / vals.length) * 65535); cum += counts[q]; }
    }
    cdf.push(table);
  }
  console.log(`EM reference per shell: ${shellCounts.join(', ')}`);

  await rm(join(OUT, 'em'), { recursive: true, force: true });
  await mkdir(join(OUT, 'em'), { recursive: true });

  const byShard = new Map<string, Row[]>();
  for (const r of rows) {
    const s = ligandShard(r.accession);
    if (!byShard.has(s)) byShard.set(s, []);
    byShard.get(s)!.push(r);
  }

  let bytes = 0;
  for (const [shard, shardRows] of byShard) {
    shardRows.sort((a, b) => a.accession.localeCompare(b.accession) || a.entry.localeCompare(b.entry) || a.seq - b.seq);
    const E: string[] = []; const eIdx = new Map<string, number>();
    const C: string[] = []; const cIdx = new Map<string, number>();
    const M: string[] = []; const mIdx = new Map<string, number>();
    const A: Record<string, [number, number]> = {};
    const cols = { e: [] as number[], c: [] as number[], h: [] as string[], s: [] as number[],
      q: [] as number[], f: [] as number[], R: [] as number[], y: [] as number[],
      g: [] as number[], m: [] as number[] };

    let start = 0; let current = '';
    shardRows.forEach((row, i) => {
      if (row.accession !== current) {
        if (current) A[current] = [start, i - start];
        current = row.accession; start = i;
      }
      let e = eIdx.get(row.entry); if (e === undefined) { e = E.length; E.push(row.entry); eIdx.set(row.entry, e); }
      let c = cIdx.get(row.comp); if (c === undefined) { c = C.length; C.push(row.comp); cIdx.set(row.comp, c); }
      let m = mIdx.get(row.emdb); if (m === undefined) { m = M.length; M.push(row.emdb); mIdx.set(row.emdb, m); }
      cols.e.push(e); cols.c.push(c); cols.h.push(row.chain); cols.s.push(row.seq);
      cols.q.push(row.q); cols.f.push(row.flags); cols.R.push(row.resolution); cols.y.push(row.year);
      cols.g.push(row.targets); cols.m.push(m);
    });
    if (current) A[current] = [start, shardRows.length - start];

    const payload = JSON.stringify({ v: 1, nb: LIGAND_BUCKETS, E, C, M, A, ...cols });
    await writeFile(join(OUT, 'em', `${shard}.json`), payload);
    bytes += payload.length;
  }
  console.log(`em/: ${byShard.size} shards, ${(bytes / 1048576).toFixed(1)} MB raw`);

  await writeFile(join(OUT, 'em-meta.json'), JSON.stringify({
    v: 1,
    metric: 'Q_score',
    shells: EM_SHELL_EDGES,
    counts: { entries: entries.length, instances, unscored, unattributed, rows: rows.length, shards: byShard.size },
    reference: { rule: 'EM AND Q_score present AND is_subject_of_investigation=Y', perShell: shellCounts, minPerShell: MIN_REF_PER_SHELL },
    cdfQ: cdf,
  }));
  console.log(`emit-em complete in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
