// Electron-density grid: decode a VolumeServer BinaryCIF block into a
// sampleable 3D scalar field in Cartesian space.
//
// TWO TRAPS LIVE HERE. Both produce output that looks plausible and is wrong,
// which is the worst failure mode a tool like this can have:
//
//   1. `origin`, `dimensions` and `sample_count` are stored in AXIS ORDER, not
//      xyz. 1CBS returns axis_order [1,0,2] — read them as xyz and every
//      coordinate silently lands somewhere else in the cell.
//   2. The grid step is `dimensions / sample_count` or `dimensions /
//      (sample_count - 1)` depending on whether the samples are cell-periodic
//      or box-inclusive. The two differ by ~25% in reported sigma on identical
//      atoms. Which is correct is decided EMPIRICALLY in scripts/verify.ts by
//      which one puts density maxima on atom centres, not by reading a doc.
//
// Nothing here is trusted until validateGeometry() passes.

import {
  type BinaryCifFile, dataBlock, category, scalar, vector3, decodeColumn,
} from './binarycif';

export type GridSpacing = 'inclusive' | 'periodic';

export interface DensityGrid {
  /** Map name, e.g. '2FO-FC'. */
  name: string;
  /** Samples along canonical x, y, z. */
  sampleCount: [number, number, number];
  /** Fractional-space origin of the box, canonical xyz. */
  origin: [number, number, number];
  /** Fractional-space extent of the box, canonical xyz. */
  dimensions: [number, number, number];
  /** Raw values, laid out with axisOrder[0] varying fastest. */
  values: Float32Array;
  /** Storage order, fast to slow (as delivered). */
  axisOrder: [number, number, number];
  /** Sigma of the FULL source map — the correct denominator for n-sigma. */
  sigmaSource: number;
  meanSource: number;
  /** Sigma of just this sampled box, for reference/validation. */
  sigmaSampled: number;
  meanSampled: number;
  /** Cartesian -> fractional matrix (row-major 3x3). */
  toFractional: number[];
  /** Fractional -> Cartesian matrix (row-major 3x3). */
  toCartesian: number[];
  spacing: GridSpacing;
}

/** Build fractional<->Cartesian matrices from cell lengths (A) and angles (deg). */
function cellMatrices(
  size: [number, number, number],
  anglesDeg: [number, number, number],
): { toFractional: number[]; toCartesian: number[] } {
  const [a, b, c] = size;
  const [alpha, beta, gamma] = anglesDeg.map((d) => (d * Math.PI) / 180);
  const cosA = Math.cos(alpha), cosB = Math.cos(beta), cosG = Math.cos(gamma), sinG = Math.sin(gamma);

  // Standard PDB/crystallographic convention: a along x, b in the xy plane.
  const volumeFactor = Math.sqrt(
    1 - cosA * cosA - cosB * cosB - cosG * cosG + 2 * cosA * cosB * cosG,
  );

  const toCartesian = [
    a, b * cosG, c * cosB,
    0, b * sinG, (c * (cosA - cosB * cosG)) / sinG,
    0, 0, (c * volumeFactor) / sinG,
  ];

  // Invert the upper-triangular matrix analytically.
  const m00 = toCartesian[0], m01 = toCartesian[1], m02 = toCartesian[2];
  const m11 = toCartesian[4], m12 = toCartesian[5];
  const m22 = toCartesian[8];
  const toFractional = [
    1 / m00, -m01 / (m00 * m11), (m01 * m12 - m02 * m11) / (m00 * m11 * m22),
    0, 1 / m11, -m12 / (m11 * m22),
    0, 0, 1 / m22,
  ];

  return { toFractional, toCartesian };
}

function apply3(m: number[], v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Reorder a 3-vector delivered in axis order into canonical xyz.
 * axisOrder is fast-to-slow: axisOrder[i] names the canonical axis stored at
 * position i, so the value for canonical axis k sits at the position p where
 * axisOrder[p] === k.
 */
function toCanonical(
  v: [number, number, number],
  axisOrder: [number, number, number],
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let p = 0; p < 3; p++) out[axisOrder[p]] = v[p];
  return out;
}

/**
 * The default is 'periodic' (step = dimensions / sample_count) because that is
 * what the data says, not what a doc says. Measured with scripts/verify.ts,
 * median distance from each atom centre to the nearest density maximum:
 *
 *              1CBS/REA      13FL/NAG
 *   periodic     0.420 A       0.884 A
 *   inclusive    0.842 A       1.055 A
 *
 * The grid step is ~0.6 A, so 'periodic' lands peaks within a half-step of the
 * nuclei — where electron density actually peaks — while 'inclusive' is off by
 * more than a full step. It is also the physically right answer: the map is
 * sampled on a periodic cell grid, where sample N coincides with sample 0 of
 * the neighbouring cell, so N samples span the box rather than N-1.
 */
