// hazard.js - on-device "something is coming at you fast" detector.
//
// Runs entirely on the phone (no network), so alerts arrive in a fraction of a second.
// Pipeline per camera frame:  detect -> track -> measure approach -> decide -> alert
//
// Install:  npm install @mediapipe/tasks-vision@0.10.14
//
// How "approaching" is measured: if an object's box grows, it's getting closer.
// The growth rate of the box's (log) size is 1 / time-to-collision, so we get
// "contact in ~1.5 s" without knowing the real distance.

import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';

// Keep the wasm version identical to the npm package version above.
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

// Things worth warning about. ttc = seconds-to-contact that triggers an alert.
// rank = priority when several things approach at once (higher wins).
const CLASSES = {
  car:          { name: 'Car',       ttc: 3.0, rank: 3 },
  bus:          { name: 'Bus',       ttc: 3.0, rank: 3 },
  truck:        { name: 'Truck',     ttc: 3.0, rank: 3 },
  motorcycle:   { name: 'Motorbike', ttc: 3.0, rank: 3 },
  bicycle:      { name: 'Bike',      ttc: 3.0, rank: 3 },
  person:       { name: 'Person',    ttc: 2.0, rank: 2 },
  dog:          { name: 'Dog',       ttc: 2.0, rank: 2 },
  horse:        { name: 'Horse',     ttc: 2.5, rank: 2 },
  skateboard:   { name: 'Skateboard', ttc: 2.0, rank: 2 },
  'sports ball': { name: 'Ball',     ttc: 1.5, rank: 1 },
  frisbee:      { name: 'Frisbee',   ttc: 1.5, rank: 1 },
};

export const SENSITIVITY = { low: 0.7, normal: 1.0, high: 1.4 };

// ---------- Tunables ----------
const MIN_SCORE = 0.4;          // detector confidence
const MIN_FRAME_GAP_MS = 40;    // cap at ~25 fps to save battery
const WINDOW_S = 0.45;          // history used to measure growth
const MIN_SAMPLES = 4;
const MIN_SPAN_S = 0.2;
const MIN_SIZE = 0.05;          // ignore tiny boxes (sqrt of area fraction) - too noisy
const MATCH_IOU = 0.25;         // same object across frames
const TRACK_TIMEOUT_MS = 500;   // forget objects not seen for this long
const CONFIRM_FRAMES = 2;       // threat must hold this many frames in a row
const TRACK_COOLDOWN_MS = 4000; // don't repeat for the same object
const GLOBAL_GAP_MS = 1200;     // min gap between any two alerts (unless more urgent)
const CENTER_BAND = [0.3, 0.7]; // "in front of you" (fraction of frame width)
const STALL_MS = 2500;          // no frames for this long = camera/model stalled

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
}

// Least-squares slope of y over t (robust to frame-to-frame jitter)
function slope(samples, key) {
  const n = samples.length;
  let st = 0, sy = 0, stt = 0, sty = 0;
  for (const s of samples) { st += s.t; sy += s[key]; stt += s.t * s.t; sty += s.t * s[key]; }
  const den = n * stt - st * st;
  return den === 0 ? 0 : (n * sty - st * sy) / den;
}

export class HazardWatcher {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.video
   * @param {(alert) => void} opts.onAlert   {label, name, direction, ttc, rank}
   * @param {(state, detail?) => void} opts.onStatus  'loading' | 'on' | 'stalled' | 'error' | 'off'
   * @param {(frame) => void} [opts.onFrame]  {tracks, vw, vh} every processed frame (for drawing)
   * @param {(stats) => void} [opts.onStats]  {latencyMs, fps} about once a second
   */
  constructor({ video, onAlert, onStatus, onFrame, onStats }) {
    this.video = video;
    this.onAlert = onAlert;
    this.onStatus = onStatus;
    this.onFrame = onFrame;
    this.onStats = onStats;
    this.detector = null;
    this.running = false;
    this.sensitivity = 1;
    this.tracks = [];
    this.nextId = 1;
    this.lastAlert = { at: 0, rank: 0 };
    this.lastProcessed = 0;
    this.lastFrameAt = 0;
    this.stalled = false;
    this.stat = { frames: 0, ms: 0, since: 0 };
    this._loop = this._loop.bind(this);
  }

