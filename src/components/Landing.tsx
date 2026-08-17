import { CoverageMap } from './CoverageMap';

interface Props {
  onTarget: (accession: string) => void;
  onLigand: (entry: string, comp: string, asym: string) => void;
}

const TARGETS = [
  { accession: 'P00918', gene: 'CA2', label: 'Carbonic anhydrase 2', note: '4,429 ligand instances — the most-liganded protein in the PDB' },
  { accession: 'P00533', gene: 'EGFR', label: 'Epidermal growth factor receptor', note: 'the kinase behind erlotinib and gefitinib' },
  { accession: 'P24941', gene: 'CDK2', label: 'Cyclin-dependent kinase 2', note: 'a fragment-screening workhorse' },
  { accession: 'P62942', gene: 'FKBP1A', label: 'FKBP12', note: 'rapamycin, shared with mTOR' },
];

const LIGANDS = [
  { entry: '1cbs', comp: 'REA', asym: 'B', label: 'Retinoic acid', note: 'every atom above 1σ' },
  { entry: '13fl', comp: 'NAG', asym: 'G', label: 'A glycosylation sugar', note: '21% of atoms below 1σ' },
  { entry: '1m17', comp: 'AQ4', asym: 'B', label: 'Erlotinib in EGFR', note: 'solid core, disordered tails' },
  { entry: '3ptb', comp: 'BEN', asym: 'C', label: 'Benzamidine in trypsin', note: 'the textbook complex' },
];

export function Landing({ onTarget, onLigand }: Props) {
  return (
    <div className="landing">
      {/* The hero is live data, not a screenshot: the claim is that this works,
          so the front door had better be the thing working. */}
      <section className="hero">
        <p className="hero-kicker">The premise, on a real protein</p>
        <CoverageMap accession="P00533" ligands={[]} variant="hero" />
        <p className="hero-read">
          That is EGFR — the target of erlotinib and gefitinib, one of the most studied proteins in
          biology. The tall block is its kinase domain, solved hundreds of times over. Everything to the
          left of it has been looked at a handful of times. The lower strip is a different kind of claim
          entirely — AlphaFold's own confidence in its <i>prediction</i> — and its orange stretches mark
          where the model itself reports that it does not know. <b>Structural knowledge is far more uneven
          than a database listing suggests</b>, and that unevenness is invisible in every interface that
          hands you a single tidy structure.
        </p>
      </section>

      <section className="steps">
        <h2 className="section-title">What this does with that</h2>

        <div className="step">
          <div className="step-text">
            <span className="step-n">01</span>
            <h3>Ask about a target, not a file</h3>
            <p>
              Type a gene name or accession and get <b>every ligand ever modelled into that protein</b>,
              ranked worst-evidence-first. The archive was precomputed into 4,096 shards, so this is one
              request and about 50 milliseconds — 1.9 million ligand–protein pairs, no backend.
            </p>
            <p className="step-aside">
              Ranking is by percentile <i>within a resolution shell</i>. RSCC is resolution-dependent, so
              sorting on it raw would rank by resolution rather than by fit.
            </p>
          </div>
          <button type="button" className="step-shot" onClick={() => onTarget('P00918')}>
            <img src="media/target.png" alt="Carbonic anhydrase 2's ligands ranked worst-evidence-first, the weakest at RSCC 0.315 and the 0.1st percentile" loading="lazy" />
          </button>
        </div>

        <div className="step step--flip">
          <div className="step-text">
            <span className="step-n">02</span>
            <h3>See what the experiment actually measured</h3>
            <p>
              Open any ligand and the electron density is fetched and decoded <b>in your browser</b>, then
              sampled at every atom. The blue cloud is one point per grid sample of the real measurement.
              Red is difference density — an atom modelled where the experiment saw nothing.
            </p>
            <p className="step-aside">
              The decoder is verified byte-identical to Mol*, and the app re-runs 15 checks against known
              values on load. If it cannot reproduce them, it refuses to show numbers at all.
            </p>
          </div>
          <button type="button" className="step-shot" onClick={() => onLigand('1m17', 'AQ4', 'B')}>
            <img src="media/ligand-view.png" alt="Erlotinib in EGFR with its density cloud and every atom ranked by measured support" loading="lazy" />
          </button>
        </div>

        <div className="step">
          <div className="step-text">
            <span className="step-n">03</span>
            <h3>Read it as a chemist would</h3>
            <p>
              The same evidence as a flat structure, coloured atom by atom. Erlotinib's quinazoline core
              reads solid blue above 2σ; both methoxy-ethoxy tails read amber below 1σ. The disordered
              solubilising chain and the solid pharmacophore, in one glance — a distinction that a single
              summary score erases completely.
            </p>
          </div>
          <button type="button" className="step-shot" onClick={() => onLigand('1m17', 'AQ4', 'B')}>
            <img src="media/depict.png" alt="Erlotinib drawn in 2D with each atom coloured by how much density supports it" loading="lazy" />
          </button>
        </div>
      </section>

      <section className="primer">
        <h2 className="section-title">If none of those words meant anything</h2>
        <div className="primer-grid">
          <div>
            <h4>Electron density</h4>
            <p>
              An X-ray experiment does not photograph atoms. It measures a <b>cloud</b> — where electrons
              are, on average, across trillions of copies of the molecule. A person then decides which
              atoms fit inside that cloud. That decision is the model, and it is what gets published.
            </p>
          </div>
          <div>
            <h4>Sigma (σ)</h4>
            <p>
              How strong the measured cloud is at a point, in units of the map's own noise. Roughly: above
              2σ is solid, below 1σ means the experiment barely saw anything there — so an atom drawn at
              0.2σ is mostly someone's reasonable guess.
            </p>
          </div>
          <div>
            <h4>RSCC</h4>
            <p>
              A published score, 0 to 1, for how well a whole molecule matches the measured cloud. Useful
              for comparing across structures, but it is one number for the entire molecule — it cannot
              tell you that half a drug is solid and the other half is invented.
            </p>
          </div>
          <div>
            <h4>Why bother</h4>
            <p>
              Thousands of published ligands sit below RSCC 0.8, and a wrong atom position propagates into
              docking, medicinal chemistry and papers that cite it. Nothing here is an accusation — models
              are honest work under uncertainty. It just makes the uncertainty visible.
            </p>
          </div>
        </div>
      </section>

      <section className="gallery">
        <h2 className="section-title">Start with a target</h2>
        <div className="gallery-grid">
          {TARGETS.map((t) => (
            <button key={t.accession} type="button" className="gallery-card gallery-card--target" onClick={() => onTarget(t.accession)}>
              <span className="gallery-id">{t.gene}</span>
              <span className="gallery-label">{t.label}</span>
              <span className="gallery-note">{t.note}</span>
            </button>
          ))}
        </div>

        <h2 className="section-title" style={{ marginTop: 30 }}>…or a single ligand</h2>
        <div className="gallery-grid">
          {LIGANDS.map((g) => (
            <button key={`${g.entry}/${g.comp}`} type="button" className="gallery-card" onClick={() => onLigand(g.entry, g.comp, g.asym)}>
              <span className="gallery-id">{g.entry.toUpperCase()} · {g.comp}</span>
              <span className="gallery-label">{g.label}</span>
              <span className="gallery-note">{g.note}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
