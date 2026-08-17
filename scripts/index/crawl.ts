// Stage 2 build, part 1: crawl the archive's ligand validation metadata.
//
// No bulk download of per-ligand RSCC exists — this was checked against
// files.rcsb.org/pub, the wwPDB derived_data trees, and EBI's MSD mirrors. The
// only alternative is per-entry validation XML, which is 162,016 requests and
// ~3.4 GB against ~1,040 requests and ~40 MB here.
//
// NO DENSITY IS FETCHED. Cross-entry ranking uses RCSB's published, already
// normalised metrics; our own per-atom sigma stays a within-one-map signal
// computed live when a user opens a ligand. That decision is what makes an
// archive-scale index a six-minute job instead of a multi-day one.
//
// Resumability contract:
//   - The frozen, sorted entry list defines batch k for all time.
//   - A batch is written atomically (.tmp then rename) and is only "done" if it
//     parses AND every requested id is either present or recorded as missing.
//   - GraphQL SILENTLY DROPS unknown ids, so a short response is not success.
//   - Response order does not match request order. Everything is keyed by id.
//
// Run: npm run index:crawl
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = join(ROOT, '.index-raw');
const ENTRY_BATCH = 250;      // hard cap is 1000; 250 keeps a failed batch cheap
const DICT_BATCH = 1000;
const CONCURRENCY = 8;
const GRAPHQL = 'https://data.rcsb.org/graphql';

const ENTRY_QUERY = `query($ids:[String!]!){
  entries(entry_ids:$ids){
    rcsb_id
    rcsb_entry_info{ resolution_combined experimental_method }
    rcsb_accession_info{ initial_release_date }
    polymer_entities{
      rcsb_polymer_entity_container_identifiers{ entity_id uniprot_ids } }
    nonpolymer_entities{
      nonpolymer_entity_instances{
        rcsb_nonpolymer_entity_instance_container_identifiers{ entry_id asym_id auth_asym_id auth_seq_id comp_id }
        rcsb_nonpolymer_instance_validation_score{
          RSCC RSR ranking_model_fit natoms_eds average_occupancy
          is_subject_of_investigation is_best_instance alt_id }
        rcsb_target_neighbors{ target_entity_id target_asym_id distance } } } } }`;

const ACCESSION_QUERY = `query($ids:[String!]!){
  polymer_entities(entity_ids:$ids){
    rcsb_id
    rcsb_polymer_entity_container_identifiers{ uniprot_ids }
    uniprots{ rcsb_id
      rcsb_uniprot_entry_name
      rcsb_uniprot_accession
      rcsb_uniprot_protein{ name{ value } gene{ name{ value } } source_organism{ scientific_name } } } } }`;

const COMP_QUERY = `query($ids:[String!]!){
  chem_comps(comp_ids:$ids){ rcsb_id chem_comp{ id name formula formula_weight type } } }`;