export function readDensityGrid(
  file: BinaryCifFile,
  blockName: string,
  spacing: GridSpacing = 'periodic',
): DensityGrid {
  const block = dataBlock(file, blockName);
  const info = category(block, '_volume_data_3d_info');
  const data = category(block, '_volume_data_3d');

  const axisOrder = vector3(info, 'axis_order').map((n) => n | 0) as [number, number, number];
  const originRaw = vector3(info, 'origin');
  const dimensionsRaw = vector3(info, 'dimensions');
  const sampleCountRaw = vector3(info, 'sample_count').map((n) => n | 0) as [number, number, number];

  const origin = toCanonical(originRaw, axisOrder);
  const dimensions = toCanonical(dimensionsRaw, axisOrder);
  const sampleCount = toCanonical(sampleCountRaw, axisOrder) as [number, number, number];

  const cellSize = vector3(info, 'spacegroup_cell_size');
  const cellAngles = vector3(info, 'spacegroup_cell_angles');
  const { toFractional, toCartesian } = cellMatrices(cellSize, cellAngles);

  const valuesCol = data.columns.find((c) => c.name === 'values');
  if (!valuesCol) throw new Error(`no 'values' column in ${blockName}`);
  const decoded = decodeColumn(valuesCol) as ArrayLike<number>;
  const values = decoded instanceof Float32Array ? decoded : Float32Array.from(decoded as ArrayLike<number>);

  const expected = sampleCount[0] * sampleCount[1] * sampleCount[2];
  if (values.length !== expected) {
    throw new Error(
      `${blockName}: ${values.length} values but sample_count implies ${expected} ` +
      `(${sampleCount.join('x')}) — axis handling is wrong`,
    );
  }

  return {
    name: blockName,
    sampleCount,
    origin,
    dimensions,
    values,
    axisOrder,
    sigmaSource: scalar(info, 'sigma_source'),
    meanSource: scalar(info, 'mean_source'),
    sigmaSampled: scalar(info, 'sigma_sampled'),
    meanSampled: scalar(info, 'mean_sampled'),
    toFractional,
    toCartesian,
    spacing,
  };
}

/** Grid step in fractional units along each canonical axis. */
function step(grid: DensityGrid, axis: number): number {
  const n = grid.sampleCount[axis];
  const denom = grid.spacing === 'inclusive' ? Math.max(1, n - 1) : n;
  return grid.dimensions[axis] / denom;
}

/** Continuous grid index (canonical xyz) for a Cartesian point, or null if outside. */
export function gridIndexOf(
  grid: DensityGrid,
  point: [number, number, number],
): [number, number, number] | null {
  const frac = apply3(grid.toFractional, point);
  const idx: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    idx[axis] = (frac[axis] - grid.origin[axis]) / step(grid, axis);
    if (!Number.isFinite(idx[axis])) return null;
  }
  return idx;
}

/** Value at integer grid coordinates, honouring the delivered storage order. */
export function valueAt(grid: DensityGrid, ix: number, iy: number, iz: number): number {
  const [nx, ny, nz] = grid.sampleCount;
  if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return NaN;
  const canonical = [ix, iy, iz];
  // Stride for the canonical axis stored at position p; position 0 is fastest.
  let offset = 0;
  let stride = 1;
  for (let p = 0; p < 3; p++) {
    const axis = grid.axisOrder[p];
    offset += canonical[axis] * stride;
    stride *= grid.sampleCount[axis];
  }
  return grid.values[offset];
}

/** Trilinear interpolation at a Cartesian point. NaN when outside the box. */
export function sampleDensity(grid: DensityGrid, point: [number, number, number]): number {
  const idx = gridIndexOf(grid, point);
  if (!idx) return NaN;
  const [fx, fy, fz] = idx;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const dx = fx - x0, dy = fy - y0, dz = fz - z0;

  let acc = 0;
  for (let cx = 0; cx <= 1; cx++) {
    for (let cy = 0; cy <= 1; cy++) {
      for (let cz = 0; cz <= 1; cz++) {
        const v = valueAt(grid, x0 + cx, y0 + cy, z0 + cz);
        if (Number.isNaN(v)) return NaN;
        const w = (cx ? dx : 1 - dx) * (cy ? dy : 1 - dy) * (cz ? dz : 1 - dz);
        acc += w * v;
      }
    }
  }
  return acc;
}

/** Density in units of the SOURCE map's sigma — the number crystallographers quote. */
export function sampleSigma(grid: DensityGrid, point: [number, number, number]): number {
  const v = sampleDensity(grid, point);
  if (Number.isNaN(v)) return NaN;
  return (v - grid.meanSource) / grid.sigmaSource;
}

/** Cartesian position of an integer grid node. */
export function cartesianOfNode(grid: DensityGrid, ix: number, iy: number, iz: number): [number, number, number] {
  const frac: [number, number, number] = [
    grid.origin[0] + ix * step(grid, 0),
    grid.origin[1] + iy * step(grid, 1),
    grid.origin[2] + iz * step(grid, 2),
  ];
  return apply3(grid.toCartesian, frac);
}
