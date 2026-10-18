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
import { LoomingDetector } from './looming';

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
  car:          { name: 'Car',       ttc: 3.5, rank: 3, refine: false },
  bus:          { name: 'Bus',       ttc: 3.5, rank: 3, refine: false },
  truck:        { name: 'Truck',     ttc: 3.5, rank: 3, refine: false },
  train:        { name: 'Train',     ttc: 3.5, rank: 3, refine: false },
  motorcycle:   { name: 'Motorbike', ttc: 3.5, rank: 3, refine: false },
  bicycle:      { name: 'Bike',      ttc: 3.5, rank: 3, refine: false },
  person:       { name: 'Person',    ttc: 2.5, rank: 2, refine: false },
  dog:          { name: 'Dog',       ttc: 2.5, rank: 2, refine: false },
  horse:        { name: 'Horse',     ttc: 3.0, rank: 2 },
  cow:          { name: 'Cow',       ttc: 3.0, rank: 2 },
  bear:         { name: 'Bear',      ttc: 3.0, rank: 2 },
  elephant:     { name: 'Elephant',  ttc: 3.0, rank: 2 },
  cat:          { name: 'Cat',       ttc: 2.5, rank: 2 },
  skateboard:   { name: 'Skateboard', ttc: 2.5, rank: 2 },
  'sports ball': { name: 'Ball',     ttc: 1.8, rank: 1 },
  'dining table': { name: 'Table',   ttc: 1.5, rank: 1 },
  'potted plant': { name: 'Plant',   ttc: 1.5, rank: 1 },
  'cell phone': { name: 'Phone',     ttc: 1.5, rank: 1 },
  tv:           { name: 'TV',        ttc: 1.5, rank: 1 },
};
const DEFAULT_CLASS = { ttc: 2.0, rank: 1 };
const REFINE_MIN_SCORE = 0.3;    // classifier must be at least this sure to rename something
// Plain names that are already what a blind walker needs; others may get a Gemini follow-up name
const PLAIN_LABELS = new Set(['person', 'car', 'bus', 'truck', 'train', 'motorcycle', 'bicycle', 'dog']);

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
const MIN_SCORE_NEW = 0.45;     // confidence to start tracking something new
const MIN_SCORE_KEEP = 0.25;    // lower bar to keep following something already tracked (less flicker)
const MIN_FRAME_GAP_MS = 0;     // process every new camera frame: lowest latency
const WINDOW_S = 0.4;           // history used to measure growth
const MIN_SAMPLES = 3;
const MIN_SPAN_S = 0.12;
const MIN_SIZE = 0.05;          // ignore tiny boxes (sqrt of area fraction) - too noisy
const MATCH_IOU = 0.2;          // same object across frames (or close centers, see _match)
const TRACK_TIMEOUT_MS = 600;   // keep following through brief detection dropouts
const CONFIRM_FRAMES = 2;       // threat must hold this many frames in a row...
const URGENT_FRACTION = 0.6;    // ...unless contact is this much sooner than the limit: then 1 frame
const SMOOTH = 0.5;             // box smoothing for display and direction (0 = none, 1 = frozen)

// Model-free looming check (catches things the detector can't name)
const LOOM_EVERY = 2;           // run on every 2nd frame (~15 Hz) to save battery
const LOOM_TTC = [1.4, 2.2, 1.4];  // left / center / right limits; it reads ~20% late, so set higher
const LOOM_CONFIRM = 2;
const LOOM_COOLDOWN_MS = 3000;
const LOOM_DEDUPE_MS = 1500;    // skip if the detector just warned about the same thing
const TRACK_COOLDOWN_MS = 4000; // don't repeat for the same object
const GLOBAL_GAP_MS = 1200;     // min gap between any two alerts (unless more urgent)
const CENTER_BAND = [0.3, 0.7]; // "in front of you" (fraction of frame width)
const STALL_MS = 2500;          // no frames for this long = camera/model stalled

// Gentler heads-up, before anything counts as a collision threat, said once per object:
//  - a person (or dog, bike) walking toward you: "Someone is coming toward you"
//  - anything else in your path that you are walking toward (chair, table, bench...): "Chair in your path"
// Getting closer = its box grows, whether it moves or you do; standing still says nothing.
const NOTICE_LABELS = { person: 'Someone', dog: 'A dog', bicycle: 'A bike', cat: 'A cat' };
const NOTICE_TTC = 6.0;         // approaching: contact within this many seconds at this pace
const NOTICE_MIN_SIZE = 0.12;   // and already a fair size in view (not far down the hall)
const PATH_TTC = 20;            // objects in your path: any steady approach counts (distance decides, not speed)
const PATH_MIN_SIZE = 0.09;     // and big enough in view to be a few steps away (not across the room)
const PATH_BAND = [0.35, 0.65]; // must overlap the middle of the view (where you're heading)
const PATH_NEAR_SIZE = 0.24;    // this big in view = about one step away: "right in front of you"
const NOTICE_FRAMES = 5;        // held this many frames in a row (~0.2 s), so a sway doesn't count
const NOTICE_COOLDOWN_MS = 8000;
const STAGE_GAP_MS = 1500;      // "a few steps" -> "right in front of you": at least this far apart

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
}

