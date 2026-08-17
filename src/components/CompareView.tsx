import { useEffect, useState } from 'react';
import { LigandPanel } from './LigandPanel';
import { fetchEntry, type LigandInstance } from '../lib/entry';

export interface CompareTarget {
  entry: string;
  comp: string;
  /** Author chain from the index. The model server keys on the LABEL asym id,
   *  so this is resolved through the entry rather than used directly. */
  asymId: string;
}

interface Props {
  pair: CompareTarget[];
  sigma: number;
  showDiff: boolean;
  onSigma: (s: number) => void;
  onDiff: (d: boolean) => void;
  onBack: () => void;
}

interface Resolved {
  entryId: string;
  ligand: LigandInstance;
  resolution: number | null;
}

function useResolved(t: CompareTarget | undefined) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; data?: Resolved; error?: string }>({ status: 'loading' });
  useEffect(() => {
    if (!t) return;
    let live = true;
    setState({ status: 'loading' });
    fetchEntry(t.entry)
      .then((e) => {
        if (!live) return;
        // Prefer the exact copy the table pointed at; fall back to any copy of
        // the same chemical component rather than failing.
        const ligand = e.ligands.find((l) => l.compId === t.comp && l.authAsymId === t.asymId)
          ?? e.ligands.find((l) => l.compId === t.comp);
        if (!ligand) { setState({ status: 'error', error: `${e.entryId} has no ligand ${t.comp}` }); return; }
        setState({ status: 'ready', data: { entryId: e.entryId, ligand, resolution: e.resolution } });
      })
      .catch((err) => { if (live) setState({ status: 'error', error: err instanceof Error ? err.message : String(err) }); });
    return () => { live = false; };
  }, [t?.entry, t?.comp, t?.asymId]);
  return state;
}

export function CompareView({ pair, sigma, showDiff, onSigma, onDiff, onBack }: Props) {
  const left = useResolved(pair[0]);
  const right = useResolved(pair[1]);

  const side = (s: ReturnType<typeof useResolved>, t: CompareTarget) => {
    if (s.status === 'loading') return <section className="panel"><p className="muted">Loading {t.entry.toUpperCase()} · {t.comp}…</p></section>;
    if (s.status === 'error' || !s.data) return <section className="panel"><p className="error">{s.error}</p></section>;
    return (
      <LigandPanel
        entryId={s.data.entryId}
        ligand={s.data.ligand}
        resolution={s.data.resolution}
        sigma={sigma}
        showDiff={showDiff}
        onSigma={onSigma}
        onDiff={onDiff}
      />
    );
  };

  return (
    <div className="compare">
      <div className="compare-head">
        <button type="button" className="linkbtn" onClick={onBack}>← back to the target</button>
        <span className="muted">
          Both panels share one contour level, so the comparison is like for like. Each ligand is still
          judged against its own resolution and size — the percentiles are not comparable as raw numbers
          across different structures, which is the whole reason they are percentiles.
        </span>
      </div>
      <div className="compare-grid">
        {pair[0] && side(left, pair[0])}
        {pair[1] && side(right, pair[1])}
      </div>
    </div>
  );
}
