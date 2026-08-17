// BinaryCIF decoder — the encoding chains actually emitted by RCSB's
// VolumeServer and ModelServer.
//
// A BinaryCIF column stores its data as bytes plus an ordered list of
// encodings that were applied when writing. Decoding walks that list in
// REVERSE. Every encoding below is implemented from the specification at
// https://github.com/molstar/BinaryCIF, and each one is exercised by a live
// response in scripts/verify.ts — none of this is written from memory of a
// schema (see CLAUDE-style rule: a fixture is not evidence).

import { decode as msgpackDecode } from '@msgpack/msgpack';

// ByteArray type codes. These are the wire values, not an internal enum.
const enum ByteArrayType {
  Int8 = 1, Int16 = 2, Int32 = 3,
  Uint8 = 4, Uint16 = 5, Uint32 = 6,
  Float32 = 32, Float64 = 33,
}

export interface BinaryCifColumn {
  name: string;
  data: { data: Uint8Array; encoding: Encoding[] };
  mask?: { data: Uint8Array; encoding: Encoding[] };
}

export interface BinaryCifCategory {
  name: string;
  rowCount: number;
  columns: BinaryCifColumn[];
}

export interface BinaryCifDataBlock {
  header: string;
  categories: BinaryCifCategory[];
}

export interface BinaryCifFile {
  encoder: string;
  version: string;
  dataBlocks: BinaryCifDataBlock[];
}

type Encoding =
  | { kind: 'ByteArray'; type: number }
  | { kind: 'FixedPoint'; factor: number; srcType: number }
  | { kind: 'IntervalQuantization'; min: number; max: number; numSteps: number; srcType: number }
  | { kind: 'RunLength'; srcType: number; srcSize: number }
  | { kind: 'Delta'; origin: number; srcType: number }
  | { kind: 'IntegerPacking'; byteCount: number; isUnsigned: boolean; srcSize: number }
  | { kind: 'StringArray'; dataEncoding: Encoding[]; stringData: string; offsetEncoding: Encoding[]; offsets: Uint8Array };

/** Reinterpret a byte buffer as the typed array named by a ByteArray type code. */
function typedFromBytes(bytes: Uint8Array, type: number): ArrayLike<number> {
  // .slice() rather than a view over the parent buffer: msgpack hands back
  // subarrays whose byteOffset is rarely aligned to 4/8, and a misaligned
  // TypedArray constructor throws.
  const buf = bytes.slice().buffer;
  switch (type) {
    case ByteArrayType.Int8: return new Int8Array(buf);
    case ByteArrayType.Int16: return new Int16Array(buf);
    case ByteArrayType.Int32: return new Int32Array(buf);
    case ByteArrayType.Uint8: return new Uint8Array(buf);
    case ByteArrayType.Uint16: return new Uint16Array(buf);
    case ByteArrayType.Uint32: return new Uint32Array(buf);
    case ByteArrayType.Float32: return new Float32Array(buf);
    case ByteArrayType.Float64: return new Float64Array(buf);
    default: throw new Error(`unknown ByteArray type ${type}`);
  }
}

