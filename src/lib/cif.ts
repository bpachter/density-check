// A small, strict mmCIF text reader — enough to read the ModelServer's
// `atoms` response, and no more.
//
// Scope note: this handles the subset the ModelServer actually emits for a
// ligand query (single-block file, plain `_cat.item value` pairs and `loop_`
// tables, quoted strings, `?`/`.` nulls). It does NOT handle multi-line
// semicolon text fields inside loops, because the atom_site loop never
// contains one. If a future query needs them, the parser throws rather than
// silently mis-aligning columns — see `parseLoop`.

export interface CifLoop {
  /** Column names without the category prefix, in file order. */
  columns: string[];
  /** One array per column, all the same length. */
  values: string[][];
  rowCount: number;
}

export interface CifBlock {
  name: string;
  /** `_cell.length_a` -> "45.65" */
  items: Map<string, string>;
  /** `atom_site` -> loop */
  loops: Map<string, CifLoop>;
}

const NULLS = new Set(['?', '.']);

/** Split one CIF line into tokens, honouring '...' and "..." quoting. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '#') break; // comment to end of line
    if (ch === "'" || ch === '"') {
      // A quote only closes when followed by whitespace or EOL — that is the
      // actual CIF rule, and it is why O5' style atom names survive.
      const quote = ch;
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= line.length) throw new Error(`unterminated quote in CIF line: ${line}`);
        if (line[j] === quote && (j + 1 >= line.length || /[\s\t\r]/.test(line[j + 1]))) break;
        value += line[j];
        j++;
      }
      out.push(value);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < line.length && !/[\s\t\r]/.test(line[j])) j++;
    out.push(line.slice(i, j));
    i = j;
  }
  return out;
}

export function parseCif(text: string): CifBlock {
  const lines = text.split('\n');
  const block: CifBlock = { name: '', items: new Map(), loops: new Map() };
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line || line.startsWith('#')) { i++; continue; }

    if (line.startsWith('data_')) {
      block.name = line.slice(5);
      i++;
      continue;
    }

    if (line === 'loop_') {
      i = parseLoop(lines, i + 1, block);
      continue;
    }

    if (line.startsWith('_')) {
      const tokens = tokenize(line);
      const key = tokens[0];
      if (tokens.length >= 2) {
        block.items.set(key, tokens[1]);
        i++;
      } else {
        // Value sits on the following line(s); a leading ';' opens a multi-line
        // text field.
        i++;
        while (i < lines.length && !lines[i].trim()) i++;
        if (i >= lines.length) break;
        if (lines[i].startsWith(';')) {
          let value = lines[i].slice(1);
          i++;
          while (i < lines.length && !lines[i].startsWith(';')) { value += '\n' + lines[i]; i++; }
          i++; // closing ';'
          block.items.set(key, value.trim());
        } else {
          block.items.set(key, tokenize(lines[i])[0] ?? '');
          i++;
        }
      }
      continue;
    }

    i++; // anything else is not something this reader claims to understand
  }

  return block;
}

function parseLoop(lines: string[], start: number, block: CifBlock): number {
  let i = start;
  const tags: string[] = [];

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) { i++; continue; }
    if (!line.startsWith('_')) break;
    tags.push(line.split(/\s+/)[0]);
    i++;
  }

  if (!tags.length) return i;

  const category = tags[0].split('.')[0].slice(1);
  const columns = tags.map((t) => t.split('.')[1] ?? t);
  const values: string[][] = columns.map(() => []);

  let pending: string[] = [];
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { i++; continue; }
    if (line === '#') { i++; break; }
    if (line.startsWith('_') || line === 'loop_' || line.startsWith('data_')) break;
    if (raw.startsWith(';')) {
      throw new Error(
        `multi-line text field inside loop_${category} — this reader does not ` +
        `handle it, and guessing would mis-align every column after it`,
      );
    }

    pending.push(...tokenize(line));
    // A CIF row may wrap across lines; only commit once a full row is present.
    while (pending.length >= columns.length) {
      const row = pending.splice(0, columns.length);
      for (let c = 0; c < columns.length; c++) values[c].push(row[c]);
    }
    i++;
  }

  if (pending.length) {
    throw new Error(`loop_${category} ended mid-row (${pending.length} stray tokens)`);
  }

  block.loops.set(category, { columns, values, rowCount: values[0]?.length ?? 0 });
  return i;
}

/** Read a numeric item, throwing if it is absent or null — callers depend on it. */
export function requireNumber(block: CifBlock, key: string): number {
  const raw = block.items.get(key);
  if (raw === undefined || NULLS.has(raw)) throw new Error(`missing required CIF item ${key}`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`CIF item ${key} is not a number: ${raw}`);
  return n;
}

export function loopColumn(loop: CifLoop, name: string): string[] {
  const idx = loop.columns.indexOf(name);
  if (idx < 0) throw new Error(`loop is missing column ${name} (has: ${loop.columns.join(', ')})`);
  return loop.values[idx];
}
