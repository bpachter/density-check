import { useCallback, useEffect, useMemo, useState } from 'react';
import { DensityCanvas } from './components/DensityCanvas';
import { fetchLigand, fetchSurroundings, fetchDensity, fetchValidation, fetchResolution } from './lib/rcsb';
import { buildReference, computeEvidence, verdict, type LigandEvidence } from './lib/evidence';
import { runValidationGate, type GateResult } from './lib/gate';
import type { DensityGrid } from './lib/volume';

interface Loaded {
  evidence: LigandEvidence;
  map2FoFc: DensityGrid;
  mapFoFc: DensityGrid;
  bytes: number;
  rscc: number | null;
  resolution: number | null;
  compName: string;
}

const CASES = [
  { entry: '1cbs', comp: 'REA', caption: 'Retinoic acid in cellular retinoic-acid-binding protein II' },
  { entry: '13fl', comp: 'NAG', caption: 'N-acetylglucosamine in a fucose-specific lectin' },
];

async function load(entry: string, comp: string): Promise<Loaded> {
  const ligand = await fetchLigand(entry, comp);
  const [surroundings, maps, validation, resolution] = await Promise.all([
    fetchSurroundings(entry, comp),
    fetchDensity(entry, ligand.atoms),
    fetchValidation(entry, ligand.asymId),
    fetchResolution(entry),
  ]);
  const meanB = ligand.atoms.reduce((s, a) => s + a.b, 0) / ligand.atoms.length;
  const reference = buildReference(surroundings, maps.map2FoFc, meanB);
  return {
    evidence: computeEvidence(entry, comp, ligand.atoms, maps.map2FoFc, maps.mapFoFc, reference),
    map2FoFc: maps.map2FoFc,
    mapFoFc: maps.mapFoFc,
    bytes: maps.bytes,
    rscc: validation.rscc,
    resolution,
    compName: ligand.compName,
  };
}

