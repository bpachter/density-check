// Cryo-EM pass.
//
// Q-score and RSCC are DISJOINT populations, not two flavours of one number:
// RSCC comes from a crystallographic difference map, Q-score from how well an
// atom sits in a cryo-EM potential map. Every instance that has one lacks the
// other. So this builds a parallel index rather than adding a column, and the
// UI never ranks them in one list.
//
// Only EM entries are re-queried — the cached crawl already knows which those
// are — so this is ~60 batches rather than another full pass.
//
// Run: npm run index:crawl-em
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forEachEntry } from './crawl';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = join(ROOT, '.index-raw');
const BATCH = 250;
const CONCURRENCY = 8;

const EM_QUERY = `query($ids:[String!]!){
  entries(entry_ids:$ids){
    rcsb_id
    rcsb_entry_info{ resolution_combined experimental_method }
    rcsb_accession_info{ initial_release_date }
    rcsb_entry_container_identifiers{ emdb_ids }
    polymer_entities{
      rcsb_polymer_entity_container_identifiers{ entity_id uniprot_ids } }
    nonpolymer_entities{
      nonpolymer_entity_instances{
        rcsb_nonpolymer_entity_instance_container_identifiers{ entry_id asym_id auth_asym_id auth_seq_id comp_id }
        rcsb_nonpolymer_instance_validation_score{
          Q_score RSCC is_subject_of_investigation is_best_instance }
        rcsb_target_neighbors{ target_entity_id distance } } } } }`;

async function post(ids: string[], attempt = 0): Promise<any> {
  try {
    const res = await fetch('https://data.rcsb.org/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: EM_QUERY, variables: { ids } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as any;
    if (json.errors?.length) throw new Error(json.errors[0]?.message ?? 'graphql error');
    return json.data;
  } catch (err) {
    if (attempt >= 3) throw err;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return post(ids, attempt + 1);
  }
}

async function main(): Promise<void> {
  // Which entries are EM, and actually carry a ligand? Straight from the cache.
  const emEntries: string[] = [];
  await forEachEntry((e) => {
    const method = e.rcsb_entry_info?.experimental_method;
    const m = (Array.isArray(method) ? method[0] : method ?? '').toUpperCase();
    if (!m.includes('ELECTRON MICROSCOPY') && m !== 'EM') return;
    const hasLigand = (e.nonpolymer_entities ?? []).some((ne: any) => (ne.nonpolymer_entity_instances ?? []).length);
    if (hasLigand) emEntries.push(e.rcsb_id);
  });
  emEntries.sort();
  console.log(`EM entries carrying a ligand: ${emEntries.length}`);

  const batches: string[][] = [];
  for (let i = 0; i < emEntries.length; i += BATCH) batches.push(emEntries.slice(i, i + BATCH));

  const out: any[] = [];
  let done = 0;
  let next = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= batches.length) return;
      const data = await post(batches[i]);
      for (const e of data?.entries ?? []) if (e) out.push(e);
      done++;
      if (done % 20 === 0 || done === batches.length) {
        console.log(`  ${done}/${batches.length} batches  ${(done / ((Date.now() - started) / 1000)).toFixed(1)}/s`);
      }
    }
  }));

  const path = join(RAW, 'em.json.gz');
  await mkdir(RAW, { recursive: true });
  await writeFile(`${path}.tmp`, gzipSync(Buffer.from(JSON.stringify(out)), { level: 6 }));
  await rename(`${path}.tmp`, path);

  let scored = 0;
  for (const e of out) {
    for (const ne of e.nonpolymer_entities ?? []) {
      for (const inst of ne.nonpolymer_entity_instances ?? []) {
        const s = Array.isArray(inst.rcsb_nonpolymer_instance_validation_score)
          ? inst.rcsb_nonpolymer_instance_validation_score[0]
          : inst.rcsb_nonpolymer_instance_validation_score;
        if (Number.isFinite(s?.Q_score)) scored++;
      }
    }
  }
  console.log(`wrote ${out.length} EM entries; ${scored} ligand instances carry a Q-score`);
}

main().catch((e) => { console.error(e); process.exit(1); });
