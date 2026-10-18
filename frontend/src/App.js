import React, { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';
import { HazardWatcher, SENSITIVITY } from './hazard';

// Same-origin by default: Flask serves the built app, so one ngrok https link works for everything.
// During `npm start`, package.json "proxy" forwards these calls to Flask on port 5000.
const API = process.env.REACT_APP_API_URL || '';

// ngrok's free plan replaces responses with a warning page unless this header is sent
const api = (path, options = {}) =>
  fetch(`${API}${path}`, {
    ...options,
    headers: { 'ngrok-skip-browser-warning': 'true', ...(options.headers || {}) },
  });

const LIVE_INTERVAL_MS = 2500;   // how often live mode checks the camera
const LIVE_CHANGE = 12;          // how different a frame must be (0-255) to send it
const LIVE_RECHECK_MS = 20000;   // re-check even an unchanged scene this often
const HOVER_REPEAT_MS = 1500;    // don't repeat the same hover label too quickly
const QUIET_AFTER_HAZARD_MS = 3000; // live narration waits this long after a hazard alert

// Spoken the moment something happens, so they're generated ahead of time in the chosen voice
const HAZARD_NAMES = ['Car', 'Bus', 'Truck', 'Motorbike', 'Bike', 'Person', 'Dog'];
const ALERT_PHRASES = [
  "Fall detected. The alarm will sound in 30 seconds. Double-click your button, or tap I'm okay, to cancel.",
  "Alarm on. Asking people nearby for help. Double-click your button, or tap I'm okay, to stop it.",
  '20 seconds.', '10 seconds.', '5 seconds.',
  "Okay, glad you're safe.",
  ...HAZARD_NAMES.flatMap((n) => [`${n} ahead!`, `${n}, left!`, `${n}, right!`]),
];

function loadSetting(key, fallback) {
  try {
    const v = localStorage.getItem('guardian.' + key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function saveSetting(key, value) {
  try { localStorage.setItem('guardian.' + key, JSON.stringify(value)); } catch { /* private mode */ }
}

function grabFrame(video, maxWidth) {
  if (!video || !video.videoWidth) return null;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Tiny grayscale thumbnail used to notice when the scene changes
function frameSignature(video) {
  const c = grabFrame(video, 32);
  if (!c) return null;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const out = new Array(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (d[i] + d[i + 1] + d[i + 2]) / 3;
  return out;
}
function frameDifference(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}


// ---------- Icons and decoration (all hidden from screen readers) ----------
const iconProps = {
  viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
};
const GearIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
const CameraIcon = () => (
  <svg {...iconProps} width={18} height={18}>
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);
const SpeakerIcon = () => (
  <svg {...iconProps}>
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
  </svg>
);
const HandIcon = () => (
  <svg {...iconProps}>
    <path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8" />
    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L6 15" />
  </svg>
);
const SonarIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="2" />
    <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 19.1a10 10 0 0 0 0-14.2" />
  </svg>
);

// Seaweed, small fish and bubbles drifting behind the app. Purely decorative.
const Fish = ({ x, y, s = 1, flip = false, className }) => (
  <g className={className} transform={`translate(${x} ${y}) scale(${flip ? -s : s} ${s})`}>
    <path d="M0 0c6-7 16-8 24-3l7-5v16l-7-5C16 8 6 7 0 0z" />
    <circle cx="7" cy="-1.5" r="1.4" className="fish-eye" />
  </g>
);
const Weed = ({ d, className = 'weed' }) => <path className={className} d={d} />;
function SeaDecor() {
  return (
    <div className="sea-decor" aria-hidden="true">
      <svg className="decor-left" viewBox="0 0 160 260" preserveAspectRatio="xMinYMax meet">
        <Weed d="M30 260C18 220 42 190 28 150S40 90 30 50" />
        <Weed className="weed weed-b" d="M58 260C50 225 70 205 60 170S72 120 64 95" />
        <Weed className="weed weed-c" d="M12 260C6 240 20 225 12 205" />
        <circle className="bubble" cx="96" cy="120" r="7" />
        <circle className="bubble" cx="110" cy="92" r="4" />
        <circle className="bubble" cx="88" cy="60" r="5" />
      </svg>
      <svg className="decor-right" viewBox="0 0 160 260" preserveAspectRatio="xMaxYMax meet">
        <Weed d="M130 260C142 222 118 196 132 160S122 110 130 80" />
        <Weed className="weed weed-b" d="M104 260C112 232 94 214 104 186" />
        <circle className="bubble" cx="60" cy="150" r="6" />
        <circle className="bubble" cx="74" cy="118" r="3.5" />
      </svg>
      <svg className="decor-fish fish-pos-a" viewBox="-2 -12 38 24">
        <Fish x={34} y={0} flip className="fish fish-a" />
      </svg>
      <svg className="decor-fish fish-pos-b" viewBox="-2 -12 38 24">
        <Fish x={0} y={0} className="fish fish-b" />
      </svg>
      <svg className="decor-bubbles" viewBox="0 0 40 60">
        <circle className="bubble" cx="20" cy="48" r="7" />
        <circle className="bubble" cx="30" cy="24" r="4.5" />
        <circle className="bubble" cx="14" cy="8" r="3" />
      </svg>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState('tap'); // 'tap' | 'live'
  const [caption, setCaption] = useState("Tap the camera view to hear what's ahead of you.");
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(null);
  const [wearable, setWearable] = useState({ connected: true, mock: false });
  const [fall, setFall] = useState(null); // null | 'pending' (countdown) | 'alarm'
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [fallDetection, setFallDetection] = useState(() => loadSetting('fallDetection', true));
  const [cameraReady, setCameraReady] = useState(false);
  const [readAloud, setReadAloud] = useState(() => loadSetting('readAloud', true));
  const [premiumVoice, setPremiumVoice] = useState(() => loadSetting('premiumVoice', true));
  const [line1, setLine1] = useState(() => loadSetting('line1', 'Low vision'));
  const [line2, setLine2] = useState(() => loadSetting('line2', 'Thanks for help'));
  const [hazardOn, setHazardOn] = useState(() => loadSetting('hazardOn', true));
  const [sensitivity, setSensitivity] = useState(() => loadSetting('sensitivity', 'normal'));
  const [showBoxes, setShowBoxes] = useState(() => loadSetting('showBoxes', true));
  const [voices, setVoices] = useState([]);
  const [voiceId, setVoiceId] = useState(() => loadSetting('voiceId', ''));
  const [cameraSource, setCameraSource] = useState(() => loadSetting('cameraSource', 'phone')); // phone | wearable
  const [wearableCam, setWearableCam] = useState(null); // /camera/status result
  const [hazardState, setHazardState] = useState('off'); // off | loading | on | stalled | error
  const [hazardStats, setHazardStats] = useState(null);  // { latencyMs, fps }

  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const settingsRef = useRef(null);
  const watcherRef = useRef(null);
  const audioCtxRef = useRef(null);
  const lastHazardRef = useRef(0);
  const showBoxesRef = useRef(showBoxes);
  const audioRef = useRef(null);
  const busyRef = useRef(false);
  const fallRef = useRef(null);
  const fallDeadlineRef = useRef(0);
  const fallSpokenRef = useRef(new Set());
  const fallDetectionRef = useRef(fallDetection);
  const readAloudRef = useRef(readAloud);
  const premiumRef = useRef(premiumVoice);
  const cameraMsgRef = useRef('The camera is starting. Try again in a moment.');
  const speechRef = useRef({ id: 0, priority: null });
  const voiceRef = useRef(voiceId);
  const ttsRef = useRef(new Map());      // "voice|text" -> Promise<audio URL>
  const ttsReadyRef = useRef(new Set()); // keys whose audio is already downloaded
  const cameraSourceRef = useRef(cameraSource);
  const lastHoverRef = useRef({ text: '', at: 0 });
  const liveRef = useRef({ text: '', at: 0, sig: null });

  useEffect(() => { readAloudRef.current = readAloud; saveSetting('readAloud', readAloud); }, [readAloud]);
  useEffect(() => { premiumRef.current = premiumVoice; saveSetting('premiumVoice', premiumVoice); }, [premiumVoice]);
  useEffect(() => { fallRef.current = fall; }, [fall]);
  useEffect(() => { saveSetting('hazardOn', hazardOn); }, [hazardOn]);
  useEffect(() => { showBoxesRef.current = showBoxes; saveSetting('showBoxes', showBoxes); }, [showBoxes]);
  useEffect(() => {
    saveSetting('sensitivity', sensitivity);
    if (watcherRef.current) watcherRef.current.setSensitivity(SENSITIVITY[sensitivity] || 1);
  }, [sensitivity]);

  // ---------- Speech ----------
  // Priorities: "urgent" = hazard warnings (interrupt everything, nothing interrupts them).
  // "high" = narration and alerts. "low" = hover labels (never interrupts high or urgent).
  // With the natural voice on, every phrase is spoken by ElevenLabs and cached (here and on
  // the server), so repeated labels and alerts cost nothing after the first time.
  // speechRef.priority stays set while a phrase is loading or playing.
  const isPlayingAudio = () => audioRef.current && !audioRef.current.paused;
  const urgentSpeaking = () => speechRef.current.priority === 'urgent';

  const b64ToUrl = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
  };

  // Natural-voice audio for a phrase: Promise<objectURL>, cached per voice + text
  const naturalAudio = useCallback((text) => {
    const key = `${voiceRef.current}|${text}`;
    const cache = ttsRef.current;
    if (!cache.has(key)) {
      const p = api('/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice_id: voiceRef.current }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (!d.audio) throw new Error('no audio');
          const url = b64ToUrl(d.audio);
          ttsReadyRef.current.add(key);
          return url;
        })
        .catch((e) => { cache.delete(key); throw e; });
      cache.set(key, p);
    }
    return cache.get(key);
  }, []);

  const stopAll = () => {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (audioRef.current) audioRef.current.pause();
  };

  const deviceSay = (text, priority, id) => {
    const synth = window.speechSynthesis;
    if (!synth) { if (speechRef.current.id === id) speechRef.current.priority = null; return; }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = priority === 'urgent' ? 1.25 : 1.05;
    u.onend = () => { if (speechRef.current.id === id) speechRef.current.priority = null; };
    synth.speak(u);
  };

  const playUrl = (url, text, priority, id) => {
    const audio = audioRef.current;
    if (!audio) return deviceSay(text, priority, id);
    audio.onended = () => { if (speechRef.current.id === id) speechRef.current.priority = null; };
    audio.src = url;
    audio.playbackRate = priority === 'urgent' ? 1.15 : 1;
    audio.play().catch(() => { if (speechRef.current.id === id) deviceSay(text, priority, id); });
  };

  const speak = useCallback((text, priority = 'high') => {
    if (!text) return;
    const s = speechRef.current;
    if (priority === 'low' && s.priority && s.priority !== 'low') return;
    if (priority === 'high' && s.priority === 'urgent') return; // never talk over a hazard warning
    stopAll();
    const id = ++s.id;
    s.priority = priority;
    if (!premiumRef.current) return deviceSay(text, priority, id);

    const key = `${voiceRef.current}|${text}`;
    // Hazard warnings can't wait for the network: natural voice only if it's already cached
    if (priority === 'urgent' && !ttsReadyRef.current.has(key)) {
      naturalAudio(text).catch(() => {}); // ready for next time
      return deviceSay(text, priority, id);
    }
    const waitMs = priority === 'low' ? 1500 : 4000;
    Promise.race([
      naturalAudio(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), waitMs)),
    ])
      .then((url) => { if (speechRef.current.id === id) playUrl(url, text, priority, id); })
      .catch(() => {
        if (speechRef.current.id !== id) return;
        if (priority === 'low') speechRef.current.priority = null; // skip a slow hover label
        else deviceSay(text, priority, id);                         // never drop an alert
      });
  }, [naturalAudio]);

  // Narration that already came back with natural-voice audio
  const playAudio = useCallback((b64, fallbackText) => {
    const s = speechRef.current;
    if (s.priority === 'urgent') return; // a hazard warning is playing; the caption still shows the text
    stopAll();
    const id = ++s.id;
    s.priority = 'high';
    playUrl(b64ToUrl(b64), fallbackText, 'high', id);
  }, []);

  const stopSpeaking = useCallback(() => {
    speechRef.current.id += 1;
    speechRef.current.priority = null;
    stopAll();
  }, []);

  // ---------- Voices ----------
  useEffect(() => {
    api('/voices')
      .then((r) => r.json())
      .then((d) => {
        setVoices(d.voices || []);
        if (!voiceRef.current && d.default) { voiceRef.current = d.default; setVoiceId(d.default); }
      })
      .catch(() => {});
  }, []);

  // Pre-make the alerts that must play instantly, in the chosen voice
  useEffect(() => {
    voiceRef.current = voiceId;
    saveSetting('voiceId', voiceId);
    if (!voiceId || !premiumVoice) return;
    const t = setTimeout(() => {
      ALERT_PHRASES.forEach((p, i) => setTimeout(() => naturalAudio(p).catch(() => {}), i * 150));
    }, 1500);
    return () => clearTimeout(t);
  }, [voiceId, premiumVoice, naturalAudio]);

  const previewVoice = (v) => {
    stopSpeaking();
    if (v && v.preview_url) {
      // ElevenLabs' own sample clip: costs no credits
      const a = audioRef.current;
      a.src = v.preview_url;
      a.play().catch(() => speak(`Hi, I'm ${v.name}.`));
    } else if (v) {
      speak(`Hi, I'm ${v.name}. This is how I'll sound.`);
    }
  };

  const voiceLabel = (v) => {
    const bits = [v.gender, v.accent, v.description].filter(Boolean).join(', ');
    return bits ? `${v.name} (${bits})` : v.name;
  };

  // Read a control's label when the mouse rests on it or keyboard focus lands on it
  const hover = useCallback((label) => {
    const say = () => {
      if (!readAloudRef.current) return;
      const last = lastHoverRef.current;
      const now = Date.now();
      if (last.text === label && now - last.at < HOVER_REPEAT_MS) return;
      lastHoverRef.current = { text: label, at: now };
      speak(label, 'low');
    };
    return { onMouseEnter: say, onFocus: say };
  }, [speak]);

  // Instant warning tone: Web Audio starts in ~1 ms, speech can take 100-300 ms to begin
  const beep = useCallback((count = 1) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const start = ctx.currentTime;
    for (let i = 0; i < count; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 1100;
      gain.gain.value = 0.25;
      osc.connect(gain).connect(ctx.destination);
      const t = start + i * 0.18;
      osc.start(t);
      osc.stop(t + 0.11);
    }
  }, []);

  // Mobile browsers only allow sound after the first touch
  useEffect(() => {
    const unlock = () => {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx && !audioCtxRef.current) audioCtxRef.current = new Ctx();
        if (audioCtxRef.current) audioCtxRef.current.resume();
      } catch { /* no Web Audio: speech and vibration still work */ }
      if (audioRef.current) audioRef.current.play().catch(() => {});
      if (window.speechSynthesis) window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // ---------- Camera ----------
  // Phone camera only when it's the chosen source (the wearable webcam lives on the server)
  useEffect(() => {
    let stream;
    let cancelled = false;
    cameraSourceRef.current = cameraSource;
    saveSetting('cameraSource', cameraSource);
    if (cameraSource === 'wearable') {
      setCameraReady(false);
      api('/camera/status').then((r) => r.json()).then((st) => { if (!cancelled) setWearableCam(st); })
        .catch(() => { if (!cancelled) setWearableCam({ available: false, error: 'Server not reachable' }); });
      return () => { cancelled = true; };
    }
    if (!window.isSecureContext || !navigator.mediaDevices) {
      cameraMsgRef.current = 'The camera needs a secure link. Open the https link for this app.';
      setCaption(cameraMsgRef.current);
      return undefined;
    }
    // Modest resolution + high frame rate: the hazard watcher needs speed, not detail
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    })
      .then((s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
        setCameraReady(true);
      })
      .catch((err) => {
        console.error('Camera error:', err);
        cameraMsgRef.current = 'Camera access was blocked. Allow camera access for this site and reload.';
        setCaption(cameraMsgRef.current);
      });
    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      setCameraReady(false);
    };
  }, [cameraSource]);

  const chooseCamera = (next) => {
    if (next === cameraSource) return;
    setCameraSource(next);
    const msg = next === 'wearable'
      ? 'Using the wearable camera. Press your button to hear what is ahead.'
      : 'Using the phone camera.';
    setCaption(msg);
    speak(msg);
  };

  // ---------- Describe the scene ----------
  const describe = useCallback(async (kind = 'tap') => {
    if (busyRef.current) return;
    // Wearable camera: the server grabs the frame from the USB webcam plugged into it
    const fromWearable = cameraSourceRef.current === 'wearable';
    const canvas = fromWearable ? null : grabFrame(videoRef.current, 640);
    if (!fromWearable && !canvas) {
      if (kind === 'tap') { setCaption(cameraMsgRef.current); speak(cameraMsgRef.current); }
      return;
    }
    busyRef.current = true;
    setBusy(true);
    if (kind === 'tap') {
      setCaption('Looking…');
      if (navigator.vibrate) navigator.vibrate(60);
    }
    try {
      const form = new FormData();
      if (fromWearable) {
        form.append('source', 'wearable');
      } else {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
        form.append('image', blob, 'frame.jpg');
      }
      form.append('mode', kind);
      form.append('voice', premiumRef.current ? 'eleven' : 'device');
      form.append('voice_id', voiceRef.current || '');
      if (kind === 'live' && liveRef.current.text) form.append('previous', liveRef.current.text);

      const res = await api('/narrate', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({ error: `The server sent back something unexpected (${res.status}).` }));
      if (!res.ok || data.error) throw new Error(data.error || `Server error ${res.status}`);

      if (kind === 'live') {
        liveRef.current.at = Date.now();
        if (!data.text) return; // nothing new worth saying
        liveRef.current.text = data.text;
      }
      setCaption(data.text);
      if (data.audio) playAudio(data.audio, data.text);
      else speak(data.text);
    } catch (err) {
      console.error(err);
      if (kind === 'tap') {
        const msg = /daily limit/i.test(err.message || '')
          ? 'The scene describer has reached its daily limit.'
          : "Couldn't describe the scene. Check the connection and try again.";
        setCaption(`${msg} (${err.message || 'no details'})`); // details on screen help debugging
        speak(msg);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [speak, playAudio]);

  const describeRef = useRef(describe);
  useEffect(() => { describeRef.current = describe; }, [describe]);

  // ---------- Hazard watcher (on-device, no network) ----------
  const hazardStateRef = useRef('off');
  const hazardHandlersRef = useRef({});

  hazardHandlersRef.current.onAlert = (a) => {
    if (fallRef.current) return; // the fall alarm owns the screen and voice
    lastHazardRef.current = Date.now();
    const big = a.rank >= 3;
    beep(big ? 2 : 1);
    if (navigator.vibrate) navigator.vibrate(big ? [200, 80, 200, 80, 200] : [150, 60, 150]);
    const text = a.direction === 'ahead' ? `${a.name} ahead!` : `${a.name}, ${a.direction}!`;
    setCaption(text);
    speak(text, 'urgent');
  };

  hazardHandlersRef.current.onStatus = (state, detail) => {
    const prev = hazardStateRef.current;
    hazardStateRef.current = state;
    setHazardState(state);
    if (state === 'on' && prev === 'stalled') speak('Hazard watch resumed.');
    else if (state === 'stalled') {
      setCaption('Hazard watch paused: the camera stopped.');
      speak('Warning. Hazard watch paused. The camera stopped.', 'urgent');
    } else if (state === 'error') {
      console.error('[hazard] failed to start', detail);
      setCaption("Hazard watch couldn't start. Check the connection and reload.");
      speak("Hazard watch couldn't start.");
    }
    if (state !== 'on') setHazardStats(null);
  };

  // Draw boxes over the porthole (handles object-fit: cover cropping). Yellow = threat.
  hazardHandlersRef.current.draw = (frame) => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!frame || !showBoxesRef.current) return;
    const { vw, vh, tracks } = frame;
    const scale = Math.max(cw / vw, ch / vh);
    const dx = (cw - vw * scale) / 2, dy = (ch - vh * scale) / 2;
    ctx.font = '700 14px Atkinson Hyperlegible, sans-serif';
    for (const tr of tracks) {
      if (!tr.box) continue;
      const x = tr.box.x1 * vw * scale + dx, y = tr.box.y1 * vh * scale + dy;
      const w = (tr.box.x2 - tr.box.x1) * vw * scale, h = (tr.box.y2 - tr.box.y1) * vh * scale;
      const color = tr.threat ? '#ffd23f' : '#4ff0e2';
      ctx.strokeStyle = color;
      ctx.lineWidth = tr.threat ? 5 : 3;
      ctx.strokeRect(x, y, w, h);
      const label = tr.label + (tr.ttc ? ` ${tr.ttc.toFixed(1)}s` : '');
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 20, ctx.measureText(label).width + 10, 20);
      ctx.fillStyle = '#031b2e';
      ctx.fillText(label, x + 5, y - 5);
    }
  };

  // Hazard watch runs only in Live guide (and only if it's enabled in Settings)
  useEffect(() => {
    if (cameraSource === 'wearable') { // needs the phone camera's live video
      if (watcherRef.current && hazardStateRef.current !== 'off') watcherRef.current.stop();
      hazardHandlersRef.current.draw(null);
      return;
    }
    if (!cameraReady || !videoRef.current) return;
    if (!watcherRef.current) {
      watcherRef.current = new HazardWatcher({
        video: videoRef.current,
        onAlert: (a) => hazardHandlersRef.current.onAlert(a),
        onStatus: (s, d) => hazardHandlersRef.current.onStatus(s, d),
        onFrame: (f) => hazardHandlersRef.current.draw(f),
        onStats: (st) => setHazardStats(st),
      });
      watcherRef.current.setSensitivity(SENSITIVITY[sensitivity] || 1);
    }
    if (mode === 'live' && hazardOn) {
      watcherRef.current.start();
    } else if (hazardStateRef.current !== 'off') {
      watcherRef.current.stop();
      hazardHandlersRef.current.draw(null);
    }
  }, [cameraReady, hazardOn, mode, cameraSource]); // sensitivity is applied by its own effect

  useEffect(() => () => { if (watcherRef.current) watcherRef.current.stop(); }, []);

  // Keep the screen awake: if the phone sleeps, the camera stops and so does the watcher
  useEffect(() => {
    if (mode !== 'live' || !('wakeLock' in navigator)) return undefined;
    let lock = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const l = await navigator.wakeLock.request('screen');
        if (cancelled) l.release().catch(() => {});
        else lock = l;
      } catch { /* low battery mode etc. - the stall warning still covers us */ }
    };
    acquire();
    const onVisible = () => { if (document.visibilityState === 'visible') acquire(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (lock) lock.release().catch(() => {});
    };
  }, [mode]);

  // ---------- Live guide ----------
  useEffect(() => {
    if (mode !== 'live') return undefined;
    liveRef.current = { text: '', at: 0, sig: null };
    const timer = setInterval(() => {
      if (busyRef.current || fallRef.current || speechRef.current.priority || isPlayingAudio()) return;
      if (Date.now() - lastHazardRef.current < QUIET_AFTER_HAZARD_MS) return;
      // Wearable camera: the server checks whether the scene changed before calling the AI
      if (cameraSourceRef.current === 'wearable') { describeRef.current('live'); return; }
      const sig = frameSignature(videoRef.current);
      if (!sig) return;
      const changed = frameDifference(sig, liveRef.current.sig) > LIVE_CHANGE;
      const stale = Date.now() - liveRef.current.at > LIVE_RECHECK_MS;
      if (!changed && !stale) return;
      liveRef.current.sig = sig;
      describeRef.current('live');
    }, LIVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [mode]);

  const chooseMode = (next) => {
    if (next === mode) return;
    setMode(next);
    const msg = next === 'live'
      ? (hazardOn
        ? "Live guide on. I'll warn you if something comes at you fast, and speak when something new appears."
        : "Live guide on. I'll speak when something new appears.")
      : 'Tap mode on. Tap the camera view or press your button to hear what is ahead.';
    setCaption(msg);
    speak(msg);
  };

  // ---------- Fall countdown ----------
  const startCountdown = useCallback((seconds) => {
    fallDeadlineRef.current = Date.now() + seconds * 1000;
    fallSpokenRef.current = new Set();
    setSecondsLeft(seconds);
    setFall('pending');
    setCaption(`Fall detected. Alarm in ${seconds} seconds unless you cancel.`);
    speak(`Fall detected. The alarm will sound in ${seconds} seconds. Double-click your button, or tap I'm okay, to cancel.`);
  }, [speak]);

  const soundAlarm = useCallback(() => {
    if (fallRef.current === 'alarm') return;
    fallRef.current = 'alarm';
    setFall('alarm');
    setCaption('Alarm on. Your wearable is asking people nearby for help.');
    speak("Alarm on. Asking people nearby for help. Double-click your button, or tap I'm okay, to stop it.");
  }, [speak]);

  useEffect(() => {
    if (fall !== 'pending') return undefined;
    const tick = setInterval(() => {
      const left = Math.max(0, Math.ceil((fallDeadlineRef.current - Date.now()) / 1000));
      setSecondsLeft(left);
      const spoken = fallSpokenRef.current;
      if ((left === 20 || left === 10 || left === 5) && !spoken.has(left)) {
        spoken.add(left);
        speak(`${left} seconds.`);
      }
      // The wearable sends the alarm itself; this is a backup if that message is lost
      if (left === 0 && Date.now() - fallDeadlineRef.current > 2000) soundAlarm();
    }, 250);
    return () => clearInterval(tick);
  }, [fall, speak, soundAlarm]);

  // ---------- Fall detection on/off ----------
  const sendFallDetection = useCallback((on) => {
    api('/fall-detection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: on }),
    }).catch(() => {});
  }, []);

  const toggleFallDetection = (on) => {
    setFallDetection(on);
    fallDetectionRef.current = on;
    saveSetting('fallDetection', on);
    sendFallDetection(on);
    if (!on && fallRef.current) { setFall(null); stopSpeaking(); }
    const msg = on ? 'Fall detection on.' : 'Fall detection off.';
    setCaption(msg);
    speak(msg);
  };

  // ---------- Wearable events ----------
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const res = await api('/events');
        const data = await res.json();
        setOnline(true);
        setWearable({ connected: data.connected !== false, mock: !!data.mock });
        // Server or wearable restarted with a different setting: put the user's choice back
        if (typeof data.fall_detection === 'boolean' && data.fall_detection !== fallDetectionRef.current) {
          sendFallDetection(fallDetectionRef.current);
        }
        (data.events || []).forEach((ev) => {
          if (ev.type === 'button') {
            describeRef.current('tap');
          } else if (ev.type === 'fall_pending') {
            startCountdown(ev.seconds || 30);
          } else if (ev.type === 'fall') {
            soundAlarm();
          } else if (ev.type === 'cancel') {
            setFall(null);
            stopSpeaking();
            setCaption("Fall alert cancelled. Glad you're safe.");
            speak("Okay, glad you're safe.");
          } else if (ev.type === 'dark') {
            setCaption("It's getting dark around you. Take extra care.");
            speak("It's getting dark around you. Take extra care.");
          } else if (ev.type === 'disconnected') {
            setCaption('Wearable disconnected. Trying to reconnect.');
            speak('Wearable disconnected.');
          } else if (ev.type === 'reconnected') {
            setCaption('Wearable reconnected.');
            speak('Wearable reconnected.');
          }
        });
      } catch {
        setOnline(false);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [speak, stopSpeaking, startCountdown, soundAlarm, sendFallDetection]);

  const imOkay = async () => {
    setFall(null);
    stopSpeaking();
    setCaption("Fall alert cancelled. Glad you're safe.");
    speak("Okay, glad you're safe.");
    try { await api('/cancel', { method: 'POST' }); } catch { /* wearable button still works */ }
  };

  const saveDisplay = async () => {
    saveSetting('line1', line1);
    saveSetting('line2', line2);
    try {
      const res = await api('/lcd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line1, line2 }),
      });
      if (!res.ok) throw new Error();
      setCaption('Wearable display updated.');
      speak('Wearable display updated.');
    } catch {
      setCaption("Couldn't update the wearable display. Check the connection.");
      speak("Couldn't update the wearable display.");
    }
  };

  // ---------- Labels ----------
  const status = online === false
    ? { text: 'Offline', tone: 'alert' }
    : online === null
      ? { text: 'Connecting', tone: 'quiet' }
      : !wearable.connected
        ? { text: 'Wearable disconnected', tone: 'alert' }
        : wearable.mock
          ? { text: 'Demo wearable', tone: 'ok' }
          : { text: 'Wearable connected', tone: 'ok' };

  const hazardPill = {
    off: {
      text: cameraSource === 'wearable'
        ? 'Hazard watch: phone camera only'
        : hazardOn && mode !== 'live' ? 'Hazard watch: Live guide only' : 'Hazard watch off',
      tone: 'quiet',
    },
    loading: { text: 'Hazard watch starting', tone: 'quiet' },
    on: { text: hazardStats ? `Hazard watch on · ${hazardStats.latencyMs} ms` : 'Hazard watch on', tone: 'ok' },
    stalled: { text: 'Hazard watch paused', tone: 'alert' },
    error: { text: 'Hazard watch failed', tone: 'alert' },
  }[hazardState] || { text: 'Hazard watch off', tone: 'quiet' };

  const portholeLabel = busy
    ? 'Looking'
    : mode === 'live'
      ? 'Live guide is on. Tap for a full description'
      : 'Tap to describe what is ahead';

  const hasCamera = cameraReady || cameraSource === 'wearable';
  const liveTag = mode !== 'live'
    ? { text: 'Tap to describe', tone: 'quiet' }
    : cameraSource === 'wearable' || !hazardOn || hazardState === 'off'
      ? { text: 'Live', tone: 'live' }
      : hazardState === 'on'
        ? { text: 'Live, hazard watch on', tone: 'live' }
        : { text: hazardPill.text, tone: hazardPill.tone === 'alert' ? 'alert' : 'live' };

  const openSettings = () => {
    const d = settingsRef.current;
    if (!d) return;
    d.open = true;
    d.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const summary = d.querySelector('summary');
    if (summary) summary.focus({ preventScroll: true });
  };

  return (
    <div className={`app ${mode === 'live' ? 'is-live' : ''}`}>
      <SeaDecor />

      <header className="topbar">
        <div className="brand-wrap">
          <h1 className="brand">
            <span className="brand-tile" aria-hidden="true">
              <svg className="brand-mark" viewBox="0 0 32 32">
                {/* an eye above the waves: sight + sea */}
                <path d="M5 11c3-4.5 7-6.5 11-6.5s8 2 11 6.5c-3 4.5-7 6.5-11 6.5S8 15.5 5 11z" />
                <circle className="pupil" cx="16" cy="11" r="2.6" />
                <path d="M3 24c3.3 0 3.3-3 6.5-3s3.3 3 6.5 3 3.3-3 6.5-3 3.3 3 6.5 3" />
              </svg>
            </span>
            SightSea
          </h1>
          <p className="tagline">Your visual guide</p>
        </div>
        <div className="topbar-actions">
          <p className={`status status-${status.tone}`} {...hover(status.text)} tabIndex={0}>
            <span className="status-dot" aria-hidden="true" />
            {status.text}
          </p>
          <button type="button" className="settings-btn" onClick={openSettings} {...hover('Open settings')}>
            <GearIcon />
            <span>Settings</span>
          </button>
        </div>
      </header>

      <main className="stage">
        <div className={`viewport ${busy ? 'is-busy' : ''} ${hasCamera ? 'has-camera' : ''}`}>
          <button
            type="button"
            className="feed"
            onClick={() => describe('tap')}
            aria-label={portholeLabel}
            aria-busy={busy}
            autoFocus
            {...hover(portholeLabel)}
          >
            {/* The video stays mounted so the hazard watcher keeps its element */}
            <video ref={videoRef} autoPlay playsInline muted aria-hidden="true" hidden={cameraSource === 'wearable'} />
            {cameraSource === 'wearable' && (
              <img className="wearable-view" src={`${API}/camera/stream`} alt="" aria-hidden="true" />
            )}
            <canvas ref={overlayRef} className="overlay" aria-hidden="true" />
            <span className="feed-tags" aria-hidden="true">
              <span className={`tag tag-${liveTag.tone}`}>
                <i className="tag-dot" />
                {liveTag.text}
              </span>
              <span className="tag">
                <CameraIcon />
                {cameraSource === 'wearable' ? 'Wearable camera' : 'Phone camera'}
              </span>
            </span>
            {busy && <span className="feed-busy" aria-hidden="true">Looking…</span>}
          </button>

          <div className="caption" role="status" aria-live="polite">
            <span className="caption-icon" aria-hidden="true"><SpeakerIcon /></span>
            <span className="caption-body">
              <span className="caption-label" aria-hidden="true">SightSea</span>
              <span className="caption-text">{caption}</span>
            </span>
          </div>
        </div>

        <div className="modes" role="radiogroup" aria-label="How SightSea describes the scene">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'tap'}
            className="mode"
            onClick={() => chooseMode('tap')}
            {...hover('Tap mode. Describe the scene only when I ask')}
          >
            <span className="mode-icon" aria-hidden="true"><HandIcon /></span>
            <span className="mode-text">
              <span className="mode-title">Tap mode</span>
              <span className="mode-sub">Describe when I ask</span>
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'live'}
            className="mode"
            onClick={() => chooseMode('live')}
            {...hover('Live guide. Speak up whenever something new appears')}
          >
            <span className="mode-icon" aria-hidden="true"><SonarIcon /></span>
            <span className="mode-text">
              <span className="mode-title">Live guide</span>
              <span className="mode-sub">Speak when things change</span>
            </span>
          </button>
        </div>

        <details className="settings" ref={settingsRef}>
          <summary {...hover('Settings')}>Settings</summary>

          <label className="toggle" {...hover(`Hazard watch in Live guide. Warn me when something comes at me fast. ${hazardOn ? 'On' : 'Off'}`)}>
            <input type="checkbox" checked={hazardOn} onChange={(e) => {
              setHazardOn(e.target.checked);
              const msg = e.target.checked ? 'Hazard warnings on in Live guide.' : 'Hazard warnings off.';
              setCaption(msg);
              speak(msg);
            }} />
            <span>Hazard watch (Live guide): warn me when something comes at me fast</span>
          </label>

          <fieldset className="display-fields">
            <legend>Hazard warning sensitivity</legend>
            <p className="hint">Higher warns earlier, but may warn more often.</p>
            <div className="sensitivity" role="radiogroup" aria-label="Hazard warning sensitivity">
              {['low', 'normal', 'high'].map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={sensitivity === level}
                  className="mode sens"
                  onClick={() => setSensitivity(level)}
                  {...hover(`Sensitivity ${level}`)}
                >
                  <span className="mode-title">{level[0].toUpperCase() + level.slice(1)}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <label className="toggle" {...hover(`Show detection boxes on the camera. ${showBoxes ? 'On' : 'Off'}`)}>
            <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} />
            <span>Show detection boxes on the camera (for sighted helpers and demos)</span>
          </label>

          <label className="toggle" {...hover(`Read buttons aloud. ${readAloud ? 'On' : 'Off'}`)}>
            <input type="checkbox" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} />
            <span>Read buttons aloud when I point at them</span>
          </label>

          <label className="toggle" {...hover(`Fall detection. ${fallDetection ? 'On' : 'Off'}`)}>
            <input type="checkbox" checked={fallDetection} onChange={(e) => toggleFallDetection(e.target.checked)} />
            <span>Fall detection, with a 30 second countdown before the alarm</span>
          </label>

          <fieldset className="display-fields">
            <legend>Camera</legend>
            <div className="sensitivity two" role="radiogroup" aria-label="Which camera to use">
              <button
                type="button"
                role="radio"
                aria-checked={cameraSource === 'phone'}
                className="mode sens"
                onClick={() => chooseCamera('phone')}
                {...hover('Phone camera')}
              >
                <span className="mode-title">Phone</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={cameraSource === 'wearable'}
                className="mode sens"
                onClick={() => chooseCamera('wearable')}
                {...hover('Wearable camera')}
              >
                <span className="mode-title">Wearable</span>
              </button>
            </div>
            <p className="hint">
              {cameraSource === 'wearable'
                ? (wearableCam && !wearableCam.available
                  ? `Wearable camera not found: ${wearableCam.error || 'check that it is plugged into the laptop.'}`
                  : 'Press your button to hear what the wearable camera sees. Hazard watch needs the phone camera, so it pauses.')
                : 'Point your phone where you are walking.'}
            </p>
          </fieldset>

          <label className="toggle" {...hover(`Natural voice. ${premiumVoice ? 'On' : 'Off'}`)}>
            <input type="checkbox" checked={premiumVoice} onChange={(e) => setPremiumVoice(e.target.checked)} />
            <span>Natural voice for everything (uses ElevenLabs credits)</span>
          </label>

          {premiumVoice && voices.length > 0 && (
            <fieldset className="display-fields">
              <legend>Voice</legend>
              <label {...hover('Choose a voice')}>
                Choose a voice
                <select
                  className="voice-select"
                  value={voiceId}
                  onChange={(e) => {
                    setVoiceId(e.target.value);
                    previewVoice(voices.find((v) => v.voice_id === e.target.value));
                  }}
                >
                  {voices.map((v) => (
                    <option key={v.voice_id} value={v.voice_id}>{voiceLabel(v)}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary"
                onClick={() => previewVoice(voices.find((v) => v.voice_id === voiceId))}
                {...hover('Play a sample of this voice')}
              >
                Play a sample
              </button>
            </fieldset>
          )}

          <fieldset className="display-fields">
            <legend>Message on my wearable</legend>
            <p className="hint">People near you see this. Up to 16 characters per line.</p>
            <label {...hover('Wearable message, first line')}>
              First line
              <input type="text" value={line1} maxLength={16} onChange={(e) => setLine1(e.target.value)} />
            </label>
            <label {...hover('Wearable message, second line')}>
              Second line
              <input type="text" value={line2} maxLength={16} onChange={(e) => setLine2(e.target.value)} />
            </label>
            <button type="button" className="secondary" onClick={saveDisplay} {...hover('Update wearable message')}>
              Update wearable message
            </button>
          </fieldset>
        </details>
      </main>

      {fall === 'pending' && (
        <div className="alarm is-pending" role="alertdialog" aria-modal="true" aria-labelledby="fall-title" aria-describedby="fall-desc">
          <h2 id="fall-title">Fall detected</h2>
          <p className="countdown" aria-hidden="true">{secondsLeft}</p>
          <p id="fall-desc">
            The alarm sounds in {secondsLeft} {secondsLeft === 1 ? 'second' : 'seconds'}.
            Double-click your button to cancel.
          </p>
          <button type="button" className="alarm-ok" onClick={imOkay} autoFocus {...hover("I'm okay. Cancel the alarm")}>
            I'm okay
          </button>
        </div>
      )}

      {fall === 'alarm' && (
        <div className="alarm" role="alertdialog" aria-modal="true" aria-labelledby="alarm-title" aria-describedby="alarm-desc">
          <h2 id="alarm-title">Alarm on</h2>
          <p id="alarm-desc">Your wearable is asking people nearby for help. Double-click your button to stop it.</p>
          <button type="button" className="alarm-ok" onClick={imOkay} autoFocus {...hover("I'm okay. Stop the alarm")}>
            I'm okay
          </button>
        </div>
      )}

      <audio ref={audioRef} hidden />
    </div>
  );
}
