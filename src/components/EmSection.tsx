import { useEffect, useMemo, useState } from 'react';
import { fetchEmTarget, loadEmMeta, type EmLigand, type EmMeta } from '../lib/targetIndex';

interface Props { accession: string }

/**
 * Cryo-EM ligands for the same protein — kept in their own section, never
 * merged into the X-ray ranking above.
 *
 * The reason is not tidiness. RSCC is the correlation between a model and a
 * crystallographic difference map; Q-score is how closely an atom's
 * surroundings match an ideal Gaussian in a cryo-EM potential map. Different
 * measurements, different scales, and in the archive they are disjoint: an
 * instance carries one or the other, never both. A single list sorted across
 * them would produce an order nobody could defend.
 */
export function EmSection({ accession }: Props) {
  const [ligands, setLigands] = useState<EmLigand[] | null>(null);
  const [meta, setMeta] = useState<EmMeta | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    setLigands(null);
    loadEmMeta().then((m) => { if (live) setMeta(m); }).catch(() => undefined);
    fetchEmTarget(accession)
      .then((l) => { if (live) setLigands(l); })
      .catch(() => { if (live) setLigands([]); });
    return () => { live = false; };
  }, [accession]);

  const visible = useMemo(
    () => (ligands ?? []).filter((l) => showAll || !l.isAdditive),
    [ligands, showAll],
  );

  if (!ligands || !ligands.length) return null;

  const hiddenCount = ligands.length - ligands.filter((l) => !l.isAdditive).length;

  return (
    <section className="em">
      <h3 className="section-title">
        Also solved by cryo-EM
        <span className="section-note">{ligands.length.toLocaleString()} ligand instances</span>
      </h3>

      <p className="em-lead">
        These are ranked on <b>Q-score</b>, not RSCC — a different measurement against a different kind
        of map. The two are <b>not on a common scale</b> and are never mixed into one order here: in the
        archive an instance carries one metric or the other, never both. Each is compared only against
        other cryo-EM ligands at similar resolution.
      </p>

      <div className="thead thead--em">
        <span>Entry</span><span>Ligand</span><span>Name</span><span>Res.</span><span>Q-score</span><span>Percentile</span>
      </div>
      <div className="tbody">
        {visible.slice(0, 60).map((l, i) => (
          <a
            className="trow trow--em"
            key={`${l.entry}/${l.comp}/${l.chain}${l.seq}#${i}`}
            href={`https://www.rcsb.org/structure/${l.entry}`}
            target="_blank"
            rel="noopener"
            title={l.emdb ? `${l.entry} · ${l.emdb}` : l.entry}
          >
            <span className="trow-entry">{l.entry}</span>
            <span className="trow-comp">
              {l.comp}
              {l.isSubject && <i className="trow-star" title="the ligand this structure is about">★</i>}
            </span>
            <span className="trow-name">{l.compName ?? ''}</span>
            <span className="trow-res">{l.resolution !== null ? `${l.resolution.toFixed(2)} Å` : '—'}</span>
            <span className="trow-rscc">{l.qScore !== null ? l.qScore.toFixed(3) : '—'}</span>
            <span className={`trow-pct${l.percentile !== null && l.percentile <= 5 ? ' is-bad' : l.percentile !== null && l.percentile <= 25 ? ' is-warn' : ''}`}>
              {l.percentile !== null ? `p${l.percentile.toFixed(1)}` : '—'}
            </span>
          </a>
        ))}
      </div>

      <p className="footnote">
        {hiddenCount > 0 && !showAll && (
          <>
            {hiddenCount.toLocaleString()} ions and buffer components hidden.{' '}
            <button type="button" className="linkbtn" onClick={() => setShowAll(true)}>show all</button>{' '}
          </>
        )}
        Per-atom density is not offered for these: a cryo-EM map carries no difference map, so the
        “an atom sits where nothing was measured” test that drives the X-ray view has no equivalent here.
        Rows link to the entry at RCSB instead of pretending otherwise.
        {meta && <> Reference population: {meta.reference.perShell.reduce((a, b) => a + b, 0).toLocaleString()} cryo-EM ligands flagged as the subject of their structure.</>}
      </p>
    </section>
  );
}
