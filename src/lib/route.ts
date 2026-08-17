// All state lives in the URL.
//
// This is the distribution mechanism, not a convenience: a link to a specific
// ligand at a specific contour is what gets pasted into a message, and a tool
// you cannot link into is a tool nobody cites. Format:
//
//   #1cbs/REA            — entry and ligand
//   #1cbs/REA/B          — a specific copy (label asym id)
//   #1cbs/REA/B?s=1.5    — with the contour level
//
// Anything unparseable falls back to the gallery rather than erroring: a bad
// link should land somewhere useful.

export interface Route {
  entry: string | null;
  comp: string | null;
  asymId: string | null;
  sigma: number | null;
  diff: boolean | null;
  /** UniProt accession for a whole-target view: #t/P00918 */
  target: string | null;
  /** Two ligands side by side: #x/1m17/AQ4/B/3ptb/BEN/C */
  compare: Array<{ entry: string; comp: string; asymId: string }> | null;
}

export const EMPTY_ROUTE: Route = {
  entry: null, comp: null, asymId: null, sigma: null, diff: null, target: null, compare: null,
};

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  if (!raw) return EMPTY_ROUTE;

  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  if (!parts.length) return EMPTY_ROUTE;

  const params = new URLSearchParams(queryPart ?? '');
  const sigmaRaw = params.get('s');
  const sigma = sigmaRaw !== null && Number.isFinite(Number(sigmaRaw)) ? Number(sigmaRaw) : null;
  const diffRaw = params.get('d');

  if (parts[0] === 't' && parts[1]) {
    return { ...EMPTY_ROUTE, target: parts[1].toUpperCase() };
  }

  if (parts[0] === 'x' && parts.length >= 7) {
    return {
      ...EMPTY_ROUTE,
      sigma, diff: diffRaw === null ? null : diffRaw === '1',
      compare: [
        { entry: parts[1].toLowerCase(), comp: parts[2].toUpperCase(), asymId: parts[3] },
        { entry: parts[4].toLowerCase(), comp: parts[5].toUpperCase(), asymId: parts[6] },
      ],
    };
  }

  // Same rule as the search box: a PDB id starts with a digit.
  const entry = /^[0-9][0-9a-zA-Z]{3}$/.test(parts[0]) ? parts[0].toLowerCase() : null;
  if (!entry) return EMPTY_ROUTE;

  return {
    ...EMPTY_ROUTE,
    entry,
    comp: parts[1] ? parts[1].toUpperCase() : null,
    asymId: parts[2] ?? null,
    sigma: sigma !== null ? Math.min(3, Math.max(0.4, sigma)) : null,
    diff: diffRaw === null ? null : diffRaw === '1',
  };
}

export function buildHash(route: Partial<Route>): string {
  if (route.compare?.length === 2) {
    const seg = route.compare
      .map((c) => `${c.entry.toLowerCase()}/${c.comp.toUpperCase()}/${c.asymId}`)
      .join('/');
    const params = new URLSearchParams();
    if (route.sigma != null) params.set('s', route.sigma.toFixed(1));
    if (route.diff != null) params.set('d', route.diff ? '1' : '0');
    const q = params.toString();
    return `#x/${seg}${q ? `?${q}` : ''}`;
  }
  if (route.target) return `#t/${route.target.toUpperCase()}`;
  if (!route.entry) return '#';
  let path = route.entry.toLowerCase();
  if (route.comp) path += `/${route.comp.toUpperCase()}`;
  if (route.comp && route.asymId) path += `/${route.asymId}`;

  const params = new URLSearchParams();
  if (route.sigma != null) params.set('s', route.sigma.toFixed(1));
  if (route.diff != null) params.set('d', route.diff ? '1' : '0');
  const q = params.toString();
  return `#${path}${q ? `?${q}` : ''}`;
}
