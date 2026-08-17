import { useEffect, useMemo, useState } from 'react';
import { DensityCanvas } from './DensityCanvas';
import { Depiction2D } from './Depiction2D';
import { fetchLigand, fetchSurroundings, fetchDensity } from '../lib/rcsb';
import { fetchContacts, contactTone, type Contact } from '../lib/contacts';
import { buildReference, computeEvidence, verdict, type LigandEvidence } from '../lib/evidence';
import type { LigandInstance } from '../lib/entry';
import type { DensityGrid } from '../lib/volume';

interface Props {
  entryId: string;
  ligand: LigandInstance;
  resolution: number | null;
  sigma: number;
  showDiff: boolean;
  onSigma: (s: number) => void;
  onDiff: (d: boolean) => void;
}

interface Loaded {
  evidence: LigandEvidence;
  map2FoFc: DensityGrid;
  mapFoFc: DensityGrid;
  bytes: number;
  contacts: Contact[];
  compName: string;
}

export function LigandPanel({ entryId, ligand, resolution, sigma, showDiff, onSigma, onDiff }: Props) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; data?: Loaded; error?: string }>({ status: 'loading' });
  const [hovered, setHovered] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });

    (async () => {
      const coords = await fetchLigand(entryId, ligand.compId, ligand.asymId);
      const [surroundings, maps] = await Promise.all([
        fetchSurroundings(entryId, ligand.compId),
        fetchDensity(entryId, coords.atoms),
      ]);
      const meanB = coords.atoms.reduce((s, a) => s + a.b, 0) / coords.atoms.length;
      const reference = buildReference(surroundings, maps.map2FoFc, meanB);
      const evidence = computeEvidence(entryId, ligand.compId, coords.atoms, maps.map2FoFc, maps.mapFoFc, reference);
      // Contacts are decoration relative to the density claim: if PDBe is down,
      // the panel still answers its question.
      const contacts = await fetchContacts(entryId, ligand.compId, coords.authAsymId, surroundings, coords.atoms)
        .catch(() => [] as Contact[]);
      return { evidence, map2FoFc: maps.map2FoFc, mapFoFc: maps.mapFoFc, bytes: maps.bytes, contacts, compName: coords.compName };
    })()
      .then((data) => { if (live) setState({ status: 'ready', data }); })
      .catch((e) => { if (live) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) }); });

    return () => { live = false; };
  }, [entryId, ligand.compId, ligand.asymId]);

  const permalink = useMemo(() => `${window.location.origin}${window.location.pathname}${window.location.hash}`, [
    entryId, ligand.compId, ligand.asymId, sigma, showDiff,
  ]);

  if (state.status === 'loading') {
    return <section className="panel"><p className="muted">Fetching coordinates and density for {ligand.compId}…</p></section>;
  }
  if (state.status === 'error' || !state.data) {
    return (
      <section className="panel">
        <p className="error">{state.error}</p>
        <p className="muted">
          Density is only available for X-ray entries with deposited structure factors. If this entry has
          none, there is nothing to check against.
        </p>
      </section>
    );
  }

  const d = state.data;
  const v = verdict(d.evidence);
  const weakCount = d.evidence.atoms.filter((a) => a.sigma2FoFc < 1).length;
  const drawn = d.contacts.filter((c) => c.from && c.to && !c.isWater);

  return (
    <section className="panel panel--single">
      <header className="panel-head">
        <div>
          <h2>{entryId} · {ligand.compId} <span className="asym">copy {ligand.asymId}</span></h2>
          <p className="caption">{d.compName}</p>
        </div>
        <span className={`verdict verdict--${v.tone}`}>{v.label}</span>
      </header>

      <div className="stats">
        <div><span className="k">Mean density at atoms</span><span className="v">{d.evidence.meanSigma.toFixed(2)}σ</span></div>
        <div><span className="k">Atoms below 1σ</span><span className="v">{weakCount} / {d.evidence.atoms.length}</span></div>
        <div><span className="k">Published RSCC</span><span className="v">{ligand.rscc !== null ? ligand.rscc.toFixed(3) : '—'}</span></div>
        <div><span className="k">Resolution</span><span className="v">{resolution !== null ? `${resolution.toFixed(2)} Å` : '—'}</span></div>
      </div>

      <div className="split">
        <div className="split-3d">
          <DensityCanvas
            map2FoFc={d.map2FoFc}
            mapFoFc={d.mapFoFc}
            atoms={d.evidence.atoms}
            sigmaLevel={sigma}
            showDifference={showDiff}
            contacts={drawn}
            highlight={hovered}
          />
          <div className="controls">
            <label>
              2Fo−Fc contour
              <input
                type="range" min={0.4} max={3} step={0.1} value={sigma}
                onChange={(e) => onSigma(Number(e.target.value))}
              />
              <b>{sigma.toFixed(1)}σ</b>
            </label>
            <label className="check">
              <input type="checkbox" checked={showDiff} onChange={(e) => onDiff(e.target.checked)} />
              Fo−Fc at ±3σ
            </label>
            <button
              type="button"
              className="linkbtn"
              onClick={() => {
                navigator.clipboard?.writeText(permalink).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }).catch(() => undefined);
              }}
            >
              {copied ? 'link copied' : 'copy link'}
            </button>
          </div>
        </div>

        <div className="split-data">
          <Depiction2D
            compId={ligand.compId}
            atoms={d.evidence.atoms}
            highlight={hovered}
          />

          <h3 className="section-title">Per-atom evidence</h3>
          <div className="bars">
            {[...d.evidence.atoms].sort((a, b) => a.sigma2FoFc - b.sigma2FoFc).map((a) => {
              const max = Math.max(4, ...d.evidence.atoms.map((x) => (Number.isFinite(x.sigma2FoFc) ? x.sigma2FoFc : 0)));
              const weak = a.sigma2FoFc < 1;
              const refuted = a.sigmaFoFc < -3;
              return (
                <div
                  className={`bar-row${hovered === a.name ? ' is-hover' : ''}`}
                  key={a.name}
                  onMouseEnter={() => setHovered(a.name)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <span className="bar-name">{a.name}<i>{a.element}</i></span>
                  <span className="bar-track">
                    <span
                      className={`bar-fill${weak ? ' is-weak' : ''}${refuted ? ' is-refuted' : ''}`}
                      style={{ width: `${Math.max(0, Math.min(100, (a.sigma2FoFc / max) * 100))}%` }}
                    />
                    <span className="bar-onesigma" style={{ left: `${(1 / max) * 100}%` }} aria-hidden="true" />
                  </span>
                  <span className="bar-value">{a.sigma2FoFc.toFixed(2)}σ</span>
                  <span className={`bar-diff${a.sigmaFoFc < -1.5 ? ' is-negative' : ''}`}>
                    {a.sigmaFoFc >= 0 ? '+' : ''}{a.sigmaFoFc.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>

          <h3 className="section-title">
            Contacts
            <span className="section-note">{d.contacts.length ? `${d.contacts.length} from PDBe` : 'none reported'}</span>
          </h3>
          {d.contacts.length > 0 ? (
            <>
              <div className="contacts">
                {d.contacts.slice(0, 14).map((c) => (
                  <div className={`contact contact--${contactTone(c.types)}`} key={`${c.chain}${c.seq}${c.residue}`}>
                    <span className="contact-res">
                      {c.residue}<i>{c.chain}{c.seq}</i>
                    </span>
                    <span className="contact-types">{c.types.join(' · ')}</span>
                    <span className="contact-dist">{c.distance !== null ? `${c.distance.toFixed(2)} Å` : '—'}</span>
                  </div>
                ))}
              </div>
              <p className="footnote">
                PDBe reports these at residue level (it returns no atom names here), so the distance shown is
                the closest approach between the ligand and that residue — not the specific atom pair Arpeggio
                paired.
              </p>
            </>
          ) : (
            <p className="footnote">No interaction data published for this bound molecule.</p>
          )}

          <p className="footnote">
            {d.evidence.reference
              ? `Within-map reference: ${d.evidence.reference.n} ordered protein atoms at comparable B-factor.`
              : 'No comparable reference population in this map — z-scores withheld rather than guessed.'}
            {' '}Density payload {(d.bytes / 1024).toFixed(0)} KB, fetched directly from RCSB.
          </p>
        </div>
      </div>
    </section>
  );
}
