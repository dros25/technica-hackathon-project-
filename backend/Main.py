"""
SightSea backend (Technica 2026)

Run:   cd backend && python Main.py
.env:  GEMINI_API_KEY=...        (required for narration)
       ELEVENLABS_API_KEY=...    (optional - without it, the phone uses its built-in voice)
       OPENROUTER_API_KEY=...    (optional fallback if Gemini fails)
       MOCK_HARDWARE=1           (optional - force mock mode even with the Arduino plugged in)
       ARDUINO_PORT=COM3         (optional - only if auto-detect picks the wrong port)
       MOCK_VISION=1             (optional - fake descriptions, uses no API quota)
       GEMINI_MODELS=a,b         (optional - exact model fallback order)
       OPENROUTER_MODEL=...      (optional - backup model on OpenRouter)
       CAMERA_INDEX=1            (optional - which webcam is the wearable; default tries 1, 2, then 0)
       ELEVEN_VOICE_ID=...       (optional - default voice; the phone can pick another)
"""

import base64
import hashlib
import re
import os
import threading
import time

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

NARRATE_PROMPT = (
    "You are guiding a blind person. In 1-2 short sentences, describe what's directly ahead. "
    "Mention obstacles, steps, doors, and people first, with rough direction (left, right, ahead) "
    "and distance if you can tell. No preamble."
)
LIVE_PROMPT = (
    "You are a live guide for a blind person who is walking. Look at what is directly ahead. "
    "Last time you said: \"{previous}\". If nothing important is new or different, reply with exactly: NOTHING. "
    "Otherwise reply with ONE short sentence under 15 words, hazards first "
    "(obstacles, steps, doors, people, vehicles) with direction. No preamble."
)
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
ELEVEN_VOICE_ID = os.getenv("ELEVEN_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
ELEVEN_MODEL = os.getenv("ELEVEN_MODEL", "eleven_flash_v2_5")  # fast + uses fewer credits

# ---------- AI clients (each one is optional so the server still boots) ----------
gemini_client = None
if os.getenv("GEMINI_API_KEY"):
    try:
        from google import genai
        from google.genai import types as genai_types
        gemini_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
        print(f"[ai] Gemini ready ({GEMINI_MODEL})")
    except Exception as e:
        print(f"[ai] Gemini unavailable: {e}")

openrouter_client = None
if os.getenv("OPENROUTER_API_KEY"):
    try:
        from openai import OpenAI
        openrouter_client = OpenAI(base_url="https://openrouter.ai/api/v1",
                                   api_key=os.getenv("OPENROUTER_API_KEY"))
        print("[ai] OpenRouter fallback ready")
    except Exception as e:
        print(f"[ai] OpenRouter unavailable: {e}")

eleven_client = None
if os.getenv("ELEVENLABS_API_KEY"):
    try:
        from elevenlabs.client import ElevenLabs
        eleven_client = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY"))
        print("[ai] ElevenLabs ready")
    except Exception as e:
        print(f"[ai] ElevenLabs unavailable: {e}")


# ---------- Hardware ----------
class MockHardware:
    """Same interface as hardware.Hardware, for testing without the Arduino."""
    is_mock = True

    COUNTDOWN_S = int(os.getenv("MOCK_COUNTDOWN", "30"))

    def __init__(self):
        self.light = 600
        self.connected = True
        self.fall_detection = True
        self._events = []
        self._alarm_timer = None

    def get_events(self):
        evs, self._events = self._events, []
        return evs

    def inject(self, event_type, value=None):
        ev = {"type": event_type, "time": time.time()}
        if value is not None:
            ev["value"] = value
        if event_type == "dark":
            self.light = value if value is not None else 50
        self._events.append(ev)

    def set_lcd(self, line1, line2=""):
        print(f"[LCD MOCK] {line1} | {line2}")

    def alarm(self, on):
        print(f"[ALARM MOCK] {'ON' if on else 'OFF'}")

    def test_fall(self):
        """Same flow as the Arduino: countdown first, alarm if nobody cancels."""
        if not self.fall_detection:
            print("[MOCK] fall ignored: fall detection is off")
            return
        self._stop_timer()
        self._events.append({"type": "fall_pending", "seconds": self.COUNTDOWN_S, "time": time.time()})
        self._alarm_timer = threading.Timer(self.COUNTDOWN_S, lambda: self.inject("fall"))
        self._alarm_timer.daemon = True
        self._alarm_timer.start()

    def cancel_fall(self):
        self._stop_timer()
        self.inject("cancel")

    def set_fall_detection(self, on):
        self.fall_detection = bool(on)
        if not on:
            self._stop_timer()
        print(f"[MOCK] fall detection {'ON' if on else 'OFF'}")

    def _stop_timer(self):
        if self._alarm_timer:
            self._alarm_timer.cancel()
            self._alarm_timer = None


def load_hardware():
    if os.getenv("MOCK_HARDWARE") == "1":
        print("[hardware] MOCK_HARDWARE=1, using mock")
        return MockHardware()
    try:
        from hardware import Hardware  # backend/hardware.py
        hw_real = Hardware(port=os.getenv("ARDUINO_PORT") or None)
        hw_real.is_mock = False
        return hw_real
    except Exception as e:  # ImportError, no Arduino found, port busy...
        print(f"[hardware] real hardware unavailable ({e}), using MOCK mode")
        return MockHardware()


hw = load_hardware()

from camera import Webcam, difference as camera_difference  # noqa: E402  (backend/camera.py)
webcam = Webcam()  # the wearable's USB webcam; opens the first time it's used


# ---------- AI helpers ----------
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "google/gemini-3.8-flash")
MOCK_VISION = os.getenv("MOCK_VISION") == "1"  # fake descriptions: test without using API quota