  setSensitivity(mult) { this.sensitivity = mult; }

  async start() {
    if (this.running) return;
    this.running = true;
    this.onStatus('loading');
    try {
      if (!this.detector) this.detector = await this._createDetector();
    } catch (e) {
      this.running = false;
      this.onStatus('error', e);
      return;
    }
    if (!this.running) return; // stopped while loading
    this.tracks = [];
    this.stalled = false;
    this.lastFrameAt = performance.now();
    this.stat = { frames: 0, ms: 0, since: performance.now() };
    this.onStatus('on');
    this._schedule();
    this.watchdog = setInterval(() => this._checkStall(), 1000);
  }

  stop() {
    this.running = false;
    clearInterval(this.watchdog);
    this.tracks = [];
    this.onStatus('off');
  }

  async _createDetector() {
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      scoreThreshold: MIN_SCORE,
      maxResults: 10,
      categoryAllowlist: Object.keys(CLASSES),
    });
    try {
      return await ObjectDetector.createFromOptions(vision, opts('GPU'));
    } catch (e) {
      console.warn('[hazard] GPU unavailable, using CPU', e);
      return ObjectDetector.createFromOptions(vision, opts('CPU'));
    }
  }

  _schedule() {
    if (!this.running) return;
    const v = this.video;
    // requestVideoFrameCallback fires once per *new* camera frame - no wasted work
    if (v && v.requestVideoFrameCallback) v.requestVideoFrameCallback(this._loop);
    else requestAnimationFrame(this._loop);
  }

  _loop() {
    if (!this.running) return;
    const now = performance.now();
    const v = this.video;
    if (v && v.readyState >= 2 && v.videoWidth && now - this.lastProcessed >= MIN_FRAME_GAP_MS) {
      this.lastProcessed = now;
      try {
        const res = this.detector.detectForVideo(v, now);
        const ms = performance.now() - now;
        this._process(res.detections || [], v.videoWidth, v.videoHeight, now / 1000);
        this._recordStats(ms);
        this.lastFrameAt = performance.now();
        if (this.stalled) { this.stalled = false; this.onStatus('on'); }
      } catch (e) {
        console.error('[hazard] detection failed', e);
      }
    }
    this._schedule();
  }

  _checkStall() {
    if (!this.running || this.stalled) return;
    if (performance.now() - this.lastFrameAt > STALL_MS) {
      this.stalled = true;
      this.onStatus('stalled');
    }
  }

  _recordStats(ms) {
    const s = this.stat;
    s.frames += 1;
    s.ms += ms;
    const elapsed = performance.now() - s.since;
    if (elapsed >= 1000) {
      if (this.onStats) this.onStats({ latencyMs: Math.round(s.ms / s.frames), fps: Math.round((s.frames * 1000) / elapsed) });
      this.stat = { frames: 0, ms: 0, since: performance.now() };
    }
  }

  // ---------- detect -> track -> measure -> decide ----------
  _process(detections, vw, vh, t) {
    // 1. Normalize detections to 0-1 boxes
    const dets = [];
    for (const d of detections) {
      const cat = d.categories && d.categories[0];
      if (!cat || !CLASSES[cat.categoryName] || cat.score < MIN_SCORE) continue;
      const b = d.boundingBox;
      dets.push({
        label: cat.categoryName,
        x1: b.originX / vw, y1: b.originY / vh,
        x2: (b.originX + b.width) / vw, y2: (b.originY + b.height) / vh,
      });
    }

    // 2. Match detections to existing tracks (greedy, best overlap first, same label only)
    const pairs = [];
    this.tracks.forEach((tr, ti) => dets.forEach((d, di) => {
      if (tr.label !== d.label) return;
      const o = iou(tr.box, d);
      if (o >= MATCH_IOU) pairs.push([o, ti, di]);
    }));
    pairs.sort((a, b) => b[0] - a[0]);
    const usedT = new Set(), usedD = new Set();
    for (const [, ti, di] of pairs) {
      if (usedT.has(ti) || usedD.has(di)) continue;
      usedT.add(ti); usedD.add(di);
      this._addSample(this.tracks[ti], dets[di], t);
    }
    dets.forEach((d, di) => {
      if (usedD.has(di)) return;
      const tr = { id: this.nextId++, label: d.label, samples: [], hits: 0, alertedAt: 0 };
      this._addSample(tr, d, t);
      this.tracks.push(tr);
    });
    this.tracks = this.tracks.filter((tr) => (t - tr.lastSeen) * 1000 < TRACK_TIMEOUT_MS);

    // 3. Measure approach for each track
    let best = null;
    for (const tr of this.tracks) {
      tr.threat = false;
      tr.ttc = null;
      if (tr.lastSeen !== t) continue; // not visible this frame
      const recent = tr.samples;
      if (recent.length < MIN_SAMPLES || recent[recent.length - 1].t - recent[0].t < MIN_SPAN_S) { tr.hits = 0; continue; }
      const size = recent[recent.length - 1].size;
      if (size < MIN_SIZE) { tr.hits = 0; continue; }

      const growth = slope(recent, 'ls');    // d(ln size)/dt = 1 / time-to-contact
      if (growth <= 0.05) { tr.hits = 0; continue; }
      const ttc = 1 / growth;
      tr.ttc = ttc;

      // Is it heading at the wearer? In the center band now, or drifting into it.
      const { x1, x2, cx } = tr.box;
      const vx = slope(recent, 'cx');
      const cxAtContact = cx + vx * Math.min(ttc, 3);
      const onCourse = (x1 < CENTER_BAND[1] && x2 > CENTER_BAND[0]) || Math.abs(cxAtContact - 0.5) < 0.2;

      const cls = CLASSES[tr.label];
      const limit = cls.ttc * this.sensitivity;
      if (onCourse && ttc < limit) {
        tr.hits += 1;
        tr.threat = tr.hits >= CONFIRM_FRAMES;
      } else {
        tr.hits = 0;
      }
      if (tr.threat) {
        const urgency = cls.rank * 10 + limit / ttc;
        if (!best || urgency > best.urgency) best = { tr, cls, ttc, urgency };
      }
    }

    if (this.onFrame) this.onFrame({ tracks: this.tracks, vw, vh });

    // 4. Decide whether to alert
    if (!best) return;
    const nowMs = performance.now();
    const { tr, cls, ttc } = best;
    if (nowMs - tr.alertedAt < TRACK_COOLDOWN_MS) return;
    const sinceLast = nowMs - this.lastAlert.at;
    if (sinceLast < GLOBAL_GAP_MS && cls.rank <= this.lastAlert.rank) return;

    tr.alertedAt = nowMs;
    this.lastAlert = { at: nowMs, rank: cls.rank };
    const cx = tr.box.cx;
    const direction = cx < 0.38 ? 'left' : cx > 0.62 ? 'right' : 'ahead';
    this.onAlert({ label: tr.label, name: cls.name, direction, ttc: Math.round(ttc * 10) / 10, rank: cls.rank });
  }

  _addSample(tr, d, t) {
    const w = d.x2 - d.x1, h = d.y2 - d.y1;
    const size = Math.sqrt(Math.max(w * h, 1e-6));
    const cx = (d.x1 + d.x2) / 2;
    tr.box = { ...d, cx };
    tr.lastSeen = t;
    tr.samples.push({ t, size, ls: Math.log(size), cx });
    while (tr.samples.length && t - tr.samples[0].t > WINDOW_S) tr.samples.shift();
  }
}
