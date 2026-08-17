import { useCallback, useEffect, useState } from 'react';
import { depictLigand, type Depiction } from '../lib/depiction';
import type { AtomEvidence } from '../lib/evidence';

interface Props {
  compId: string;
  atoms: AtomEvidence[];
  highlight: string | null;
}

/**
 * The chemist's view of the same evidence: the flat structure everyone reads,
 * with each atom coloured by how much density stands behind it.
 *
 * The chemistry engine is 6.6 MB of WebAssembly, so nothing is loaded until the
 * user asks for it. Once loaded it stays for the session.
 */
export function Depiction2D({ compId, atoms, highlight }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; data?: Depiction; error?: string }>({ status: 'idle' });

  const render = useCallback(async (hl: string | null) => {
    try {
      const data = await depictLigand(compId, atoms, { width: 420, height: 260, highlight: hl });
      setState({ status: 'ready', data });
    } catch (e) {
      setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }, [compId, atoms]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    render(highlight).then(() => { if (!live) return; });
    return () => { live = false; };
  }, [enabled, render, highlight]);

  if (!enabled) {
    return (
      <div className="depict depict--off">
        <button type="button" className="depict-cta" onClick={() => setEnabled(true)}>
          Draw the 2D structure
        </button>
        <span className="depict-note">loads a 6.6 MB chemistry engine, once</span>
      </div>
    );
  }

  return (
    <div className="depict">
      <h3 className="section-title">
        Structure
        <span className="section-note">coloured by measured support</span>
      </h3>
      {state.status === 'loading' && <p className="muted">Building the depiction…</p>}
      {state.status === 'error' && (
        <p className="footnote">
          {state.error}. The 3D view and the per-atom numbers are unaffected — this panel is the only
          part that needs the chemical component definition.
        </p>
      )}
      {state.status === 'ready' && state.data && (
        <>
          <div className="depict-svg" dangerouslySetInnerHTML={{ __html: state.data.svg }} />
          <p className="footnote">
            <span className="swatch swatch--good" /> above 2σ
            <span className="swatch swatch--mid" /> 1–2σ
            <span className="swatch swatch--weak" /> below 1σ
            <span className="swatch swatch--bad" /> negative difference density
            {state.data.bondedAtoms < state.data.totalAtoms && (
              <> · {state.data.totalAtoms - state.data.bondedAtoms} atom(s) had no bond in the component
                definition and are drawn unconnected</>
            )}
          </p>
        </>
      )}
    </div>
  );
}
