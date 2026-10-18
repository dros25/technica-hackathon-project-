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

import { FilesetResolver, ImageClassifier, ObjectDetector } from '@mediapipe/tasks-vision';

// Keep the wasm version identical to the npm package version above.
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';
// Second, finer model (1,000 categories: "tiger", "water bottle"...). Runs only on the box being warned about.
const CLASSIFIER_URL =
  'https://storage.googleapis.com/mediapipe-models/image_classifier/efficientnet_lite0/float32/1/efficientnet_lite0.tflite';

// The detector knows 80 everyday categories. These get special timing/priority/names;
// everything else uses DEFAULT_CLASS and a tidied-up version of its label.
// ttc = seconds-to-contact that triggers an alert. rank = priority (higher wins).
// refine = let the fine classifier rename it ("cat" -> "tiger"); off for people, vehicles,
// and dogs (it would read out breed names).
const CLASSES = {
  car:          { name: 'Car',       ttc: 3.0, rank: 3, refine: false },
  bus:          { name: 'Bus',       ttc: 3.0, rank: 3, refine: false },
  truck:        { name: 'Truck',     ttc: 3.0, rank: 3, refine: false },
  train:        { name: 'Train',     ttc: 3.0, rank: 3, refine: false },
  motorcycle:   { name: 'Motorbike', ttc: 3.0, rank: 3, refine: false },
  bicycle:      { name: 'Bike',      ttc: 3.0, rank: 3, refine: false },
  person:       { name: 'Person',    ttc: 2.0, rank: 2, refine: false },
  dog:          { name: 'Dog',       ttc: 2.0, rank: 2, refine: false },
  horse:        { name: 'Horse',     ttc: 2.5, rank: 2 },
  cow:          { name: 'Cow',       ttc: 2.5, rank: 2 },
  bear:         { name: 'Bear',      ttc: 2.5, rank: 2 },
  elephant:     { name: 'Elephant',  ttc: 2.5, rank: 2 },
  cat:          { name: 'Cat',       ttc: 2.0, rank: 2 },
  skateboard:   { name: 'Skateboard', ttc: 2.0, rank: 2 },
  'sports ball': { name: 'Ball',     ttc: 1.5, rank: 1 },
  'dining table': { name: 'Table',   ttc: 1.5, rank: 1 },
  'potted plant': { name: 'Plant',   ttc: 1.5, rank: 1 },
  'cell phone': { name: 'Phone',     ttc: 1.5, rank: 1 },
  tv:           { name: 'TV',        ttc: 1.5, rank: 1 },
};
const DEFAULT_CLASS = { ttc: 1.5, rank: 1 };
const REFINE_MIN_SCORE = 0.3;    // classifier must be at least this sure to rename something

function classInfo(label) {
  const known = CLASSES[label];
  if (known) return { refine: true, ...known };
  const name = label.charAt(0).toUpperCase() + label.slice(1);
  return { ...DEFAULT_CLASS, name, refine: true };
}

// "tiger, Panthera tigris" -> "Tiger"
function tidyLabel(raw) {
  const first = String(raw || '').split(',')[0].replace(/_/g, ' ').trim();
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : '';
}

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
    this.classifier = null;
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
    if (!this.classifier && !this.classifierLoading) this._loadClassifier(); // in the background
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
    });
    try {
      return await ObjectDetector.createFromOptions(vision, opts('GPU'));
    } catch (e) {
      console.warn('[hazard] GPU unavailable, using CPU', e);
      return ObjectDetector.createFromOptions(vision, opts('CPU'));
    }
  }

  // Optional: if it fails, warnings just use the detector's own (coarser) names
  async _loadClassifier() {
    this.classifierLoading = true;
    try {
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: CLASSIFIER_URL, delegate },
        runningMode: 'IMAGE',
        maxResults: 1,
        scoreThreshold: REFINE_MIN_SCORE,
      });
      try {
        this.classifier = await ImageClassifier.createFromOptions(vision, opts('GPU'));
      } catch (e) {
        this.classifier = await ImageClassifier.createFromOptions(vision, opts('CPU'));
      }
    } catch (e) {
      console.warn('[hazard] fine classifier unavailable, using detector names only', e);
    } finally {
      this.classifierLoading = false;
    }
  }

  // Look closer at one box (~10-30 ms): "Cat" -> "Tiger", "Bottle" -> "Water bottle"
  _refine(tr, cls) {
    if (!this.classifier || !cls.refine || tr.refinedName !== undefined) return tr.refinedName || cls.name;
    tr.refinedName = null;
    try {
      const pad = 0.05;
      const b = tr.box;
      const roi = {
        left: Math.max(0, b.x1 - pad), top: Math.max(0, b.y1 - pad),
        right: Math.min(1, b.x2 + pad), bottom: Math.min(1, b.y2 + pad),
      };
      const res = this.classifier.classify(this.video, { regionOfInterest: roi });
      const top = res.classifications && res.classifications[0] && res.classifications[0].categories[0];
      if (top && top.score >= REFINE_MIN_SCORE) {
        const name = tidyLabel(top.displayName || top.categoryName);
        if (name && name.length <= 24) tr.refinedName = name;
      }
    } catch (e) {
      console.warn('[hazard] refine failed', e);
    }
    return tr.refinedName || cls.name;
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
      if (!cat || !cat.categoryName || cat.score < MIN_SCORE) continue;
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

      const cls = classInfo(tr.label);
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
    const name = this._refine(tr, cls);
    this.onAlert({ label: tr.label, name, direction, ttc: Math.round(ttc * 10) / 10, rank: cls.rank });
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
