import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAlphaFold, fetchCoverage, fetchPlddt, plddtBand, PLDDT_COLOUR,
  type AlphaFoldSummary, type Coverage,
} from '../lib/alphafold';
import type { TargetLigand } from '../lib/targetIndex';

interface Props {
  accession: string;
  ligands: TargetLigand[];
}

const H_DEPTH = 46;
const H_PLDDT = 16;
const H_TICKS = 18;
const PAD = 1;

/**
 * Where structural knowledge of a protein actually exists.
 *
 * Top band: how many experimental structures cover each residue. Bottom band:
 * AlphaFold's own per-residue confidence. Deliberately drawn as two separate
 * bands rather than one blended score — a measurement and a prediction are
 * different kinds of claim, and merging them into a single "confidence" would
 * be exactly the dishonesty this tool exists to argue against.
 */
export function CoverageMap({ accession, ligands }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [af, setAf] = useState<AlphaFoldSummary | null | 'none'>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [plddt, setPlddt] = useState<Float32Array | null>(null);
  const [loadingPlddt, setLoadingPlddt] = useState(false);
  const [hover, setHover] = useState<{ residue: number; depth: number; plddt: number | null; x: number } | null>(null);

  useEffect(() => {
    let live = true;
    setAf(null); setCoverage(null); setPlddt(null);
    (async () => {
      const summary = await fetchAlphaFold(accession).catch(() => null);
      if (!live) return;
      setAf(summary ?? 'none');
      const length = summary?.sequenceLength ?? 0;
      const cov = await fetchCoverage(accession, length).catch(() => null);
      if (live) setCoverage(cov);
    })();
    return () => { live = false; };
  }, [accession]);

  // Entries that carry a scored ligand, so the map can show where the
  // liganded structures actually sit on the sequence.
  const ligandEntries = useMemo(() => {
    const s = new Set<string>();
    for (const l of ligands) if (!l.isAdditive && l.percentile !== null) s.add(l.entry.toUpperCase());
    return s;
  }, [ligands]);

  const length = coverage?.length
    ?? (af && af !== 'none' ? (af as AlphaFoldSummary).sequenceLength : 0);

  // "X% covered by at least one structure" is nearly 100% for anything
  // well-studied — one low-resolution cryo-EM model can span the whole chain —
  // so it says nothing. What matters is how UNEVEN the coverage is: the depth
  // at the best-studied residue against how much of the protein is barely
  // looked at. (Must stay above the early returns: hooks cannot be conditional.)
  const stats = useMemo(() => {
    if (!coverage || !length) return null;
    const depths: number[] = [];
    let peak = 0;
    let peakResidue = 0;
    for (let r = 1; r <= length; r++) {
      const d = coverage.depth[r] ?? 0;
      depths.push(d);
      if (d > peak) { peak = d; peakResidue = r; }
    }
    depths.sort((a, b) => a - b);
    return { median: depths[depths.length >> 1] ?? 0, peak, peakResidue };
  }, [coverage, length]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !coverage || !length) return;

    const width = canvas.clientWidth;
    const height = H_DEPTH + H_PLDDT + H_TICKS + 8;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const x = (residue: number) => PAD + ((residue - 1) / Math.max(1, length - 1)) * (width - PAD * 2);
    const maxDepth = Math.max(1, ...coverage.depth);

    // ── experimental coverage depth ──
    ctx.fillStyle = '#0e131b';
    ctx.fillRect(0, 0, width, H_DEPTH);
    for (let r = 1; r <= length; r++) {
      const d = coverage.depth[r] ?? 0;
      if (!d) continue;
      const h = Math.max(1.5, (d / maxDepth) * (H_DEPTH - 4));
      // Colour by best resolution available: sharper structures read brighter.
      const res = coverage.bestResolution[r];
      ctx.fillStyle = res === 0 ? '#4a5a6b'
        : res < 2 ? '#5bc8f5'
        : res < 3 ? '#3f92bd'
        : '#2f6a8a';
      ctx.fillRect(x(r), H_DEPTH - h - 2, Math.max(1, (width - PAD * 2) / length), h);
    }

    // ── AlphaFold per-residue confidence ──
    const yPl = H_DEPTH + 4;
    ctx.fillStyle = '#0e131b';
    ctx.fillRect(0, yPl, width, H_PLDDT);
    if (plddt) {
      for (let r = 1; r <= length; r++) {
        const v = plddt[r] ?? 0;
        if (!v) continue;
        ctx.fillStyle = PLDDT_COLOUR[plddtBand(v)];
        ctx.fillRect(x(r), yPl, Math.max(1, (width - PAD * 2) / length), H_PLDDT);
      }
    } else {
      ctx.fillStyle = '#141b25';
      ctx.fillRect(0, yPl, width, H_PLDDT);
    }

    // ── residue ticks ──
    const yTick = yPl + H_PLDDT + 3;
    ctx.fillStyle = '#8b98a9';
    ctx.font = '10px ui-monospace, monospace';
    const step = length > 1500 ? 500 : length > 600 ? 200 : length > 200 ? 100 : 50;
    for (let r = step; r < length; r += step) {
      ctx.fillRect(x(r), yTick, 1, 4);
      ctx.fillText(String(r), x(r) + 3, yTick + 11);
    }
    ctx.fillRect(x(1), yTick, 1, 4);
    ctx.fillText('1', x(1) + 3, yTick + 11);
  }, [coverage, plddt, length]);

  if (af === null) return <div className="cov cov--loading"><span className="muted">Checking for a predicted model…</span></div>;

  if (af === 'none') {
    return (
      <div className="cov">
        <p className="footnote">No AlphaFold model for {accession}, so coverage is not drawn.</p>
      </div>
    );
  }

  const summary = af as AlphaFoldSummary;
  const pctCovered = coverage
    ? ([...coverage.depth].filter((d) => d > 0).length / Math.max(1, length)) * 100
    : 0;

  return (
    <div className="cov">
      <h3 className="section-title">
        What is actually known about this protein
        <span className="section-note">{summary.sequenceLength.toLocaleString()} residues</span>
      </h3>

      <p className="cov-lead">
        {coverage && stats ? (
          <>
            {coverage.spans.length.toLocaleString()} experimental structures cover this protein
            {coverage.xrayCount ? ` (${coverage.xrayCount.toLocaleString()} by X-ray)` : ''}, but not evenly:
            residue <b>{stats.peakResidue}</b> has been solved <b>{stats.peak.toLocaleString()}</b> times over,
            while the median residue appears in <b>{stats.median.toLocaleString()}</b>.
            {stats.peak > stats.median * 8 && ' Attention is concentrated in a small part of the sequence; everywhere else, the prediction is effectively what is known.'}
          </>
        ) : 'Loading experimental coverage…'}
      </p>

      <canvas
        ref={canvasRef}
        className="cov-canvas"
        role="img"
        aria-label={`Coverage map for ${accession}: ${pctCovered.toFixed(0)} percent of ${length} residues covered by experimental structures, with AlphaFold per-residue confidence below.`}
        onMouseMove={(e) => {
          const canvas = canvasRef.current;
          if (!canvas || !coverage || !length) return;
          const rect = canvas.getBoundingClientRect();
          const rel = (e.clientX - rect.left - PAD) / (rect.width - PAD * 2);
          const residue = Math.max(1, Math.min(length, Math.round(rel * (length - 1)) + 1));
          setHover({
            residue,
            depth: coverage.depth[residue] ?? 0,
            plddt: plddt ? (plddt[residue] || null) : null,
            x: e.clientX - rect.left,
          });
        }}
        onMouseLeave={() => setHover(null)}
      />

      {hover && (
        <div className="cov-tip" style={{ left: Math.min(Math.max(hover.x, 60), 640) }}>
          residue {hover.residue} · {hover.depth} structure{hover.depth === 1 ? '' : 's'}
          {hover.plddt !== null && <> · pLDDT {hover.plddt.toFixed(0)}</>}
        </div>
      )}

      <div className="cov-legend">
        <span><i className="sw" style={{ background: '#5bc8f5' }} /> experimental depth (brighter = higher resolution)</span>
        {plddt ? (
          <>
            <span><i className="sw" style={{ background: PLDDT_COLOUR.veryHigh }} /> pLDDT ≥ 90</span>
            <span><i className="sw" style={{ background: PLDDT_COLOUR.confident }} /> 70–90</span>
            <span><i className="sw" style={{ background: PLDDT_COLOUR.low }} /> 50–70</span>
            <span><i className="sw" style={{ background: PLDDT_COLOUR.veryLow }} /> &lt; 50</span>
          </>
        ) : (
          <button
            type="button"
            className="cov-load"
            disabled={loadingPlddt || !summary.cifUrl}
            onClick={async () => {
              if (!summary.cifUrl) return;
              setLoadingPlddt(true);
              const result = await fetchPlddt(summary.cifUrl).catch(() => null);
              if (result) setPlddt(result.plddt);
              setLoadingPlddt(false);
            }}
          >
            {loadingPlddt ? 'downloading the predicted model…' : 'add AlphaFold confidence'}
          </button>
        )}
      </div>

      <p className="footnote">
        The upper band is measurement — how many deposited structures cover each residue. The lower band is
        a <b>prediction</b>: AlphaFold's own per-residue confidence, model v{summary.modelVersion ?? '?'}.
        They are drawn separately on purpose. A high pLDDT is a model's belief about a residue, not evidence
        that anyone has observed it, and the two must never be read as one number.
        {ligandEntries.size > 0 && <> {ligandEntries.size.toLocaleString()} of these structures carry a scored ligand.</>}
      </p>
    </div>
  );
}