function decodeStep(data: unknown, enc: Encoding): unknown {
  switch (enc.kind) {
    case 'ByteArray':
      return typedFromBytes(data as Uint8Array, enc.type);

    case 'FixedPoint': {
      const src = data as ArrayLike<number>;
      const out = new Float64Array(src.length);
      const inv = 1 / enc.factor;
      for (let i = 0; i < src.length; i++) out[i] = src[i] * inv;
      return out;
    }

    case 'IntervalQuantization': {
      // The write side mapped [min,max] onto 0..numSteps-1. Undo it.
      const src = data as ArrayLike<number>;
      const out = new Float32Array(src.length);
      const delta = (enc.max - enc.min) / (enc.numSteps - 1);
      for (let i = 0; i < src.length; i++) out[i] = enc.min + delta * src[i];
      return out;
    }

    case 'RunLength': {
      const src = data as ArrayLike<number>;
      const out = new Int32Array(enc.srcSize);
      let o = 0;
      for (let i = 0; i < src.length; i += 2) {
        const value = src[i];
        const count = src[i + 1];
        for (let j = 0; j < count; j++) out[o++] = value;
      }
      if (o !== enc.srcSize) throw new Error(`RunLength produced ${o} values, expected ${enc.srcSize}`);
      return out;
    }

    case 'Delta': {
      const src = data as ArrayLike<number>;
      const out = new Int32Array(src.length);
      let acc = enc.origin;
      for (let i = 0; i < src.length; i++) { acc += src[i]; out[i] = acc; }
      return out;
    }

    case 'IntegerPacking': {
      // Values too large for byteCount bytes were split across consecutive
      // entries, each maxed-out entry meaning "add me and keep reading".
      const src = data as ArrayLike<number>;
      const out = new Int32Array(enc.srcSize);
      const upper = enc.isUnsigned
        ? (enc.byteCount === 1 ? 0xff : 0xffff)
        : (enc.byteCount === 1 ? 0x7f : 0x7fff);
      // Signed packing continues on EITHER limit; unsigned continues only on
      // the upper one. Treating 0 as a continuation marker in an unsigned
      // array silently swallows every legitimate zero and shifts everything
      // after it — which is how a string table ends up one entry short.
      const lower = enc.isUnsigned ? NaN : (enc.byteCount === 1 ? -0x80 : -0x8000);
      let i = 0, o = 0;
      while (i < src.length) {
        let value = 0;
        let t = src[i];
        while (t === upper || t === lower) {
          value += t;
          i++;
          t = src[i];
        }
        value += t;
        i++;
        out[o++] = value;
      }
      if (o !== enc.srcSize) throw new Error(`IntegerPacking produced ${o} values, expected ${enc.srcSize}`);
      return out;
    }

    case 'StringArray': {
      const offsets = decodeChain(enc.offsets, enc.offsetEncoding) as ArrayLike<number>;
      const indices = decodeChain(data as Uint8Array, enc.dataEncoding) as ArrayLike<number>;
      const strings: string[] = [''];
      for (let i = 1; i < offsets.length; i++) {
        strings.push(enc.stringData.substring(offsets[i - 1], offsets[i]));
      }
      const out: string[] = [];
      for (let i = 0; i < indices.length; i++) out.push(strings[indices[i] + 1] ?? '');
      return out;
    }

    default:
      throw new Error(`unsupported BinaryCIF encoding: ${(enc as { kind: string }).kind}`);
  }
}

function decodeChain(data: Uint8Array, encoding: Encoding[]): unknown {
  let current: unknown = data;
  for (let i = encoding.length - 1; i >= 0; i--) {
    current = decodeStep(current, encoding[i]);
  }
  return current;
}

export function decodeColumn(col: BinaryCifColumn): ArrayLike<number> | string[] {
  return decodeChain(col.data.data, col.data.encoding) as ArrayLike<number> | string[];
}

export function parseBinaryCif(bytes: Uint8Array): BinaryCifFile {
  const raw = msgpackDecode(bytes) as BinaryCifFile;
  if (!raw?.dataBlocks) throw new Error('not a BinaryCIF file (no dataBlocks)');
  return raw;
}

/** Find a data block by header, e.g. '2FO-FC'. */
export function dataBlock(file: BinaryCifFile, header: string): BinaryCifDataBlock {
  const block = file.dataBlocks.find((b) => b.header === header);
  if (!block) {
    throw new Error(`no '${header}' data block (have: ${file.dataBlocks.map((b) => b.header).join(', ')})`);
  }
  return block;
}

export function category(block: BinaryCifDataBlock, name: string): BinaryCifCategory {
  const cat = block.categories.find((c) => c.name === name || c.name === `_${name}`);
  if (!cat) {
    throw new Error(`no category '${name}' in ${block.header} (have: ${block.categories.map((c) => c.name).join(', ')})`);
  }
  return cat;
}

/** Read a single-row numeric field, e.g. `sigma_source`. */
export function scalar(cat: BinaryCifCategory, name: string): number {
  const col = cat.columns.find((c) => c.name === name);
  if (!col) throw new Error(`no column '${name}' in ${cat.name}`);
  const decoded = decodeColumn(col);
  const v = Number((decoded as ArrayLike<number>)[0]);
  if (!Number.isFinite(v)) throw new Error(`column '${name}' is not numeric`);
  return v;
}

/** Read a 3-vector stored as `name[0]`, `name[1]`, `name[2]`. */
export function vector3(cat: BinaryCifCategory, name: string): [number, number, number] {
  return [scalar(cat, `${name}[0]`), scalar(cat, `${name}[1]`), scalar(cat, `${name}[2]`)];
}
