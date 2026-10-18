// looming.js - model-free "something is getting bigger fast" detector.
//
// Works for ANY object, named or not: it doesn't recognize things, it measures how fast
// each part of the view is expanding (the same cue our eyes use for "incoming!").
// If a region's texture spreads outward at rate r per second, contact is ~1/r seconds away.
//
// How: keep tiny grayscale copies of recent frames (160x120), track a grid of small
// patches between the current frame and one from ~0.2 s ago (block matching with
// sub-pixel refinement), then fit "scale + shift" to the patch motion in each zone
// (left / center / right). Shift = the wearer turning or swaying (ignored);
// scale = approach. A few milliseconds per frame, no model download.

export const LOOM_W = 160;
export const LOOM_H = 120;
const STEP = 8;              // grid spacing (px in the small frame)
const BLOCK = 3;             // patch half-size -> 7x7 patches
const SEARCH = 6;            // max shift searched (px), covers sway and turning
const MARGIN = SEARCH + BLOCK + 1;
// Compare against a frame ~0.1 s ago (fast approaches, before things grow too much to match)
// and ~0.2 s ago (slow approaches, more precise), alternating; each zone keeps the sooner one.
const BASELINES_S = [0.1, 0.2];
const FRESH_S = 0.2;        // a result from the other baseline counts if this recent
const MIN_TEXTURE = 6;       // patch std-dev; flat walls/sky can't be tracked
const MAX_SAD = 14;          // mean abs difference per pixel for a believable match
export const ZONES = [[0, 1 / 3], [1 / 3, 2 / 3], [2 / 3, 1]];

// Mean absolute difference between a patch in `cur` at (x, y) and in `prev` at (x+dx, y+dy)
// Stops early once it can't beat `limit` (big speed-up: most candidate shifts are bad)
function sad(prev, cur, w, x, y, dx, dy, limit) {
  let s = 0;
  for (let j = -BLOCK; j <= BLOCK; j++) {
    const rc = (y + j) * w + x;
    const rp = (y + j + dy) * w + x + dx;
    for (let i = -BLOCK; i <= BLOCK; i++) {
      const d = cur[rc + i] - prev[rp + i];
      s += d < 0 ? -d : d;
    }
    if (s > limit) return s;
  }
  return s;
}

function texture(img, w, x, y) {
  let sum = 0, sum2 = 0, n = 0;
  for (let j = -BLOCK; j <= BLOCK; j++) {
    for (let i = -BLOCK; i <= BLOCK; i++) {
      const v = img[(y + j) * w + x + i];
      sum += v; sum2 += v * v; n++;
    }
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

// Parabola through three costs -> sub-pixel offset of the minimum (-0.5..0.5)
function subpixel(cm, c0, cp) {
  const den = cm - 2 * c0 + cp;
  if (den <= 0) return 0;
  const o = (cm - cp) / (2 * den);
  return o > 0.5 ? 0.5 : o < -0.5 ? -0.5 : o;
}

// Where did the patch at (x, y) in `cur` come from in `prev`? Returns its motion prev -> cur.
export function patchMotion(prev, cur, w, x, y) {
  if (texture(cur, w, x, y) < MIN_TEXTURE) return null;
  const size = 2 * SEARCH + 1;
  const costs = new Float32Array(size * size);
  let best = Infinity, bx = 0, by = 0;
  for (let dy = -SEARCH; dy <= SEARCH; dy++) {
    for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      const c = sad(prev, cur, w, x, y, dx, dy, best);
      costs[(dy + SEARCH) * size + dx + SEARCH] = c;
      if (c < best) { best = c; bx = dx; by = dy; }
    }
  }
  // Neighbours of the best shift may have stopped early; compute them fully for sub-pixel accuracy
  for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const nx = bx + ox, ny = by + oy;
    if (Math.abs(nx) <= SEARCH && Math.abs(ny) <= SEARCH) {
      costs[(ny + SEARCH) * size + nx + SEARCH] = sad(prev, cur, w, x, y, nx, ny, Infinity);
    }
  }
  const area = (2 * BLOCK + 1) * (2 * BLOCK + 1);
  if (best / area > MAX_SAD) return null;
  if (Math.abs(bx) === SEARCH || Math.abs(by) === SEARCH) return null; // hit the edge: unreliable
  const at = (dx, dy) => costs[(dy + SEARCH) * size + dx + SEARCH];
  const fx = bx + subpixel(at(bx - 1, by), best, at(bx + 1, by));
  const fy = by + subpixel(at(bx, by - 1), best, at(bx, by + 1));
  return { dx: -fx, dy: -fy }; // found it at +offset in prev, so it moved by -offset
}

// Fit motion d = s * (p - centroid) + t to a set of points. s = relative growth over the interval.
export function fitScale(points) {
  const n = points.length;
  if (n < 6) return null;
  let mx = 0, my = 0, tx = 0, ty = 0;
  for (const p of points) { mx += p.x; my += p.y; tx += p.dx; ty += p.dy; }
  mx /= n; my /= n; tx /= n; ty /= n;
  let num = 0, den = 0;
  for (const p of points) {
    const qx = p.x - mx, qy = p.y - my;
    num += qx * (p.dx - tx) + qy * (p.dy - ty);
    den += qx * qx + qy * qy;
  }
  if (den < 1e-6) return null;
  const s = num / den;
  let err = 0;
  for (const p of points) {
    const ex = p.dx - (s * (p.x - mx) + tx), ey = p.dy - (s * (p.y - my) + ty);
    err += ex * ex + ey * ey;
  }
  return { s, tx, ty, residual: Math.sqrt(err / n), n, cx: mx, cy: my };
}