# Each Gemini model has its own free-tier quota. When one runs out, try the others.
_exhausted_until = {}   # model name -> time when we may try it again
_model_chain = None


def _gemini_models():
    """GEMINI_MODELS=a,b,c in .env wins; otherwise GEMINI_MODEL plus other flash models on the account."""
    global _model_chain
    if _model_chain is not None:
        return _model_chain
    if os.getenv("GEMINI_MODELS"):
        _model_chain = [m.strip() for m in os.getenv("GEMINI_MODELS").split(",") if m.strip()]
        return _model_chain
    chain = [GEMINI_MODEL]
    try:
        skip = ("tts", "image", "live", "audio", "embed", "thinking", "exp", "preview")
        for m in gemini_client.models.list():
            name = (m.name or "").replace("models/", "")
            actions = getattr(m, "supported_actions", None) or []
            if "flash" in name and not any(s in name for s in skip) \
                    and (not actions or "generateContent" in actions) and name not in chain:
                chain.append(name)
    except Exception as e:
        print(f"[ai] couldn't list Gemini models ({e}), using {GEMINI_MODEL} only")
    _model_chain = chain
    print(f"[ai] Gemini model order: {', '.join(chain)}")
    return chain


def _retry_seconds(err_text):
    m = re.search(r"retryDelay['\"]?\s*:\s*['\"](\d+)s", err_text) or re.search(r"retry in (\d+)", err_text)
    return int(m.group(1)) if m else 600