async function post(query: string, ids: string[], attempt = 0): Promise<any> {
  try {
    const res = await fetch(GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { ids } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as any;
    if (json.errors?.length) throw new Error(json.errors[0]?.message ?? 'graphql error');
    return json.data;
  } catch (err) {
    // Observed failures are dropped sockets, not HTTP errors: the server sends
    // Connection: close and Node's keep-alive pool reuses a dead socket.
    if (attempt >= 3) throw err;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return post(query, ids, attempt + 1);
  }
}

/** Run `worker` over `items` with a fixed number of parallel lanes. */
async function pool<T>(items: T[], limit: number, worker: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
}

function batchesOf<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function writeAtomic(path: string, data: Buffer): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function fetchEntryIds(): Promise<string[]> {
  const res = await fetch('https://data.rcsb.org/rest/v1/holdings/current/entry_ids');
  if (!res.ok) throw new Error(`entry ids: HTTP ${res.status}`);
  const ids = await res.json() as string[];
  // Sorting freezes batch membership: batch k must contain the same entries on
  // every run or resume is not correct.
  return ids.map((s) => s.toUpperCase()).sort();
}

async function crawlEntries(entryIds: string[]): Promise<void> {
  const dir = join(RAW, 'entries');
  await mkdir(dir, { recursive: true });

  const existing = new Set((await readdir(dir)).filter((f) => f.endsWith('.json.gz')));
  const batches = batchesOf(entryIds, ENTRY_BATCH);
  const todo: Array<{ k: number; ids: string[] }> = [];
  for (let k = 0; k < batches.length; k++) {
    if (!existing.has(`${String(k).padStart(5, '0')}.json.gz`)) todo.push({ k, ids: batches[k] });
  }

  console.log(`entries: ${entryIds.length} in ${batches.length} batches — ${todo.length} to fetch, ${batches.length - todo.length} cached`);
  if (!todo.length) return;

  let done = 0;
  let missingTotal = 0;
  const started = Date.now();

  await pool(todo, CONCURRENCY, async ({ k, ids }) => {
    const data = await post(ENTRY_QUERY, ids);
    const entries = (data?.entries ?? []).filter(Boolean);
    // Reconcile: a short response is not an error from GraphQL's point of view.
    const returned = new Set(entries.map((e: any) => e.rcsb_id));
    const missing = ids.filter((id) => !returned.has(id));
    missingTotal += missing.length;

    await writeAtomic(
      join(dir, `${String(k).padStart(5, '0')}.json.gz`),
      gzipSync(Buffer.from(JSON.stringify({ requested: ids.length, missing, entries })), { level: 6 }),
    );

    done++;
    if (done % 50 === 0 || done === todo.length) {
      const rate = done / ((Date.now() - started) / 1000);
      const eta = Math.round((todo.length - done) / Math.max(rate, 0.01));
      console.log(`  ${done}/${todo.length} batches  ${rate.toFixed(1)}/s  eta ${eta}s  missing ${missingTotal}`);
    }
  });
}

/** Read every cached batch and hand the entries to a callback. */
export async function forEachEntry(fn: (entry: any) => void): Promise<{ batches: number; entries: number; missing: number }> {
  const dir = join(RAW, 'entries');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json.gz')).sort();
  let entries = 0;
  let missing = 0;
  for (const f of files) {
    const payload = JSON.parse(gunzipSync(await readFile(join(dir, f))).toString());
    missing += payload.missing?.length ?? 0;
    for (const e of payload.entries) { fn(e); entries++; }
  }
  return { batches: files.length, entries, missing };
}

async function crawlDictionaries(): Promise<void> {
  // Collect the representative entity per accession, and every comp id.
  const entityForAccession = new Map<string, string>();
  const comps = new Set<string>();

  await forEachEntry((e) => {
    for (const pe of e.polymer_entities ?? []) {
      const ids = pe.rcsb_polymer_entity_container_identifiers;
      for (const acc of ids?.uniprot_ids ?? []) {
        if (!entityForAccession.has(acc)) entityForAccession.set(acc, `${e.rcsb_id}_${ids.entity_id}`);
      }
    }
    for (const ne of e.nonpolymer_entities ?? []) {
      for (const inst of ne.nonpolymer_entity_instances ?? []) {
        const comp = inst.rcsb_nonpolymer_entity_instance_container_identifiers?.comp_id;
        if (comp) comps.add(comp);
      }
    }
  });

  console.log(`dictionaries: ${entityForAccession.size} accessions, ${comps.size} chemical components`);

  const accOut = join(RAW, 'accessions.json.gz');
  const accessionRows: any[] = [];
  const entityIds = [...entityForAccession.values()];
  await pool(batchesOf(entityIds, DICT_BATCH), CONCURRENCY, async (ids) => {
    const data = await post(ACCESSION_QUERY, ids);
    for (const pe of data?.polymer_entities ?? []) if (pe) accessionRows.push(pe);
  });
  await writeAtomic(accOut, gzipSync(Buffer.from(JSON.stringify(accessionRows)), { level: 6 }));
  console.log(`  wrote ${accessionRows.length} accession records`);

  const compRows: any[] = [];
  await pool(batchesOf([...comps], DICT_BATCH), CONCURRENCY, async (ids) => {
    const data = await post(COMP_QUERY, ids);
    for (const c of data?.chem_comps ?? []) if (c) compRows.push(c);
  });
  await writeAtomic(join(RAW, 'comps.json.gz'), gzipSync(Buffer.from(JSON.stringify(compRows)), { level: 6 }));
  console.log(`  wrote ${compRows.length} chemical components (${comps.size - compRows.length} unresolved)`);
}

async function main(): Promise<void> {
  await mkdir(RAW, { recursive: true });
  const started = Date.now();

  const idsPath = join(RAW, 'entries.txt');
  let entryIds: string[];
  try {
    entryIds = (await readFile(idsPath, 'utf8')).split('\n').filter(Boolean);
    console.log(`using frozen entry list: ${entryIds.length} entries`);
  } catch {
    entryIds = await fetchEntryIds();
    await writeAtomic(idsPath, Buffer.from(entryIds.join('\n')));
    console.log(`froze entry list: ${entryIds.length} entries`);
  }

  await crawlEntries(entryIds);
  await crawlDictionaries();
  console.log(`crawl complete in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
}

// Only run when invoked directly; forEachEntry is imported by the emitter and
// by crawl-em. The check must be exact: `includes('crawl')` also matches
// `crawl-em.ts`, which silently re-ran this entire pass on import.
if (process.argv[1] && /[\\/]crawl\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

