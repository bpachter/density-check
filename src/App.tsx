import { useCallback, useEffect, useMemo, useState } from 'react';
import { LigandPanel } from './components/LigandPanel';
import { TargetPanel } from './components/TargetPanel';
import { Landing } from './components/Landing';
import { CompareView } from './components/CompareView';
import { LocalAnalysis } from './components/LocalAnalysis';
import { resolveTarget } from './lib/targetIndex';
import { fetchEntry, hasDensity, isAdditive, type EntrySummary, type LigandInstance } from './lib/entry';
import { runValidationGate, type GateResult } from './lib/gate';
import { parseRoute, buildHash, type Route } from './lib/route';

function useRoute(): [Route, (next: Partial<Route>) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((next: Partial<Route>) => {
    const merged = { ...parseRoute(window.location.hash), ...next };
    const hash = buildHash(merged);
    if (hash !== window.location.hash) window.location.hash = hash;
    else setRoute(merged as Route);
  }, []);

  return [route, navigate];
}

function Gate({ result, onRerun }: { result: GateResult | null; onRerun: () => void }) {
  if (!result) return <div className="gate gate--running">Verifying the pipeline against known values…</div>;
  const failed = result.checks.filter((c) => !c.ok);
  return (
    <div className={`gate ${result.ok ? 'gate--ok' : 'gate--fail'}`}>
      <div className="gate-line">
        <strong>{result.ok ? 'Self-check passed' : 'Self-check FAILED'}</strong>
        <span>
          {result.ok
            ? `${result.checks.length} checks reproduced on 1CBS/REA in ${result.elapsedMs.toFixed(0)} ms — decoder, axis order, grid geometry, and per-atom sampling.`
            : result.error ?? `${failed.length} of ${result.checks.length} checks did not reproduce. Numbers withheld.`}
        </span>
        <button type="button" onClick={onRerun}>re-run</button>
      </div>
      {!result.ok && failed.length > 0 && (
        <ul className="gate-fails">
          {failed.slice(0, 6).map((c) => (
            <li key={c.name}>{c.name}: expected {c.expected}, got {Number.isFinite(c.actual) ? c.actual.toFixed(4) : 'n/a'}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LigandChooser({
  entry, selected, onPick,
}: { entry: EntrySummary; selected: LigandInstance | null; onPick: (l: LigandInstance) => void }) {
  const real = entry.ligands.filter((l) => !isAdditive(l.compId));
  const additives = entry.ligands.filter((l) => isAdditive(l.compId));

  const chip = (l: LigandInstance) => {
    const key = `${l.compId}/${l.asymId}`;
    const active = selected?.compId === l.compId && selected?.asymId === l.asymId;
    const tone = l.rscc === null ? '' : l.rscc < 0.6 ? ' chip--bad' : l.rscc < 0.8 ? ' chip--warn' : ' chip--ok';
    return (
      <button
        key={key}
        type="button"
        className={`chip${tone}${active ? ' chip--active' : ''}`}
        onClick={() => onPick(l)}
        title={`${l.name}${l.rscc !== null ? ` · RSCC ${l.rscc.toFixed(3)}` : ''}`}
      >
        {l.compId}
        <i>{l.asymId}</i>
        {l.rscc !== null && <b>{l.rscc.toFixed(2)}</b>}
        {l.isSubjectOfInvestigation && <span className="chip-star" title="the ligand this structure is about">★</span>}
      </button>
    );
  };

  return (
    <div className="chooser">
      <div className="chooser-head">
        <span className="entry-id">{entry.entryId}</span>
        <span className="entry-title">{entry.title}</span>
        <span className="entry-meta">
          {entry.method ?? 'unknown method'}{entry.resolution !== null ? ` · ${entry.resolution.toFixed(2)} Å` : ''}
        </span>
      </div>
      {real.length > 0 && <div className="chips-row">{real.map(chip)}</div>}
      {additives.length > 0 && (
        <details className="additives">
          <summary>{additives.length} ion{additives.length > 1 ? 's' : ''} / buffer component{additives.length > 1 ? 's' : ''}</summary>
          <div className="chips-row">{additives.map(chip)}</div>
        </details>
      )}
      {!entry.ligands.length && <p className="muted">This entry has no non-polymer ligands.</p>}
    </div>
  );
}

export default function App() {
  const [gate, setGate] = useState<GateResult | null>(null);
  const [route, navigate] = useRoute();
  const [entry, setEntry] = useState<EntrySummary | null>(null);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [entryLoading, setEntryLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const rerun = useCallback(() => {
    setGate(null);
    runValidationGate().then(setGate);
  }, []);
  useEffect(() => { rerun(); }, [rerun]);

  // Entry follows the URL.
  useEffect(() => {
    if (!route.entry) { setEntry(null); setEntryError(null); return; }
    let live = true;
    setEntryLoading(true);
    setEntryError(null);
    // Drop the previous entry immediately. Leaving it mounted lets the
    // auto-pick effect below choose a ligand from the OLD structure and write
    // it into the URL of the new one.
    setEntry(null);
    fetchEntry(route.entry)
      .then((e) => { if (live) { setEntry(e); setEntryLoading(false); } })
      .catch((err) => {
        if (!live) return;
        setEntry(null);
        setEntryLoading(false);
        setEntryError(err instanceof Error ? err.message : String(err));
      });
    return () => { live = false; };
  }, [route.entry]);

  // Default to the worst-supported real ligand once an entry loads. The
  // entryId guard matters: without it this fires while `entry` is still the
  // previously loaded structure and picks one of ITS ligands.
  useEffect(() => {
    if (!entry || route.comp) return;
    if (entry.entryId.toLowerCase() !== route.entry) return;
    const first = entry.ligands.find((l) => !isAdditive(l.compId)) ?? entry.ligands[0];
    if (first) navigate({ comp: first.compId, asymId: first.asymId });
  }, [entry, route.comp, route.entry, navigate]);

  const selected = useMemo<LigandInstance | null>(() => {
    if (!entry || !route.comp) return null;
    return entry.ligands.find((l) =>
      l.compId === route.comp && (!route.asymId || l.asymId === route.asymId))
      ?? entry.ligands.find((l) => l.compId === route.comp)
      ?? null;
  }, [entry, route.comp, route.asymId]);

  // One box, two kinds of question. A 4-character token is a PDB entry;
  // anything else is a target — an accession, a gene symbol, or a protein name.
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = query.trim();
    if (!raw) return;

    // A 4-character PDB id ALWAYS starts with a digit ("1cbs", "6lu7"), which
    // is what separates it from a 4-letter gene symbol like EGFR or TP53.
    // Without this, every four-letter target silently became an entry lookup.
    if (/^[0-9][0-9a-zA-Z]{3}$/.test(raw)) {
      navigate({ entry: raw.toLowerCase(), comp: null, asymId: null, target: null });
      setQuery('');
      return;
    }

    setSearchError(null);
    setSearching(true);
    try {
      const hits = await resolveTarget(raw);
      if (!hits.length) {
        setSearchError(`No PDB entry, UniProt accession, gene or protein name matching “${raw}”.`);
        return;
      }
      navigate({ target: hits[0] });
      setQuery('');
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const densityAvailable = entry ? hasDensity(entry.method) : true;

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-row">
          <div>
            <h1><a href="#" onClick={() => navigate({ entry: null, comp: null, asymId: null, target: null, compare: null })}>Nullius</a></h1>
            <p className="motto" title="Nullius in verba — the Royal Society's motto since 1660">Per-atom density evidence for every ligand in the PDB</p>
            <p className="lede">
              When a structure is published, every atom in the picture looks equally certain.
              It isn’t. The experiment measures electron density; a person decides where the atoms go.
              This shows you, atom by atom, <b>which parts of a molecule the measurement actually saw</b> — and which were filled in.
            </p>
          </div>
          <form className="search" onSubmit={submit}>
            <label htmlFor="pdbid">Target or entry</label>
            <input
              id="pdbid"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSearchError(null); }}
              placeholder="EGFR, P00918, or 1cbs"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" disabled={searching}>{searching ? '…' : 'Open'}</button>
          </form>
        </div>
      </header>

      <Gate result={gate} onRerun={rerun} />

      {gate && !gate.ok && (
        <p className="withheld">
          The pipeline could not reproduce its reference values, so no density numbers are shown.
          A wrong number here would be worse than none.
        </p>
      )}

      {gate?.ok && (
        <>
          {searchError && <p className="error">{searchError}</p>}

          {route.local && (

            <LocalAnalysis sigma={route.sigma ?? 1.2} onSigma={(s) => navigate({ sigma: s })} />

          )}

          

          {route.compare && (
            <CompareView
              pair={route.compare}
              sigma={route.sigma ?? 1.2}
              showDiff={route.diff ?? true}
              onSigma={(s) => navigate({ sigma: s })}
              onDiff={(d) => navigate({ diff: d })}
              onBack={() => window.history.back()}
            />
          )}

          {route.target && (
            <TargetPanel
              key={route.target}
              accession={route.target}
              onOpenLigand={(entry, comp) => navigate({ target: null, entry: entry.toLowerCase(), comp, asymId: null })}
              onCompare={(compare) => navigate({ target: null, compare })}
            />
          )}

          {entryLoading && <p className="muted">Loading {route.entry?.toUpperCase()}…</p>}
          {entryError && <p className="error">{entryError}</p>}

          {entry && (
            <>
              <LigandChooser
                entry={entry}
                selected={selected}
                onPick={(l) => navigate({ comp: l.compId, asymId: l.asymId })}
              />
              {!densityAvailable ? (
                <p className="withheld">
                  {entry.entryId} was solved by {entry.method}. This tool reads X-ray electron-density
                  maps; the equivalent confidence measure for cryo-EM is a different quantity, and
                  pretending otherwise would be worse than saying so.
                </p>
              ) : !selected && route.comp ? (
                <p className="withheld">
                  {entry.entryId} has no non-polymer ligand called {route.comp}.
                  {entry.ligands.length > 0
                    ? ' Pick one of the ligands above.'
                    : ' A ligand bound covalently to the protein is modelled as part of the polymer, not as a separate entity, so it does not appear here.'}
                </p>
              ) : selected ? (
                <LigandPanel
                  key={`${entry.entryId}/${selected.compId}/${selected.asymId}`}
                  entryId={entry.entryId}
                  ligand={selected}
                  resolution={entry.resolution}
                  sigma={route.sigma ?? 1.2}
                  showDiff={route.diff ?? true}
                  onSigma={(s) => navigate({ sigma: s })}
                  onDiff={(d) => navigate({ diff: d })}
                />
              ) : null}
            </>
          )}

          {!entry && !entryLoading && !route.target && !route.compare && !route.local && (
            <Landing
              onTarget={(accession) => navigate({ target: accession })}
              onLigand={(e, comp, asym) => navigate({ entry: e, comp, asymId: asym, target: null })}
            />
          )}
        </>
      )}

      <footer className="colophon">
        <p>
          <b>How to read this.</b> Blue cloud: measured 2Fo−Fc density, one point per grid sample above the
          contour. Green/red: Fo−Fc difference density at ±3σ — <i>red means an atom is modelled where the
          experiment saw nothing</i>. Hollow spheres are atoms below 1σ. 2Fo−Fc contains the ligand it is
          judging, so it is partly circular; the difference map is the less biased signal and is why it is on
          by default.
        </p>
        <p className="prior">
          Per-atom density validation is not new: see <a href="https://proteins.plus" target="_blank" rel="noopener">EDIA</a> (Meyder et al., <i>JCIM</i> 2017),
          Twilight (Weichenberger &amp; Pozharski), PDB-REDO, and RCSB’s own published ligand-quality scores.
          Cross-entry comparisons here use those published RSCC values, not our sigma, which is not comparable between structures.
          Data from RCSB PDB (CC0 1.0) and PDBe, fetched in the browser. Decoder verified byte-identical to Mol*.
          {' '}<a href="https://github.com/bpachter/density-check" target="_blank" rel="noopener">Source</a>.
        </p>
      </footer>
    </div>
  );
}






