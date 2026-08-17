import { useEffect, useMemo, useState } from 'react';
import { CoverageMap } from './CoverageMap';
import { fetchTarget, loadMeta, type TargetResult, type TargetLigand, type IndexMeta } from '../lib/targetIndex';

interface Props {
  accession: string;
  onOpenLigand: (entry: string, comp: string) => void;
}

type Filter = 'real' | 'all';

function percentileClass(p: number | null): string {
  if (p === null) return '';
  if (p <= 5) return ' is-bad';
  if (p <= 25) return ' is-warn';
  return '';
}

function Row({ lig, onOpen }: { lig: TargetLigand; onOpen: () => void }) {
  return (
    <button type="button" className="trow" onClick={onOpen}>
      <span className="trow-entry">{lig.entry}</span>
      <span className="trow-comp">
        {lig.comp}
        {lig.isSubject && <i className="trow-star" title="the ligand this structure is about">★</i>}
      </span>
      <span className="trow-name" title={lig.compName ?? ''}>{lig.compName ?? ''}</span>
      <span className="trow-res">{lig.resolution !== null ? `${lig.resolution.toFixed(2)} Å` : '—'}</span>
      <span className="trow-rscc">{lig.rscc !== null ? lig.rscc.toFixed(3) : '—'}</span>
      <span className={`trow-pct${percentileClass(lig.percentile)}`}>
        {lig.percentile !== null ? `p${lig.percentile.toFixed(1)}` : '—'}
      </span>
      {lig.targets > 1 && <span className="trow-multi" title={`also contacts ${lig.targets - 1} other protein${lig.targets > 2 ? 's' : ''}`}>+{lig.targets - 1}</span>}
    </button>
  );
}

export function TargetPanel({ accession, onOpenLigand }: Props) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'missing' | 'error'; data?: TargetResult; error?: string }>({ status: 'loading' });
  const [meta, setMeta] = useState<IndexMeta | null>(null);
  const [filter, setFilter] = useState<Filter>('real');
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let live = true;
    const t0 = performance.now();
    setState({ status: 'loading' });
    loadMeta().then((m) => { if (live) setMeta(m); }).catch(() => undefined);
    fetchTarget(accession)
      .then((data) => {
        if (!live) return;
        setElapsed(performance.now() - t0);
        setState(data ? { status: 'ready', data } : { status: 'missing' });
      })
      .catch((e) => { if (live) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [accession]);

  const visible = useMemo(() => {
    if (!state.data) return [];
    return filter === 'real'
      ? state.data.ligands.filter((l) => !l.isAdditive && l.percentile !== null)
      : state.data.ligands;
  }, [state.data, filter]);

  if (state.status === 'loading') return <section className="panel"><p className="muted">Looking up {accession}…</p></section>;
  if (state.status === 'error') return <section className="panel"><p className="error">{state.error}</p></section>;
  if (state.status === 'missing' || !state.data) {
    return (
      <section className="panel">
        <p className="withheld">
          No ligand in the archive contacts <b>{accession}</b>. Either nothing has been solved bound to it,
          or its ligands are ions in chains with no UniProt mapping — those stay reachable through the
          per-entry view.
        </p>
      </section>
    );
  }

  const d = state.data;
  const worst = visible[0];

  return (
    <section className="panel panel--target">
      <header className="panel-head">
        <div>
          <h2>{d.gene || d.accession} <span className="asym">{d.accession}</span></h2>
          <p className="caption">{d.protein}{d.organism ? ` · ${d.organism}` : ''}</p>
        </div>
        <span className="target-count">
          {d.ligands.length.toLocaleString()} ligand instance{d.ligands.length === 1 ? '' : 's'}
          <i>{elapsed ? `${elapsed.toFixed(0)} ms` : ''}</i>
        </span>
      </header>

      {worst && (
        <p className="target-lead">
          Worst-supported here: <b>{worst.entry} · {worst.comp}</b>
          {worst.rscc !== null && <> at RSCC {worst.rscc.toFixed(3)}</>}
          {worst.percentile !== null && <> — <b>{worst.percentile.toFixed(1)}th percentile</b> among ligands solved at comparable resolution</>}.
        </p>
      )}

      <CoverageMap accession={d.accession} ligands={d.ligands} />

      <div className="target-controls">
        <div className="seg">
          <button type="button" className={filter === 'real' ? 'on' : ''} onClick={() => setFilter('real')}>
            Scored ligands
          </button>
          <button type="button" className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
            Everything ({d.ligands.length.toLocaleString()})
          </button>
        </div>
        <span className="muted target-note">
          {d.additiveCount.toLocaleString()} ions / buffers and {d.unscoredCount.toLocaleString()} without a
          published fit metric are hidden by default. Unscored is not the same as poor.
        </span>
      </div>

      <div className="thead">
        <span>Entry</span><span>Ligand</span><span>Name</span><span>Res.</span><span>RSCC</span><span>Percentile</span><span />
      </div>
      <div className="tbody">
        {visible.slice(0, 300).map((lig) => (
          <Row
            key={`${lig.entry}/${lig.comp}/${lig.chain}${lig.seq}`}
            lig={lig}
            onOpen={() => onOpenLigand(lig.entry, lig.comp)}
          />
        ))}
      </div>
      {visible.length > 300 && (
        <p className="footnote">Showing the worst 300 of {visible.length.toLocaleString()}.</p>
      )}

      <p className="footnote">
        Ranked by where each ligand's RSCC falls within the distribution for its own resolution shell —
        raw RSCC is resolution-dependent, so sorting on it directly ranks by resolution instead of by fit.
        The reference population is {meta ? meta.reference.perShell.reduce((a, b) => a + b, 0).toLocaleString() : '—'} X-ray
        ligands flagged by RCSB as the subject of their structure; referencing against everything would let
        magnesium ions define a normal fit. Index built {meta?.built ?? '—'} from {meta ? meta.counts.entries.toLocaleString() : '—'} entries.
      </p>
    </section>
  );
}
