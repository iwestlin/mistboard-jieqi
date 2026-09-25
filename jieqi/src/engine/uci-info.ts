// UCI `info` line parser, ported from Mistboard's
// `apps/web/src/review/engine/uci-info.ts` (AGPL-3.0-or-later).

export interface InfoFields {
  depth: number;
  seldepth: number;
  multipv: number;
  scoreCp: number | null;
  mate: number | null;
  nodes: number;
  nps: number;
  pvUci: string[];
  /** True for an aspiration fail-high/fail-low bound: not a real score. */
  bound: boolean;
}

/** Parse a UCI `info` line. Returns null for `info string ...` and other lines. */
export function parseInfo(line: string): InfoFields | null {
  const t = line.split(/\s+/);
  if (t[0] !== 'info' || t[1] === 'string') return null;
  const f: InfoFields = {
    depth: 0,
    seldepth: 0,
    multipv: 1,
    scoreCp: null,
    mate: null,
    nodes: 0,
    nps: 0,
    pvUci: [],
    bound: false,
  };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth':
        f.depth = Number(t[++i]);
        break;
      case 'seldepth':
        f.seldepth = Number(t[++i]);
        break;
      case 'multipv':
        f.multipv = Number(t[++i]);
        break;
      case 'nodes':
        f.nodes = Number(t[++i]);
        break;
      case 'nps':
        f.nps = Number(t[++i]);
        break;
      case 'score':
        if (t[i + 1] === 'cp') {
          f.scoreCp = Number(t[i + 2]);
          i += 2;
        } else if (t[i + 1] === 'mate') {
          f.mate = Number(t[i + 2]);
          i += 2;
        }
        break;
      case 'lowerbound':
      case 'upperbound':
        f.bound = true;
        break;
      case 'pv':
        f.pvUci = t.slice(i + 1);
        return f;
    }
  }
  return f;
}