def describe_image(image_bytes, mime="image/jpeg", prompt=NARRATE_PROMPT):
    """Gemini first (for the MLH prize), falling through models on quota limits, then OpenRouter."""
    if MOCK_VISION:
        if "NOTHING" in prompt:  # live mode: usually quiet
            return ("NOTHING" if int(time.time()) % 3 else "A person is walking toward you on the right."), "mock"
        return "Mock description: a clear hallway ahead, with a chair on your left.", "mock"

    errors = []
    if gemini_client:
        for model in _gemini_models():
            if time.time() < _exhausted_until.get(model, 0):
                errors.append(f"{model}: out of quota")  # don't waste a call
                continue
            try:
                resp = gemini_client.models.generate_content(
                    model=model,
                    contents=[genai_types.Part.from_bytes(data=image_bytes, mime_type=mime), prompt],
                )
                if resp.text:
                    return resp.text.strip(), f"gemini:{model}"
                errors.append(f"{model}: empty response")
            except Exception as e:
                text = str(e)
                if "429" in text or "RESOURCE_EXHAUSTED" in text:
                    wait = _retry_seconds(text)
                    _exhausted_until[model] = time.time() + wait
                    print(f"[narrate] {model} is out of quota for ~{wait // 60} min, trying the next model")
                    errors.append(f"{model}: out of quota")
                elif "404" in text or "NOT_FOUND" in text:
                    _exhausted_until[model] = time.time() + 24 * 3600  # retired model, skip it
                    errors.append(f"{model}: not available")
                else:
                    print(f"[narrate] {model} failed: {text[:300]}")
                    errors.append(f"{model}: {text[:120]}")

    if openrouter_client:
        try:
            b64 = base64.b64encode(image_bytes).decode()
            resp = openrouter_client.chat.completions.create(
                model=OPENROUTER_MODEL,
                messages=[{"role": "user", "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                ]}],
            )
            return resp.choices[0].message.content.strip(), "openrouter"
        except Exception as e:
            errors.append(f"openrouter: {e}")
            print(f"[narrate] OpenRouter failed: {e}")

    if errors and all("out of quota" in e or "not available" in e for e in errors):
        raise RuntimeError("The AI's free daily limit is used up. Add billing or another API key. ("
                           + "; ".join(errors) + ")")
    raise RuntimeError("No vision model worked: " + "; ".join(errors or ["no API keys set"]))


# Every phrase is saved the first time it's spoken, so repeated hover labels and alerts
# cost no ElevenLabs credits (and survive restarts).
TTS_CACHE_DIR = os.path.join(BASE_DIR, ".tts_cache")
_tts_memory = {}
_voice_ids = set()  # voices the account actually has (filled by list_voices)


def _clean_voice(voice_id):
    if voice_id and re.fullmatch(r"[A-Za-z0-9]{10,40}", str(voice_id)) \
            and (not _voice_ids or voice_id in _voice_ids):
        return voice_id
    return ELEVEN_VOICE_ID


def speak(text, voice_id=None):
    """Returns base64 mp3, or None so the phone falls back to its built-in voice."""
    if not eleven_client or not text:
        return None
    voice_id = _clean_voice(voice_id)
    key = hashlib.sha1(f"{voice_id}|{ELEVEN_MODEL}|{text}".encode()).hexdigest()
    if key in _tts_memory:
        return _tts_memory[key]
    path = os.path.join(TTS_CACHE_DIR, key + ".mp3")
    if os.path.exists(path):
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        _tts_memory[key] = b64
        return b64
    try:
        audio = b"".join(eleven_client.text_to_speech.convert(
            voice_id=voice_id,
            model_id=ELEVEN_MODEL,
            output_format="mp3_44100_128",
            text=text,
        ))
    except Exception as e:
        print(f"[speak] ElevenLabs failed, phone will use built-in voice: {e}")
        return None
    try:
        os.makedirs(TTS_CACHE_DIR, exist_ok=True)
        with open(path, "wb") as f:
            f.write(audio)
    except OSError:
        pass
    b64 = base64.b64encode(audio).decode()
    if len(_tts_memory) < 500:
        _tts_memory[key] = b64
    return b64


_voices_cache = {"at": 0.0, "list": []}


def list_voices():
    """The ElevenLabs voices this account can use, for the voice picker."""
    if not eleven_client:
        return []
    if time.time() - _voices_cache["at"] < 600 and _voices_cache["list"]:
        return _voices_cache["list"]
    try:
        try:
            raw = eleven_client.voices.search(page_size=100).voices
        except Exception:
            raw = eleven_client.voices.get_all().voices
    except Exception as e:
        print(f"[voices] couldn't list ElevenLabs voices: {e}")
        return _voices_cache["list"]
    out = []
    for v in raw:
        labels = dict(getattr(v, "labels", None) or {})
        out.append({
            "voice_id": v.voice_id,
            "name": v.name,
            "gender": labels.get("gender", ""),
            "accent": labels.get("accent", ""),
            "age": labels.get("age", ""),
            "description": labels.get("description") or labels.get("descriptive") or "",
            "preview_url": getattr(v, "preview_url", None),
            "category": str(getattr(v, "category", "") or ""),
        })
    out.sort(key=lambda v: (v["category"] != "premade", v["name"].lower()))
    _voices_cache.update(at=time.time(), list=out)
    _voice_ids.clear()
    _voice_ids.update(v["voice_id"] for v in out)
    return out


# ---------- App ----------
# Serve the built React app if it exists (npm run build), so everything is on ONE port / ONE ngrok link.
FRONTEND_BUILD = next(
    (p for p in (os.path.join(BASE_DIR, "..", "frontend", "build"),
                 os.path.join(BASE_DIR, "..", "frontend", "dist"))
     if os.path.isdir(p)),
    None,
)

app = Flask(__name__, static_folder=None)  # disable Flask's /static so React's /static/js works
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024  # 10 MB images max


@app.route("/health")
def health():
    return jsonify({
        "status": "SightSea backend online",
        "hardware": "mock" if getattr(hw, "is_mock", False) else "arduino",
        "gemini": bool(gemini_client),
        "elevenlabs": bool(eleven_client),
        "frontend_build": bool(FRONTEND_BUILD),
    })


LIVE_CHANGE = 12        # average pixel change (0-255) that counts as "the scene changed"
LIVE_RECHECK_S = 20     # re-check an unchanged scene this often anyway
_wearable_live = {"sig": None, "at": 0.0}


@app.route("/narrate", methods=["POST"])
def narrate():
    mode = request.form.get("mode", "tap")
    voice_id = request.form.get("voice_id") or None

    if request.form.get("source") == "wearable":
        # The wearable's USB webcam is plugged into this laptop: grab the frame here
        if mode == "live":
            sig = webcam.signature()
            if sig is None:
                return jsonify({"error": webcam.error or "Wearable camera not available"}), 503
            changed = camera_difference(sig, _wearable_live["sig"]) > LIVE_CHANGE
            stale = time.time() - _wearable_live["at"] > LIVE_RECHECK_S
            if not changed and not stale:
                return jsonify({"text": "", "audio": None, "quiet": True, "source": "unchanged"})
            _wearable_live["sig"], _wearable_live["at"] = sig, time.time()
        image_bytes = webcam.jpeg(width=640)
        if image_bytes is None:
            return jsonify({"error": webcam.error or "Wearable camera not available"}), 503
        mime = "image/jpeg"
    else:
        image = request.files.get("image")
        if image is None:
            return jsonify({"error": "no 'image' file in form data"}), 400
        image_bytes = image.read()
        if not image_bytes:
            return jsonify({"error": "empty image"}), 400
        mime = image.mimetype or "image/jpeg"

    try:
        start = time.time()
        if mode == "live":
            previous = request.form.get("previous", "").strip()[:300] or "nothing yet"
            prompt = LIVE_PROMPT.format(previous=previous.replace('"', "'"))
        else:
            prompt = NARRATE_PROMPT
        text, source = describe_image(image_bytes, mime, prompt)
        print(f"[narrate] {source} in {time.time() - start:.1f}s: {text}")
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    # audio is null if ElevenLabs fails - the frontend should then use speechSynthesis
    # Live mode: stay quiet when the scene hasn't meaningfully changed
    if mode == "live" and text.strip().strip(".").upper() == "NOTHING":
        return jsonify({"text": "", "audio": None, "quiet": True, "source": source})

    # voice=device -> the phone speaks it itself (instant, saves ElevenLabs credits; used by live mode)
    want_audio = request.form.get("voice", "eleven") == "eleven"
    audio = speak(text, voice_id) if want_audio else None
    return jsonify({"text": text, "audio": audio, "source": source})


@app.route("/speak", methods=["POST"])
def speak_route():
    data = request.get_json(silent=True) or {}
    text = str(data.get("text", "")).strip()[:400]
    if not text:
        return jsonify({"error": "no text"}), 400
    return jsonify({"text": text, "audio": speak(text, data.get("voice_id"))})


@app.route("/voices", methods=["GET"])
def voices():
    return jsonify({"voices": list_voices(), "default": ELEVEN_VOICE_ID})


# ---------- Wearable webcam ----------
@app.route("/camera/status")
def camera_status():
    webcam.open()
    return jsonify(webcam.status())


@app.route("/camera/frame.jpg")
def camera_frame():
    jpg = webcam.jpeg(width=640)
    if jpg is None:
        return jsonify({"error": webcam.error or "no camera"}), 503
    return Response(jpg, mimetype="image/jpeg", headers={"Cache-Control": "no-store"})


@app.route("/camera/stream")
def camera_stream():
    """Live view for the porthole (MJPEG, ~6 fps, small so it stays smooth over ngrok)."""
    def frames():
        while True:
            jpg = webcam.jpeg(width=480, quality=60)
            if jpg is None:
                return
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n"
            time.sleep(0.16)
    if not webcam.open():
        return jsonify({"error": webcam.error or "no camera"}), 503
    return Response(frames(), mimetype="multipart/x-mixed-replace; boundary=frame",
                    headers={"Cache-Control": "no-store"})


@app.route("/events", methods=["GET"])
def events():
    return jsonify({
        "events": hw.get_events(),
        "light": hw.light,
        "connected": getattr(hw, "connected", True),
        "mock": getattr(hw, "is_mock", False),
        "fall_detection": getattr(hw, "fall_detection", True),
    })


@app.route("/fall-detection", methods=["POST"])
def fall_detection():
    on = bool((request.get_json(silent=True) or {}).get("enabled", True))
    hw.set_fall_detection(on)
    return jsonify({"status": "success", "enabled": on})


@app.route("/lcd", methods=["POST"])
def lcd():
    data = request.get_json(silent=True) or {}
    hw.set_lcd(str(data.get("line1", ""))[:16], str(data.get("line2", ""))[:16])
    return jsonify({"status": "success"})


@app.route("/cancel", methods=["POST"])
def cancel():
    """'I'm okay' from the phone: stops the fall alarm on the wearable too."""
    hw.cancel_fall()
    return jsonify({"status": "success"})


@app.route("/alarm", methods=["POST"])
def alarm():
    on = bool((request.get_json(silent=True) or {}).get("on", False))
    hw.alarm(on)
    return jsonify({"status": "success", "on": on})


@app.route("/test/<event_type>", methods=["POST", "GET"])
def test_event(event_type):
    """Fake events for testing the frontend: /test/fall, /test/button, /test/cancel, /test/dark"""
    if event_type not in ("fall", "button", "cancel", "dark"):
        return jsonify({"error": "use fall, button, cancel or dark"}), 400
    if event_type == "fall":
        hw.test_fall()  # starts the 30 s countdown (real Arduino or mock), alarm if not cancelled
    elif event_type == "cancel":
        hw.cancel_fall()
    elif getattr(hw, "is_mock", False):
        hw.inject(event_type)
    else:
        return jsonify({"error": "with real hardware only /test/fall works - press the real button"}), 400
    return jsonify({"status": "sent", "event": event_type})


# React app (only when built). API routes above take priority.
@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def frontend(path):
    if not FRONTEND_BUILD:
        return jsonify({"status": "SightSea backend online (no frontend build yet)"})
    full = os.path.join(FRONTEND_BUILD, path)
    if path and os.path.isfile(full):
        return send_from_directory(FRONTEND_BUILD, path)
    return send_from_directory(FRONTEND_BUILD, "index.html")


if __name__ == "__main__":
    # use_reloader=False is required: the reloader would open the Arduino's serial port twice
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)
