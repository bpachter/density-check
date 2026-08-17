// CCP4 / MRC map reader.
//
// This is what lets someone analyse their OWN structure: drop a coordinate file
// and the map it was refined against, and the same per-atom evidence runs
// entirely in the browser. Nothing is uploaded — the bytes never leave the
// machine, which for unpublished work is not a nicety but the whole condition
// of using the tool at all.
//
// The format has the same trap as the VolumeServer's: the grid is stored in
// column/row/section order, and MAPC/MAPR/MAPS say which crystal axis each of
// those is. Read them as xyz and every coordinate silently lands somewhere
// else. The output is the same DensityGrid the rest of the app already
// samples, so one sampling path serves both sources.

import type { DensityGrid } from './volume';

const HEADER_BYTES = 1024;

/** Word offsets into the header, 0-indexed, per the CCP4/MRC2014 specification. */
const W = {
  NC: 0, NR: 1, NS: 2, MODE: 3,
  NCSTART: 4, NRSTART: 5, NSSTART: 6,
  NX: 7, NY: 8, NZ: 9,
  CELL: 10,          // 6 floats: a b c alpha beta gamma
  MAPC: 16, MAPR: 17, MAPS: 18,
  AMIN: 19, AMAX: 20, AMEAN: 21,
  ISPG: 22, NSYMBT: 23,
  ORIGIN: 49,        // 3 floats (MRC2000 origin, in Angstrom)
  MAP: 52, MACHST: 53, ARMS: 54, NLABL: 55,
};

const MODE_INT8 = 0, MODE_INT16 = 1, MODE_FLOAT32 = 2, MODE_UINT16 = 6;

function cellMatrices(size: [number, number, number], anglesDeg: [number, number, number]) {
  const [a, b, c] = size;
  const [alpha, beta, gamma] = anglesDeg.map((d) => (d * Math.PI) / 180);
  const cosA = Math.cos(alpha), cosB = Math.cos(beta), cosG = Math.cos(gamma), sinG = Math.sin(gamma);
  const vol = Math.sqrt(1 - cosA * cosA - cosB * cosB - cosG * cosG + 2 * cosA * cosB * cosG);
  const toCartesian = [
    a, b * cosG, c * cosB,
    0, b * sinG, (c * (cosA - cosB * cosG)) / sinG,
    0, 0, (c * vol) / sinG,
  ];
  const m00 = toCartesian[0], m01 = toCartesian[1], m02 = toCartesian[2];
  const m11 = toCartesian[4], m12 = toCartesian[5], m22 = toCartesian[8];
  const toFractional = [
    1 / m00, -m01 / (m00 * m11), (m01 * m12 - m02 * m11) / (m00 * m11 * m22),
    0, 1 / m11, -m12 / (m11 * m22),
    0, 0, 1 / m22,
  ];
  return { toFractional, toCartesian };
}

