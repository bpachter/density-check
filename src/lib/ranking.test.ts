import { describe, it, expect } from 'vitest';
import {
  shellFor, percentileFor, buildQuantileTable, sortWorstFirst, evidenceRank,
  type QuantileTable,
} from './ranking';

describe('shellFor', () => {
  it('bins by resolution, upper edge exclusive', () => {
    expect(shellFor(1.2)).toBe('<1.5');
    expect(shellFor(1.5)).toBe('1.5-2.0');
    expect(shellFor(1.99)).toBe('1.5-2.0');
    expect(shellFor(2.6)).toBe('2.5-3.0');
    expect(shellFor(3.4)).toBe('>3.0');
  });

  it('returns null rather than guessing when resolution is unknown', () => {
    expect(shellFor(null)).toBeNull();
    expect(shellFor(NaN)).toBeNull();
  });
});

describe('buildQuantileTable', () => {
  it('refuses to build a table from a thin shell', () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({ rscc: i / 150, resolution: 1.2 }));
    const { table, counts } = buildQuantileTable(rows);
    expect(counts['<1.5']).toBe(150);
    // Under 200 samples a 99-point table is noise; the count is kept, the
    // table is not fabricated.
    expect(table['<1.5']).toBeUndefined();
  });

  it('builds ascending quantiles for a populated shell', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ rscc: i / 1000, resolution: 2.2 }));
    const { table } = buildQuantileTable(rows);
    const q = table['2.0-2.5'];
    expect(q).toHaveLength(99);
    for (let i = 1; i < q.length; i++) expect(q[i]).toBeGreaterThanOrEqual(q[i - 1]);
  });
});

describe('percentileFor', () => {
  // A shell where RSCC runs 0.50 -> 0.99 uniformly.
  const table: QuantileTable = {
    '2.0-2.5': Array.from({ length: 99 }, (_, i) => 0.5 + (i + 1) * 0.005),
  };

  it('places a poor ligand low and a good one high', () => {
    const low = percentileFor(0.55, 2.2, table)!;
    const high = percentileFor(0.97, 2.2, table)!;
    expect(low).toBeLessThan(20);
    expect(high).toBeGreaterThan(80);
    expect(low).toBeLessThan(high);
  });

  it('is null when the shell has no distribution', () => {
    expect(percentileFor(0.8, 1.2, table)).toBeNull();
  });

  it('is null without an RSCC', () => {
    expect(percentileFor(null, 2.2, table)).toBeNull();
  });

  it('clamps to the 1..99 range', () => {
    expect(percentileFor(0.0, 2.2, table)).toBe(1);
    expect(percentileFor(1.0, 2.2, table)).toBe(99);
  });
});

describe('ranking across resolution shells', () => {
  // The whole point: the same RSCC means different things at different
  // resolutions, and raw sorting gets this backwards.
  const table: QuantileTable = {
    '<1.5': Array.from({ length: 99 }, (_, i) => 0.90 + (i + 1) * 0.001),   // high-res: everything is ~0.9+
    '>3.0': Array.from({ length: 99 }, (_, i) => 0.60 + (i + 1) * 0.003),   // low-res: 0.6-0.9 is normal
  };

  it('flags a high-resolution ligand that a raw RSCC sort would call better', () => {
    const highResMediocre = { rscc: 0.88, resolution: 1.2 };  // below its peers
    const lowResFine = { rscc: 0.85, resolution: 3.5 };        // typical for its peers

    // Raw RSCC would rank the 0.85 as worse.
    expect(lowResFine.rscc).toBeLessThan(highResMediocre.rscc);

    // Shell-aware ranking puts the high-resolution one first.
    const sorted = sortWorstFirst([lowResFine, highResMediocre], table);
    expect(sorted[0]).toBe(highResMediocre);
  });

  it('sorts unscored instances last — unknown is not a finding', () => {
    const scored = { rscc: 0.62, resolution: 3.2 };
    const unscored = { rscc: null, resolution: 3.2 };
    expect(evidenceRank(unscored, table)).toBeGreaterThan(evidenceRank(scored, table));
    expect(sortWorstFirst([unscored, scored], table)[0]).toBe(scored);
  });
});