const MIN_RATE = 0.3;          // 1/s: below this (contact > ~3 s away) a point doesn't count as expanding
const MIN_CLUSTER = 3;         // connected expanding points needed (filters single-point noise)
const NEIGHBORS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Expansion between two small grayscale frames taken `dt` seconds apart.
// 1) track a grid of patches; 2) at each point, how fast it spreads away from its
// neighbours (pairwise scale change, median of up to 8) - that is local expansion,
// unaffected by turning/swaying (a shift moves neighbours together); 3) find connected
// clusters of expanding points, so an approaching object shows up even when it is small
// and the background around it is still.
// Per zone (left / center / right): rate > 0 = approaching; ttc = 1 / rate s; cx/cy = where (0..1).
export function measureExpansion(prev, cur, w, h, dt) {
  const cols = [], rows = [];
  for (let x = MARGIN; x < w - MARGIN; x += STEP) cols.push(x);
  for (let y = MARGIN; y < h - MARGIN; y += STEP) rows.push(y);
  const grid = rows.map((y) => cols.map((x) => patchMotion(prev, cur, w, x, y)));

  // Local expansion rate at each point
  const rate = rows.map(() => cols.map(() => null));
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      const m = grid[r][c];
      if (!m) continue;
      // Stretch towards left/right neighbours and towards up/down neighbours, separately.
      // Something approaching expands in BOTH directions; the edge of something sliding past
      // (covering/uncovering background) stretches in only one, so take the smaller.
      const horiz = [], vert = [];
      for (const [i, j] of NEIGHBORS) {
        if (i !== 0 && j !== 0) continue;
        const n = grid[r + j] && grid[r + j][c + i];
        if (!n) continue;
        if (j === 0) horiz.push((n.dx - m.dx) / (i * STEP));
        else vert.push((n.dy - m.dy) / (j * STEP));
      }
      if (!horiz.length || !vert.length) continue;
      const mean = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
      const sc = Math.min(mean(horiz), mean(vert));
      if (sc > -0.9) rate[r][c] = Math.log(1 + sc) / dt;
    }
  }

  // Connected clusters of expanding points, per zone
  const zones = ZONES.map(() => ({ rate: 0, ttc: Infinity, cx: 0.5, cy: 0.5, n: 0 }));
  const seen = rows.map(() => cols.map(() => false));
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      if (rate[r][c] !== null) zones[zoneOf(cols[c] / w)].n++;
      if (seen[r][c] || rate[r][c] === null || rate[r][c] < MIN_RATE) continue;
      const members = [];
      const stack = [[r, c]];
      seen[r][c] = true;
      while (stack.length) {
        const [rr, cc] = stack.pop();
        members.push([rr, cc]);
        for (const [i, j] of NEIGHBORS) {
          const nr = rr + j, nc = cc + i;
          if (nr < 0 || nc < 0 || nr >= rows.length || nc >= cols.length || seen[nr][nc]) continue;
          if (rate[nr][nc] === null || rate[nr][nc] < MIN_RATE) continue;
          seen[nr][nc] = true;
          stack.push([nr, nc]);
        }
      }
      if (members.length < MIN_CLUSTER) continue;
      const v = median(members.map(([rr, cc]) => rate[rr][cc]));
      let sx = 0, sy = 0;
      for (const [rr, cc] of members) { sx += cols[cc]; sy += rows[rr]; }
      const cx = sx / members.length / w, cy = sy / members.length / h;
      const z = zones[zoneOf(cx)];
      if (v > z.rate) { z.rate = v; z.cx = cx; z.cy = cy; z.size = members.length; }
    }
  }
  for (const z of zones) z.ttc = z.rate > 0 ? 1 / z.rate : Infinity;
  return zones;
}

function zoneOf(fx) {
  return fx < ZONES[0][1] ? 0 : fx < ZONES[1][1] ? 1 : 2;
}

export class LoomingDetector {
  constructor() {
    this.history = []; // { t, gray }
    this.canvas = null;
    this.ctx = null;
    this.turn = 0;
    this.last = BASELINES_S.map(() => null); // { t, zones } per baseline
  }

  reset() {
    this.history = [];
    this.last = BASELINES_S.map(() => null);
  }

  // Small grayscale copy of the current video frame
  grab(video) {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = LOOM_W;
      this.canvas.height = LOOM_H;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    this.ctx.drawImage(video, 0, 0, LOOM_W, LOOM_H);
    const rgba = this.ctx.getImageData(0, 0, LOOM_W, LOOM_H).data;
    const gray = new Uint8Array(LOOM_W * LOOM_H);
    for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
      gray[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    }
    return gray;
  }

  // Add a frame; returns per-zone expansion (sooner of the two baselines), or null if too early
  update(gray, t) {
    this.history.push({ t, gray });
    const maxAge = BASELINES_S[BASELINES_S.length - 1] * 2;
    while (this.history.length && t - this.history[0].t > maxAge) this.history.shift();

    const k = this.turn++ % BASELINES_S.length;
    const want = BASELINES_S[k];
    let ref = null;
    for (const f of this.history) {
      const age = t - f.t;
      if (age >= want * 0.5 && age <= want * 1.6 && (!ref || Math.abs(age - want) < Math.abs(t - ref.t - want))) ref = f;
    }
    if (ref) this.last[k] = { t, zones: measureExpansion(ref.gray, gray, LOOM_W, LOOM_H, t - ref.t) };

    const fresh = this.last.filter((r) => r && t - r.t <= FRESH_S);
    if (!fresh.length) return null;
    return ZONES.map((_, i) => {
      let best = fresh[0].zones[i];
      for (const r of fresh) if (r.zones[i].ttc < best.ttc) best = r.zones[i];
      return { ...best };
    });
  }
}
