// Entry-level lookup: what ligands does this structure contain, and what does
// the archive already publish about each one?
//
// One GraphQL POST returns every ligand instance with its published validation
// scores. Looping the REST API per instance would be a request per ligand for
// data that arrives here in a single ~13 KB response.

export interface LigandInstance {
  compId: string;
  /** Chemical name from the archive, e.g. 'RETINOIC ACID'. */
  name: string;
  /** Label asym id — the one the validation endpoint keys on. */
  asymId: string;
  authAsymId: string;
  rscc: number | null;
  rsr: number | null;
  /** The archive's own flag for "this is the ligand the paper is about". */
  isSubjectOfInvestigation: boolean;
}

export interface EntrySummary {
  entryId: string;
  title: string;
  resolution: number | null;
  method: string | null;
  ligands: LigandInstance[];
}

const GRAPHQL = 'https://data.rcsb.org/graphql';

// Ions and buffer components are ligands too, but they are not what anyone
// means by "is this molecule real". They stay in the list, just sorted last.
const COMMON_ADDITIVES = new Set([
  'HOH', 'SO4', 'PO4', 'GOL', 'EDO', 'PEG', 'MPD', 'ACT', 'CL', 'NA', 'K', 'MG',
  'CA', 'ZN', 'MN', 'FE', 'NI', 'CD', 'CU', 'IOD', 'BR', 'NO3', 'FMT', 'DMS', 'TRS',
]);

export function isAdditive(compId: string): boolean {
  return COMMON_ADDITIVES.has(compId.toUpperCase());
}

const QUERY = `query Entry($id: String!) {
  entry(entry_id: $id) {
    rcsb_id
    struct { title }
    exptl { method }
    rcsb_entry_info { resolution_combined }
    nonpolymer_entities {
      pdbx_entity_nonpoly { comp_id name }
      nonpolymer_entity_instances {
        rcsb_nonpolymer_entity_instance_container_identifiers { auth_asym_id asym_id }
        rcsb_nonpolymer_instance_validation_score { RSCC RSR is_subject_of_investigation }
      }
    }
  }
}`;

export async function fetchEntry(entryId: string): Promise<EntrySummary> {
  const id = entryId.trim().toUpperCase();
  if (!/^[0-9A-Z]{4}$/.test(id)) {
    throw new Error(`'${entryId}' is not a 4-character PDB id`);
  }

  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { id } }),
  });
  if (!res.ok) throw new Error(`entry lookup: HTTP ${res.status}`);
  const json = await res.json() as any;
  if (json.errors?.length) throw new Error(json.errors[0].message ?? 'GraphQL error');

  const entry = json?.data?.entry;
  if (!entry) throw new Error(`no PDB entry '${id}'`);

  const method: string | null = entry.exptl?.[0]?.method ?? null;
  const ligands: LigandInstance[] = [];

  for (const ent of entry.nonpolymer_entities ?? []) {
    const compId = ent.pdbx_entity_nonpoly?.comp_id;
    if (!compId) continue;
    for (const inst of ent.nonpolymer_entity_instances ?? []) {
      const ids = inst.rcsb_nonpolymer_entity_instance_container_identifiers ?? {};
      const score = Array.isArray(inst.rcsb_nonpolymer_instance_validation_score)
        ? inst.rcsb_nonpolymer_instance_validation_score[0]
        : inst.rcsb_nonpolymer_instance_validation_score;
      ligands.push({
        compId,
        name: ent.pdbx_entity_nonpoly?.name ?? compId,
        asymId: ids.asym_id ?? '',
        authAsymId: ids.auth_asym_id ?? '',
        rscc: score?.RSCC ?? null,
        rsr: score?.RSR ?? null,
        isSubjectOfInvestigation: score?.is_subject_of_investigation === 'Y',
      });
    }
  }

  // Worst-supported first — the whole point of the tool is finding the weak one.
  // Additives sink below real ligands regardless of score.
  ligands.sort((a, b) => {
    const additiveDiff = Number(isAdditive(a.compId)) - Number(isAdditive(b.compId));
    if (additiveDiff) return additiveDiff;
    if (a.rscc === null && b.rscc === null) return a.compId.localeCompare(b.compId);
    if (a.rscc === null) return 1;
    if (b.rscc === null) return -1;
    return a.rscc - b.rscc;
  });

  return {
    entryId: entry.rcsb_id ?? id,
    title: entry.struct?.title ?? '',
    resolution: entry.rcsb_entry_info?.resolution_combined?.[0] ?? null,
    method,
    ligands,
  };
}

/** X-ray only: the density this tool reads does not exist for other methods. */
export function hasDensity(method: string | null): boolean {
  return !!method && method.toUpperCase().includes('X-RAY');
}
