// Captured-piece trays shared by the play and review screens. Each piece is a
// miniature piece disc; a piece that was still face-down (暗子) when captured is
// drawn with a badge when its identity is known, or as a plain back when it is
// not.

import type { JieqiCapturedView, JieqiColor, JieqiPieceRole } from '../game/index.js';
import { h } from './dom.js';
import { glyphPath, ROLE_GLYPH } from './pieces.js';

const CAPTURE_FILL: Record<JieqiColor, string> = { red: '#b3372b', black: '#2b3947' };
const CAPTURE_FACE = '#f4e3c1';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * One captured piece: a small disc, or a face-down back when the role is unknown.
 * A piece the viewer learned by capturing a still-dark piece keeps its revealed
 * glyph but carries a 暗 badge, so dark captures stay distinguishable.
 */
export function captureToken(
  color: JieqiColor,
  role: JieqiPieceRole | null,
  faceDown: boolean,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute(
    'class',
    `capture-token capture-token--${color}${role ? '' : ' capture-token--dark'}`,
  );
  const stroke = CAPTURE_FILL[color];
  const add = (tag: string, attrs: Record<string, string | number>): SVGElement => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    svg.append(el);
    return el;
  };
  if (!role) {
    // Face-down (暗子): the viewer never learned this piece's identity.
    add('circle', { cx: 50, cy: 50, r: 45, fill: stroke, stroke: '#00000033', 'stroke-width': 3 });
    add('circle', { cx: 50, cy: 50, r: 35, fill: 'none', stroke: '#ffffff88', 'stroke-width': 4 });
    add('circle', { cx: 50, cy: 50, r: 23, fill: 'none', stroke: '#ffffff55', 'stroke-width': 2 });
    return svg;
  }
  add('circle', { cx: 50, cy: 50, r: 45, fill: CAPTURE_FACE, stroke, 'stroke-width': 6 });
  add('circle', { cx: 50, cy: 50, r: 36, fill: 'none', stroke, 'stroke-width': 3, opacity: 0.5 });
  const path = glyphPath(color, role);
  if (path) {
    add('path', {
      d: path,
      fill: stroke,
      transform: 'translate(50 50) scale(0.82) translate(-50 -50)',
    });
  } else {
    const text = add('text', {
      x: 50,
      y: 50,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'font-size': 56,
      fill: stroke,
    });
    text.textContent = ROLE_GLYPH[color][role];
  }
  if (faceDown) {
    add('circle', { cx: 76, cy: 24, r: 24, fill: '#e0952b', stroke: '#00000055', 'stroke-width': 2 });
    const badge = add('text', {
      x: 76,
      y: 25,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'font-size': 32,
      'font-weight': 700,
      fill: '#1b1205',
    });
    badge.textContent = '暗';
  }
  return svg;
}

/** A row of the pieces `owner` lost, labelled by the side that captured them. */
export function captureRow(owner: JieqiColor, captured: readonly JieqiCapturedView[]): HTMLElement {
  const losses = captured.filter((c) => c.owner === owner);
  const capturer: JieqiColor = owner === 'red' ? 'black' : 'red';
  const label = h('span', {
    class: `capture-label capture-label--${capturer}`,
    text: capturer === 'red' ? '红方吃子' : '黑方吃子',
  });
  const tokens: (Node | string)[] = losses.length
    ? losses.map((c) => captureToken(c.owner, c.role, c.faceDown))
    : [h('span', { class: 'muted', text: '—' })];
  return h('div', { class: `capture-row capture-row--${owner}` }, [label, ...tokens]);
}
