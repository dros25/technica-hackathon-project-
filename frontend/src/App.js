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

export default function App() {
  const [mode, setMode] = useState('tap'); // 'tap' | 'live'
  const [caption, setCaption] = useState('Tap the porthole to hear what is ahead of you.');
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
  const [hazardState, setHazardState] = useState('off'); // off | loading | on | stalled | error
  const [hazardStats, setHazardStats] = useState(null);  // { latencyMs, fps }

  const videoRef = useRef(null);
  const overlayRef = useRef(null);
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
  // "urgent" = hazard warnings (interrupt everything, nothing interrupts them).
  // "high" = narration and alerts. "low" = hover labels (never interrupts high or urgent).
  const isPlayingAudio = () => audioRef.current && !audioRef.current.paused;
  const urgentSpeaking = () => window.speechSynthesis && window.speechSynthesis.speaking
    && speechRef.current.priority === 'urgent';

  const speak = useCallback((text, priority = 'high') => {
    const synth = window.speechSynthesis;
    if (!text || !synth) return;
    const s = speechRef.current;
    if (priority === 'low' && (isPlayingAudio() || (synth.speaking && s.priority !== 'low'))) return;
    if (priority === 'high' && urgentSpeaking()) return; // never talk over a hazard warning
    if (priority !== 'low' && audioRef.current) audioRef.current.pause();
    synth.cancel();
    const id = ++s.id;
    s.priority = priority;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = priority === 'urgent' ? 1.25 : 1.05;
    u.onend = () => { if (speechRef.current.id === id) speechRef.current.priority = null; };
    synth.speak(u);
  }, []);

  const playAudio = useCallback((b64, fallbackText) => {
    const audio = audioRef.current;
    if (!audio) return speak(fallbackText);
    if (urgentSpeaking()) return; // a hazard warning is playing; the caption still shows the text
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    audio.src = `data:audio/mpeg;base64,${b64}`;
    audio.play().catch(() => speak(fallbackText));
  }, [speak]);

  const stopSpeaking = useCallback(() => {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (audioRef.current) audioRef.current.pause();
  }, []);

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
  useEffect(() => {
    let stream;
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
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
        setCameraReady(true);
      })
      .catch((err) => {
        console.error('Camera error:', err);
        cameraMsgRef.current = 'Camera access was blocked. Allow camera access for this site and reload.';
        setCaption(cameraMsgRef.current);
      });
    return () => { if (stream) stream.getTracks().forEach((t) => t.stop()); };
  }, []);

  // ---------- Describe the scene ----------
  const describe = useCallback(async (kind = 'tap') => {
    if (busyRef.current) return;
    const canvas = grabFrame(videoRef.current, 640);
    if (!canvas) {
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
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      const form = new FormData();
      form.append('image', blob, 'frame.jpg');
      form.append('mode', kind);
      form.append('voice', kind === 'tap' && premiumRef.current ? 'eleven' : 'device');
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
    if (state === 'on' && prev === 'loading') speak('Hazard watch on.');
    else if (state === 'on' && prev === 'stalled') speak('Hazard watch resumed.');
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

  useEffect(() => {
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
    if (hazardOn) {
      watcherRef.current.start();
    } else if (hazardStateRef.current !== 'off') {
      watcherRef.current.stop();
      hazardHandlersRef.current.draw(null);
      speak('Hazard watch off.');
    }
  }, [cameraReady, hazardOn]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (watcherRef.current) watcherRef.current.stop(); }, []);

  // Keep the screen awake: if the phone sleeps, the camera stops and so does the watcher
  useEffect(() => {
    if (!(hazardOn || mode === 'live') || !('wakeLock' in navigator)) return undefined;
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
  }, [hazardOn, mode]);

  // ---------- Live guide ----------
  useEffect(() => {
    if (mode !== 'live') return undefined;
    liveRef.current = { text: '', at: 0, sig: null };
    const timer = setInterval(() => {
      const synth = window.speechSynthesis;
      if (busyRef.current || fallRef.current || isPlayingAudio() || (synth && synth.speaking)) return;
      if (Date.now() - lastHazardRef.current < QUIET_AFTER_HAZARD_MS) return;
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
      ? "Live guide on. I'll speak when something new appears."
      : 'Tap mode on. Tap the porthole or press your button to hear what is ahead.';
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
          ? { text: 'Online, demo wearable', tone: 'ok' }
          : { text: 'Online, wearable connected', tone: 'ok' };

  const hazardPill = {
    off: { text: 'Hazard watch off', tone: 'quiet' },
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

  return (
    <div className={`app ${mode === 'live' ? 'is-live' : ''}`}>
      <header className="topbar">
        <h1 className="brand">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M2 20c4 0 4-4 8-4s4 4 8 4 4-4 8-4 4 4 4 4" />
            <path d="M2 26c4 0 4-4 8-4s4 4 8 4 4-4 8-4 4 4 4 4" />
            <circle cx="16" cy="9" r="5" />
          </svg>
          Guardian
        </h1>
        <p className={`status status-${status.tone}`} {...hover(status.text)} tabIndex={0}>
          <span className="status-dot" aria-hidden="true" />
          {status.text}
        </p>
        <p className={`status status-${hazardPill.tone}`} {...hover(hazardPill.text.replace('·', ','))} tabIndex={0}>
          <span className="status-dot" aria-hidden="true" />
          {hazardPill.text}
        </p>
      </header>

      <main className="stage">
        <button
          type="button"
          className={`porthole ${busy ? 'is-busy' : ''} ${cameraReady ? 'has-camera' : ''}`}
          onClick={() => describe('tap')}
          aria-label={portholeLabel}
          aria-busy={busy}
          autoFocus
          {...hover(portholeLabel)}
        >
          <span className="sonar" aria-hidden="true"><i /><i /><i /></span>
          <span className="porthole-glass">
            <video ref={videoRef} autoPlay playsInline muted aria-hidden="true" />
            <canvas ref={overlayRef} className="overlay" aria-hidden="true" />
          </span>
          <span className="porthole-label" aria-hidden="true">
            {busy ? 'Looking…' : mode === 'live' ? 'Tap for detail' : 'Tap to describe'}
          </span>
        </button>

        <p className="caption" role="status" aria-live="polite">{caption}</p>

        <div className="modes" role="radiogroup" aria-label="How Guardian describes the scene">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'tap'}
            className="mode"
            onClick={() => chooseMode('tap')}
            {...hover('Tap mode. Describe the scene only when I ask')}
          >
            <span className="mode-title">Tap mode</span>
            <span className="mode-sub">Describe when I ask</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'live'}
            className="mode"
            onClick={() => chooseMode('live')}
            {...hover('Live guide. Speak up whenever something new appears')}
          >
            <span className="mode-title">Live guide</span>
            <span className="mode-sub">Speak when things change</span>
          </button>
        </div>

        <details className="settings">
          <summary {...hover('Settings')}>Settings</summary>

          <label className="toggle" {...hover(`Hazard watch. Warn me when something comes at me fast. ${hazardOn ? 'On' : 'Off'}`)}>
            <input type="checkbox" checked={hazardOn} onChange={(e) => setHazardOn(e.target.checked)} />
            <span>Hazard watch: warn me when something comes at me fast</span>
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

          <label className="toggle" {...hover(`Natural voice for descriptions. ${premiumVoice ? 'On' : 'Off'}`)}>
            <input type="checkbox" checked={premiumVoice} onChange={(e) => setPremiumVoice(e.target.checked)} />
            <span>Use the natural voice for tap descriptions</span>
          </label>

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
