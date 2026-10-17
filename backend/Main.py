"""
Guardian backend (Technica 2026)

Run:   cd backend && python Main.py
.env:  GEMINI_API_KEY=...        (required for narration)
       ELEVENLABS_API_KEY=...    (optional - without it, the phone uses its built-in voice)
       OPENROUTER_API_KEY=...    (optional fallback if Gemini fails)
       MOCK_HARDWARE=1           (optional - force mock mode even with the Arduino plugged in)
       ARDUINO_PORT=COM3         (optional - only if auto-detect picks the wrong port)
"""

import base64
import os
import time

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
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

    def __init__(self):
        self.light = 600
        self.connected = True
        self._events = []

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
        self.inject("fall")

    def cancel_fall(self):
        self.inject("cancel")


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


# ---------- AI helpers ----------
def describe_image(image_bytes, mime="image/jpeg", prompt=NARRATE_PROMPT):
    """Gemini first (for the MLH prize), OpenRouter as a backup."""
    errors = []
    if gemini_client:
        try:
            resp = gemini_client.models.generate_content(
                model=GEMINI_MODEL,
                contents=[genai_types.Part.from_bytes(data=image_bytes, mime_type=mime),
                          prompt],
            )
            if resp.text:
                return resp.text.strip(), "gemini"
            errors.append("gemini: empty response")
        except Exception as e:
            errors.append(f"gemini: {e}")
            print(f"[narrate] Gemini failed: {e}")

    if openrouter_client:
        try:
            b64 = base64.b64encode(image_bytes).decode()
            resp = openrouter_client.chat.completions.create(
                model="google/gemini-2.5-flash",
                messages=[{"role": "user", "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                ]}],
            )
            return resp.choices[0].message.content.strip(), "openrouter"
        except Exception as e:
            errors.append(f"openrouter: {e}")
            print(f"[narrate] OpenRouter failed: {e}")

    raise RuntimeError("No vision model worked: " + "; ".join(errors or ["no API keys set"]))


def speak(text):
    """Returns base64 mp3, or None so the phone falls back to its built-in voice."""
    if not eleven_client or not text:
        return None
    try:
        audio = eleven_client.text_to_speech.convert(
            voice_id=ELEVEN_VOICE_ID,
            model_id=ELEVEN_MODEL,
            output_format="mp3_44100_128",
            text=text,
        )
        return base64.b64encode(b"".join(audio)).decode()
    except Exception as e:
        print(f"[speak] ElevenLabs failed, phone will use built-in voice: {e}")
        return None


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
        "status": "Guardian backend online",
        "hardware": "mock" if getattr(hw, "is_mock", False) else "arduino",
        "gemini": bool(gemini_client),
        "elevenlabs": bool(eleven_client),
        "frontend_build": bool(FRONTEND_BUILD),
    })


@app.route("/narrate", methods=["POST"])
def narrate():
    image = request.files.get("image")
    if image is None:
        return jsonify({"error": "no 'image' file in form data"}), 400
    image_bytes = image.read()
    if not image_bytes:
        return jsonify({"error": "empty image"}), 400

    try:
        start = time.time()
        mode = request.form.get("mode", "tap")
        if mode == "live":
            previous = request.form.get("previous", "").strip()[:300] or "nothing yet"
            prompt = LIVE_PROMPT.format(previous=previous.replace('"', "'"))
        else:
            prompt = NARRATE_PROMPT
        text, source = describe_image(image_bytes, image.mimetype or "image/jpeg", prompt)
        print(f"[narrate] {source} in {time.time() - start:.1f}s: {text}")
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    # audio is null if ElevenLabs fails - the frontend should then use speechSynthesis
    # Live mode: stay quiet when the scene hasn't meaningfully changed
    if mode == "live" and text.strip().strip(".").upper() == "NOTHING":
        return jsonify({"text": "", "audio": None, "quiet": True, "source": source})

    # voice=device -> the phone speaks it itself (instant, saves ElevenLabs credits; used by live mode)
    want_audio = request.form.get("voice", "eleven") == "eleven"
    return jsonify({"text": text, "audio": speak(text) if want_audio else None, "source": source})


@app.route("/speak", methods=["POST"])
def speak_route():
    text = (request.get_json(silent=True) or {}).get("text", "").strip()
    if not text:
        return jsonify({"error": "no text"}), 400
    return jsonify({"text": text, "audio": speak(text)})


@app.route("/events", methods=["GET"])
def events():
    return jsonify({
        "events": hw.get_events(),
        "light": hw.light,
        "connected": getattr(hw, "connected", True),
        "mock": getattr(hw, "is_mock", False),
    })


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
    if getattr(hw, "is_mock", False):
        hw.inject(event_type)
    elif event_type == "fall":
        hw.test_fall()  # real Arduino: LCD + buzzer go off, FALL event comes back
    else:
        return jsonify({"error": "with real hardware only /test/fall works - press the real button"}), 400
    return jsonify({"status": "sent", "event": event_type})


# React app (only when built). API routes above take priority.
@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def frontend(path):
    if not FRONTEND_BUILD:
        return jsonify({"status": "Guardian backend online (no frontend build yet)"})
    full = os.path.join(FRONTEND_BUILD, path)
    if path and os.path.isfile(full):
        return send_from_directory(FRONTEND_BUILD, path)
    return send_from_directory(FRONTEND_BUILD, "index.html")


if __name__ == "__main__":
    # use_reloader=False is required: the reloader would open the Arduino's serial port twice
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)