// How well a detection continues a track: overlap, or a nearby center at a similar size
function matchScore(tr, d) {
  const o = iou(tr.raw, d);
  if (o >= MATCH_IOU) return o;
  const a = tr.raw;
  const aw = a.x2 - a.x1, ah = a.y2 - a.y1, dw = d.x2 - d.x1, dh = d.y2 - d.y1;
  const dist = Math.hypot((a.x1 + a.x2 - d.x1 - d.x2) / 2, (a.y1 + a.y2 - d.y1 - d.y2) / 2);
  const ratio = (dw * dh) / Math.max(aw * ah, 1e-6);
  if (dist < 0.5 * Math.max(aw, ah) && ratio > 0.5 && ratio < 2) return 0.1;
  return 0;
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
    this.loom = new LoomingDetector();
    this.loomHits = [0, 0, 0];
    this.loomAlertAt = [0, 0, 0];
    this.loomZones = null;
    this.frameNo = 0;
    this.lastDetectorAlert = { at: 0, direction: '' };
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
    this.loom.reset();
    this.loomHits = [0, 0, 0];
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
      scoreThreshold: MIN_SCORE_KEEP,
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
      } catch {
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
      const b = tr.raw || tr.box;
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
        this.frameNo += 1;
        if (this.frameNo % LOOM_EVERY === 0) {
          try {
            this.loomZones = this.loom.update(this.loom.grab(v), now / 1000);
            if (this.loomZones) this._processLoom(this.loomZones);
          } catch (e) {
            console.warn('[hazard] looming check failed', e);
          }
        }
        this._process(res.detections || [], v.videoWidth, v.videoHeight, now / 1000);
        this._recordStats(performance.now() - now);
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
      if (!cat || !cat.categoryName || cat.score < MIN_SCORE_KEEP) continue;
      const b = d.boundingBox;
      dets.push({
        label: cat.categoryName,
        score: cat.score,
        x1: b.originX / vw, y1: b.originY / vh,
        x2: (b.originX + b.width) / vw, y2: (b.originY + b.height) / vh,
      });
    }

    // 2. Match detections to existing tracks (greedy, best overlap first, same label only)
    const pairs = [];
    this.tracks.forEach((tr, ti) => dets.forEach((d, di) => {
      if (tr.label !== d.label) return;
      const o = matchScore(tr, d);
      if (o > 0) pairs.push([o, ti, di]);
    }));
    pairs.sort((a, b) => b[0] - a[0]);
    const usedT = new Set(), usedD = new Set();
    for (const [, ti, di] of pairs) {
      if (usedT.has(ti) || usedD.has(di)) continue;
      usedT.add(ti); usedD.add(di);
      this._addSample(this.tracks[ti], dets[di], t);
    }
    dets.forEach((d, di) => {
      if (usedD.has(di) || d.score < MIN_SCORE_NEW) return; // weak + unknown = probably noise
      const tr = { id: this.nextId++, label: d.label, samples: [], hits: 0, alertedAt: 0, seen: 0 };
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
      const inPath = x1 < PATH_BAND[1] && x2 > PATH_BAND[0];
      if (NOTICE_LABELS[tr.label] && onCourse && size >= NOTICE_MIN_SIZE && ttc < NOTICE_TTC * this.sensitivity) {
        tr.noticeHits = (tr.noticeHits || 0) + 1;
      } else if (!NOTICE_LABELS[tr.label] && inPath && size >= PATH_MIN_SIZE && ttc < PATH_TTC * this.sensitivity) {
        // how close: stage 1 = a few steps away, stage 2 = about one step (said again when it gets there)
        const stage = size >= PATH_NEAR_SIZE ? 2 : 1;
        tr.noticeHits = stage === tr.noticeStageSeen ? (tr.noticeHits || 0) + 1 : 1;
        tr.noticeStageSeen = stage;
      } else {
        tr.noticeHits = 0;
      }
      if (onCourse && ttc < limit) {
        tr.hits += 1;
        tr.threat = tr.hits >= CONFIRM_FRAMES || ttc < URGENT_FRACTION * limit;
      } else {
        tr.hits = 0;
      }
      if (tr.threat) {
        const urgency = cls.rank * 10 + limit / ttc;
        if (!best || urgency > best.urgency) best = { tr, cls, ttc, urgency };
      }
    }

    if (this.onFrame) this.onFrame({ tracks: this.tracks, vw, vh, loom: this.loomZones });

    // 4. Decide whether to alert
    if (!best) { this._maybeNotice(); return; }
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
    this.lastDetectorAlert = { at: nowMs, direction };
    this.onAlert({
      label: tr.label, name, direction, ttc: Math.round(ttc * 10) / 10, rank: cls.rank,
      // Not a plain name and the fine classifier didn't help: ask Gemini for the exact name
      needsName: !PLAIN_LABELS.has(tr.label) && !tr.refinedName,
      region: { x1: tr.raw.x1, y1: tr.raw.y1, x2: tr.raw.x2, y2: tr.raw.y2 },
    });
  }

  // No collision threat: maybe a calm "someone is coming toward you"
  _maybeNotice() {
    const nowMs = performance.now();
    if (nowMs - this.lastAlert.at < GLOBAL_GAP_MS) return;
    const tr = this.tracks.find((t) => {
      if ((t.noticeHits || 0) < NOTICE_FRAMES) return false;
      if (nowMs - (t.alertedAt || -1e9) < NOTICE_COOLDOWN_MS) return false; // just got the urgent warning
      const stage = NOTICE_LABELS[t.label] ? 1 : (t.noticeStageSeen || 1);
      if (stage > (t.noticedStage || 0)) return nowMs - (t.noticedAt || -1e9) > STAGE_GAP_MS; // got closer
      return nowMs - (t.noticedAt || -1e9) > NOTICE_COOLDOWN_MS * 2; // same distance: only rarely again
    });
    if (!tr) return;
    const stage = NOTICE_LABELS[tr.label] ? 1 : (tr.noticeStageSeen || 1);
    tr.noticedStage = Math.max(tr.noticedStage || 0, stage);
    tr.noticedAt = nowMs;
    this.lastAlert = { at: nowMs, rank: 0 };
    const cx = tr.box.cx;
    const direction = cx < 0.38 ? 'left' : cx > 0.62 ? 'right' : 'ahead';
    const moving = !!NOTICE_LABELS[tr.label];
    const name = moving ? NOTICE_LABELS[tr.label] : (tr.refinedName || classInfo(tr.label).name);
    this.onAlert({ kind: moving ? 'notice' : 'path', near: stage === 2, label: tr.label, name, direction, rank: 0, needsName: false });
  }

  // Something is expanding fast in a zone, whatever it is: warn first, name it after
  _processLoom(zones) {
    const nowMs = performance.now();
    let best = null;
    zones.forEach((z, i) => {
      const limit = LOOM_TTC[i] * this.sensitivity;
      z.limit = limit;
      if (z.ttc < limit) {
        this.loomHits[i] += 1;
        z.threat = this.loomHits[i] >= LOOM_CONFIRM || z.ttc < URGENT_FRACTION * limit;
      } else {
        this.loomHits[i] = 0;
        z.threat = false;
      }
      if (z.threat && (!best || z.ttc / limit < best.z.ttc / best.limit)) best = { z, i, limit };
    });
    if (!best) return;
    const { z, i } = best;
    const direction = ['left', 'ahead', 'right'][i];
    if (nowMs - this.loomAlertAt[i] < LOOM_COOLDOWN_MS) return;
    if (nowMs - this.lastDetectorAlert.at < LOOM_DEDUPE_MS) return; // detector already named it
    const RANK = 2;
    if (nowMs - this.lastAlert.at < GLOBAL_GAP_MS && RANK <= this.lastAlert.rank) return;
    this.loomAlertAt[i] = nowMs;
    this.lastAlert = { at: nowMs, rank: RANK };
    const r = 0.22; // region around the expanding spot, for naming
    this.onAlert({
      label: 'unknown', name: 'Something', direction, ttc: Math.round(z.ttc * 10) / 10, rank: RANK,
      needsName: true,
      region: { x1: Math.max(0, z.cx - r), y1: Math.max(0, z.cy - r), x2: Math.min(1, z.cx + r), y2: Math.min(1, z.cy + r) },
    });
  }

  _addSample(tr, d, t) {
    const w = d.x2 - d.x1, h = d.y2 - d.y1;
    const size = Math.sqrt(Math.max(w * h, 1e-6));
    tr.raw = { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 };
    // Smoothed box for drawing and direction (growth uses the raw sizes, fitted over time)
    const p = tr.box;
    const mix = (a, b) => (p ? SMOOTH * a + (1 - SMOOTH) * b : b);
    const box = p
      ? { x1: mix(p.x1, d.x1), y1: mix(p.y1, d.y1), x2: mix(p.x2, d.x2), y2: mix(p.y2, d.y2) }
      : { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 };
    box.cx = (box.x1 + box.x2) / 2;
    tr.box = box;
    tr.seen = (tr.seen || 0) + 1;
    const cx = (d.x1 + d.x2) / 2;
    tr.lastSeen = t;
    tr.samples.push({ t, size, ls: Math.log(size), cx });
    while (tr.samples.length && t - tr.samples[0].t > WINDOW_S) tr.samples.shift();
  }
}