export function parseCcp4(buffer: ArrayBuffer, name = 'local map'): DensityGrid {
  if (buffer.byteLength < HEADER_BYTES) throw new Error('file is too small to be a CCP4/MRC map');

  // Endianness: MODE is 0..6, so a byte-swapped file gives an absurd value.
  let littleEndian = true;
  let view = new DataView(buffer);
  const modeLE = view.getInt32(W.MODE * 4, true);
  if (modeLE < 0 || modeLE > 6) {
    const modeBE = view.getInt32(W.MODE * 4, false);
    if (modeBE < 0 || modeBE > 6) throw new Error('not a CCP4/MRC map (mode out of range in both byte orders)');
    littleEndian = false;
  }
  const i32 = (w: number) => view.getInt32(w * 4, littleEndian);
  const f32 = (w: number) => view.getFloat32(w * 4, littleEndian);

  const mode = i32(W.MODE);
  const counts = [i32(W.NC), i32(W.NR), i32(W.NS)];               // column, row, section
  const starts = [i32(W.NCSTART), i32(W.NRSTART), i32(W.NSSTART)];
  const cellSampling = [i32(W.NX), i32(W.NY), i32(W.NZ)];          // per crystal axis
  const cellSize: [number, number, number] = [f32(W.CELL), f32(W.CELL + 1), f32(W.CELL + 2)];
  const cellAngles: [number, number, number] = [f32(W.CELL + 3), f32(W.CELL + 4), f32(W.CELL + 5)];

  // MAPC/MAPR/MAPS are 1-based crystal axes: which axis is the column, the row,
  // the section. This is the whole ballgame for getting coordinates right.
  const axisForPosition = [i32(W.MAPC) - 1, i32(W.MAPR) - 1, i32(W.MAPS) - 1];
  if (axisForPosition.some((a) => a < 0 || a > 2) || new Set(axisForPosition).size !== 3) {
    throw new Error(`map axis order is not a permutation of x,y,z (got ${axisForPosition.map((a) => a + 1).join(',')})`);
  }

  const nsymbt = i32(W.NSYMBT);
  const dataStart = HEADER_BYTES + Math.max(0, nsymbt);
  const voxels = counts[0] * counts[1] * counts[2];

  const bytesPer = mode === MODE_FLOAT32 ? 4 : mode === MODE_INT16 || mode === MODE_UINT16 ? 2 : mode === MODE_INT8 ? 1 : 0;
  if (!bytesPer) throw new Error(`unsupported map mode ${mode} (only 0, 1, 2 and 6 are read)`);
  if (buffer.byteLength < dataStart + voxels * bytesPer) {
    throw new Error(`map is truncated: header declares ${voxels} voxels but the file is too short`);
  }

  const values = new Float32Array(voxels);
  view = new DataView(buffer, dataStart);
  for (let i = 0; i < voxels; i++) {
    values[i] = mode === MODE_FLOAT32 ? view.getFloat32(i * 4, littleEndian)
      : mode === MODE_INT16 ? view.getInt16(i * 2, littleEndian)
      : mode === MODE_UINT16 ? view.getUint16(i * 2, littleEndian)
      : view.getInt8(i);
  }

  // Reorder the per-position quantities into canonical xyz.
  const sampleCount: [number, number, number] = [0, 0, 0];
  const startCanonical: [number, number, number] = [0, 0, 0];
  for (let p = 0; p < 3; p++) {
    sampleCount[axisForPosition[p]] = counts[p];
    startCanonical[axisForPosition[p]] = starts[p];
  }

  // Fractional geometry. A CCP4 grid is periodic over the cell sampling, so the
  // step is 1/NX — which is the same 'periodic' convention the VolumeServer
  // path settled on empirically.
  const origin: [number, number, number] = [0, 0, 0];
  const dimensions: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const n = cellSampling[a] || sampleCount[a];
    origin[a] = startCanonical[a] / n;
    dimensions[a] = sampleCount[a] / n;
  }

  const { toFractional, toCartesian } = cellMatrices(cellSize, cellAngles);

  // ARMS is the map's own rms deviation — the sigma crystallographers quote.
  // Some writers leave it zero, so fall back to computing it.
  let sigma = f32(W.ARMS);
  let mean = f32(W.AMEAN);
  if (!Number.isFinite(sigma) || sigma <= 0) {
    let sum = 0, sumSq = 0;
    for (let i = 0; i < voxels; i++) { sum += values[i]; sumSq += values[i] * values[i]; }
    mean = sum / voxels;
    sigma = Math.sqrt(Math.max(0, sumSq / voxels - mean * mean));
  }

  return {
    name,
    sampleCount,
    origin,
    dimensions,
    values,
    axisOrder: axisForPosition as [number, number, number],
    sigmaSource: sigma,
    meanSource: mean,
    sigmaSampled: sigma,
    meanSampled: mean,
    toFractional,
    toCartesian,
    spacing: 'periodic',
  };
}