function AtomBars({ evidence }: { evidence: LigandEvidence }) {
  const max = Math.max(4, ...evidence.atoms.map((a) => (Number.isFinite(a.sigma2FoFc) ? a.sigma2FoFc : 0)));
  const sorted = [...evidence.atoms].sort((a, b) => a.sigma2FoFc - b.sigma2FoFc);

  return (
    <div className="bars" role="table" aria-label="Per-atom density support">
      {sorted.map((a) => {
        const weak = a.sigma2FoFc < 1;
        const refuted = a.sigmaFoFc < -3;
        const pct = Math.max(0, Math.min(100, (a.sigma2FoFc / max) * 100));
        return (
          <div className="bar-row" key={a.name} role="row">
            <span className="bar-name" role="cell">{a.name}<i>{a.element}</i></span>
            <span className="bar-track" role="cell">
              <span
                className={`bar-fill${weak ? ' is-weak' : ''}${refuted ? ' is-refuted' : ''}`}
                style={{ width: `${pct}%` }}
              />
              <span className="bar-onesigma" style={{ left: `${(1 / max) * 100}%` }} aria-hidden="true" />
            </span>
            <span className="bar-value" role="cell">{a.sigma2FoFc.toFixed(2)}σ</span>
            <span className={`bar-diff${a.sigmaFoFc < -1.5 ? ' is-negative' : ''}`} role="cell">
              {a.sigmaFoFc >= 0 ? '+' : ''}{a.sigmaFoFc.toFixed(2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Panel({ entry, comp, caption }: { entry: string; comp: string; caption: string }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; data?: Loaded; error?: string }>({ status: 'loading' });
  const [sigmaLevel, setSigmaLevel] = useState(1.2);
  const [showDiff, setShowDiff] = useState(true);

  useEffect(() => {
    let live = true;
    load(entry, comp)
      .then((data) => { if (live) setState({ status: 'ready', data }); })
      .catch((e) => { if (live) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [entry, comp]);

  if (state.status === 'loading') {
    return <section className="panel"><h2>{entry.toUpperCase()} · {comp}</h2><p className="muted">Fetching coordinates and density…</p></section>;
  }
  if (state.status === 'error' || !state.data) {
    return <section className="panel"><h2>{entry.toUpperCase()} · {comp}</h2><p className="error">{state.error}</p></section>;
  }

  const d = state.data;
  const v = verdict(d.evidence);
  const weakCount = d.evidence.atoms.filter((a) => a.sigma2FoFc < 1).length;

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>{entry.toUpperCase()} · {comp}</h2>
          <p className="caption">{caption}</p>
        </div>
        <span className={`verdict verdict--${v.tone}`}>{v.label}</span>
      </header>

      <div className="stats">
        <div><span className="k">Mean density at atoms</span><span className="v">{d.evidence.meanSigma.toFixed(2)}σ</span></div>
        <div><span className="k">Atoms below 1σ</span><span className="v">{weakCount} / {d.evidence.atoms.length}</span></div>
        <div><span className="k">Published RSCC</span><span className="v">{d.rscc !== null ? d.rscc.toFixed(3) : '—'}</span></div>
        <div><span className="k">Resolution</span><span className="v">{d.resolution !== null ? `${d.resolution.toFixed(2)} Å` : '—'}</span></div>
      </div>

      <DensityCanvas
        map2FoFc={d.map2FoFc}
        mapFoFc={d.mapFoFc}
        atoms={d.evidence.atoms}
        sigmaLevel={sigmaLevel}
        showDifference={showDiff}
      />

      <div className="controls">
        <label>
          2Fo−Fc contour
          <input
            type="range" min={0.4} max={3} step={0.1} value={sigmaLevel}
            onChange={(e) => setSigmaLevel(Number(e.target.value))}
          />
          <b>{sigmaLevel.toFixed(1)}σ</b>
        </label>
        <label className="check">
          <input type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} />
          Fo−Fc difference at ±3σ
        </label>
      </div>

      <AtomBars evidence={d.evidence} />

      <p className="footnote">
        {d.evidence.reference
          ? `Within-map reference: ${d.evidence.reference.n} ordered protein atoms at comparable B-factor.`
          : 'No comparable reference population in this map — z-scores withheld rather than guessed.'}
        {' '}Density payload {(d.bytes / 1024).toFixed(0)} KB, fetched directly from RCSB.
      </p>
    </section>
  );
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

export default function App() {
  const [gate, setGate] = useState<GateResult | null>(null);

  const rerun = useCallback(() => {
    setGate(null);
    runValidationGate().then(setGate);
  }, []);

  useEffect(() => { rerun(); }, [rerun]);

  const showPanels = useMemo(() => gate?.ok === true, [gate]);

  return (
    <div className="app">
      <header className="masthead">
        <h1>Density Check</h1>
        <p className="lede">
          When a structure is published, every atom in the picture looks equally certain.
          It isn’t. The experiment measures electron density; a person decides where the atoms go.
          This shows you, atom by atom, <b>which parts of a molecule the measurement actually saw</b>
          {' '}— and which were filled in.
        </p>
      </header>

      <Gate result={gate} onRerun={rerun} />

      {showPanels ? (
        <main className="panels">
          {CASES.map((c) => <Panel key={`${c.entry}/${c.comp}`} {...c} />)}
        </main>
      ) : (
        gate && !gate.ok && (
          <p className="withheld">
            The pipeline could not reproduce its reference values, so no density numbers are shown.
            A wrong number here would be worse than none.
          </p>
        )
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
          Twilight (Weichenberger &amp; Pozharski), and RCSB’s own published ligand-quality scores.
          Cross-entry comparisons here use those published RSCC values, not our sigma, which is not comparable between structures.
          Data from RCSB PDB (CC0 1.0), fetched in the browser. Decoder verified byte-identical to Mol*.
        </p>
      </footer>
    </div>
  );
}
