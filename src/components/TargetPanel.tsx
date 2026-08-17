import { useEffect, useMemo, useState } from 'react';
import { CoverageMap } from './CoverageMap';
import { fetchTarget, loadMeta, type TargetResult, type TargetLigand, type IndexMeta } from '../lib/targetIndex';

interface Props {
  accession: string;
  onOpenLigand: (entry: string, comp: string) => void;
  onCompare?: (pair: Array<{ entry: string; comp: string; asymId: string }>) => void;
}

type Filter = 'real' | 'all';
type SortKey = 'evidence' | 'rscc' | 'resolution' | 'year' | 'size' | 'entry';

const SORTS: Array<{ key: SortKey; label: string; hint: string }> = [
  { key: 'evidence', label: 'Evidence', hint: 'worst-supported first, size- and resolution-aware' },
  { key: 'rscc', label: 'RSCC', hint: 'raw published score, lowest first — not comparable across resolutions' },
  { key: 'resolution', label: 'Resolution', hint: 'sharpest structures first' },
  { key: 'size', label: 'Ligand size', hint: 'largest first' },
  { key: 'year', label: 'Year', hint: 'newest first' },
  { key: 'entry', label: 'Entry', hint: 'alphabetical' },
];

function percentileClass(p: number | null): string {
  if (p === null) return '';
  if (p <= 5) return ' is-bad';
  if (p <= 25) return ' is-warn';
  return '';
}

function Row({
  lig, onOpen, pinned, onPin,
}: { lig: TargetLigand; onOpen: () => void; pinned: boolean; onPin: () => void }) {
  return (
    <div className={`trow-wrap${pinned ? ' is-pinned' : ''}`}>
      <button
        type="button"
        className="trow-pin"
        aria-pressed={pinned}
        title={pinned ? 'remove from comparison' : 'pin to compare'}
        onClick={(e) => { e.stopPropagation(); onPin(); }}
      >
        {pinned ? '◆' : '◇'}
      </button>
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
    </div>
  );
}

export function TargetPanel({ accession, onOpenLigand, onCompare }: Props) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'missing' | 'error'; data?: TargetResult; error?: string }>({ status: 'loading' });
  const [meta, setMeta] = useState<IndexMeta | null>(null);
  const [filter, setFilter] = useState<Filter>('real');
  const [sort, setSort] = useState<SortKey>('evidence');
  const [subjectOnly, setSubjectOnly] = useState(false);
  const [minYear, setMinYear] = useState<number | null>(null);
  const [maxResolution, setMaxResolution] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [pinned, setPinned] = useState<Array<{ key: string; lig: TargetLigand }>>([]);
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
    let rows = filter === 'real'
      ? state.data.ligands.filter((l) => !l.isAdditive && l.percentile !== null)
      : state.data.ligands;

    if (subjectOnly) rows = rows.filter((l) => l.isSubject);
    if (minYear) rows = rows.filter((l) => l.year !== null && l.year >= minYear);
    if (maxResolution) rows = rows.filter((l) => l.resolution !== null && l.resolution <= maxResolution);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      rows = rows.filter((l) =>
        l.comp.toLowerCase().includes(q)
        || l.entry.toLowerCase().includes(q)
        || (l.compName ?? '').toLowerCase().includes(q));
    }

    // The default order is the argument of the tool, so it stays the default;
    // the others exist because "show me the newest" and "show me the sharpest"
    // are real questions and sorting them by hand is not a feature.
    const sorted = [...rows];
    const nullsLast = (v: number | null) => (v === null ? Infinity : v);
    switch (sort) {
      case 'rscc': sorted.sort((a, b) => nullsLast(a.rscc) - nullsLast(b.rscc)); break;
      case 'resolution': sorted.sort((a, b) => nullsLast(a.resolution) - nullsLast(b.resolution)); break;
      case 'size': sorted.sort((a, b) => (b.natoms ?? -1) - (a.natoms ?? -1)); break;
      case 'year': sorted.sort((a, b) => (b.year ?? 0) - (a.year ?? 0)); break;
      case 'entry': sorted.sort((a, b) => a.entry.localeCompare(b.entry) || a.comp.localeCompare(b.comp)); break;
      default: break;   // already worst-evidence-first from the index
    }
    return sorted;
  }, [state.data, filter, sort, subjectOnly, minYear, maxResolution, query]);

  const togglePin = (lig: TargetLigand) => {
    const key = `${lig.entry}/${lig.comp}/${lig.chain}${lig.seq}`;
    setPinned((prev) => {
      if (prev.some((p) => p.key === key)) return prev.filter((p) => p.key !== key);
      // Two is the comparison; a third would just be a list again.
      const next = [...prev, { key, lig }];
      return next.slice(-2);
    });
  };

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

      <div className="tfilters">
        <label className="tf">
          <span>Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <label className="tf">
          <span>Resolution</span>
          <select value={maxResolution ?? ''} onChange={(e) => setMaxResolution(e.target.value ? Number(e.target.value) : null)}>
            <option value="">any</option>
            <option value="1.5">≤ 1.5 Å</option>
            <option value="2">≤ 2.0 Å</option>
            <option value="2.5">≤ 2.5 Å</option>
            <option value="3">≤ 3.0 Å</option>
          </select>
        </label>
        <label className="tf">
          <span>Since</span>
          <select value={minYear ?? ''} onChange={(e) => setMinYear(e.target.value ? Number(e.target.value) : null)}>
            <option value="">any year</option>
            <option value="2020">2020</option>
            <option value="2015">2015</option>
            <option value="2010">2010</option>
            <option value="2000">2000</option>
          </select>
        </label>
        <label className="tf tf--check">
          <input type="checkbox" checked={subjectOnly} onChange={(e) => setSubjectOnly(e.target.checked)} />
          <span>Only the paper’s own ligand</span>
        </label>
        <label className="tf tf--search">
          <input
            type="search"
            value={query}
            placeholder="filter by ligand or entry"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="tf-count">{visible.length.toLocaleString()} shown</span>
      </div>

      {pinned.length > 0 && (
        <div className="compare-bar">
          <span className="compare-label">Comparing</span>
          {pinned.map((p) => (
            <button key={p.key} type="button" className="compare-chip" onClick={() => togglePin(p.lig)} title="remove">
              {p.lig.entry} · {p.lig.comp}
              {p.lig.percentile !== null && <b>p{p.lig.percentile.toFixed(1)}</b>}
              <i>×</i>
            </button>
          ))}
          {pinned.length === 1 && <span className="muted">pin one more…</span>}
          {pinned.length === 2 && onCompare && (
            <button
              type="button"
              className="compare-go"
              onClick={() => onCompare(pinned.map((p) => ({
                entry: p.lig.entry.toLowerCase(), comp: p.lig.comp, asymId: p.lig.chain,
              })))}
            >
              Open side by side →
            </button>
          )}
        </div>
      )}

      <div className="thead">
        <span>Entry</span><span>Ligand</span><span>Name</span><span>Res.</span><span>RSCC</span><span>Percentile</span><span />
      </div>
      <div className="tbody">
        {visible.slice(0, 300).map((lig, i) => {
          const key = `${lig.entry}/${lig.comp}/${lig.chain}${lig.seq}`;
          return (
            <Row
              key={`${key}#${i}`}
              lig={lig}
              pinned={pinned.some((p) => p.key === key)}
              onPin={() => togglePin(lig)}
              onOpen={() => onOpenLigand(lig.entry, lig.comp)}
            />
          );
        })}
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

