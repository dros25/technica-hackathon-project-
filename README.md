# SightSea

**A hands-free guide for blind and low-vision people.** A phone worn on the chest describes what's ahead and warns about anything coming at you fast. A wrist camera answers "what am I pointing at?". A small wearable detects falls and asks people nearby for help.

Built at **Technica 2026** (University of Maryland) by a team of two first-time hackers.

---

## What it does

| | Feature | How it works |
|---|---|---|
| 🗣️ | **Tap to describe** | Double-tap the screen or press the wearable button. Gemini describes the scene in 1–2 sentences, obstacles and directions first, spoken in a natural ElevenLabs voice. |
| 🌊 | **Live guide** | Watches continuously and speaks only when something new or important appears, so it doesn't talk nonstop. |
| ⚠️ | **Hazard watch** | Runs **on the phone, offline, in a fraction of a second**: an object detector plus a "looming" detector that measures how fast parts of the view are expanding (time-to-contact), so it warns about anything approaching fast, even things it can't name. |
| 👉 | **Point to ask** | A USB webcam on the wrist. Point at something and press the button: "That's a blue water bottle." Reads signs and labels too. |
| 🆘 | **Fall detection** | Accelerometer looks for free-fall or impact followed by stillness. A 30-second spoken countdown follows (double-press the button or tap "I'm okay" to cancel), then a buzzer and red LCD saying **"I've fallen! Please help me"** for people nearby. |
| 🔆 | **Dark warning** | A light sensor warns when it's getting dark around you. |
| 🪧 | **LCD for passersby** | Shows a message such as "Low vision / Thanks for help", editable from the app. |

**Accessible by design:** tap anything once to hear what it is, double-tap to use it (works like a screen reader). Large high-contrast "sunlit shallows" theme, Atkinson Hyperlegible font, one screen with no scrolling, every alert spoken, and a choice of ElevenLabs voices.

### Wearable button
| Press | Action |
|---|---|
| Press | Describe what's ahead (or what the wrist camera points at) |
| Double press | Switch Tap mode / Live guide |
| Hold 1 s, let go | Stop talking, Live guide off |
| Double press during a fall | Cancel the alarm |

---

## How it works

```
 Chest phone (React web app)             Laptop (Python / Flask)                 Wearable (Arduino UNO R4 WiFi)
 ┌───────────────────────────┐  HTTPS   ┌──────────────────────────────┐  Wi-Fi  ┌───────────────────────────┐
 │ camera view               │ (ngrok)  │ /narrate  → Gemini vision    │  TCP    │ accelerometer (falls)     │
 │ hazard watch (on-device,  │ ───────► │ /speak    → ElevenLabs voice │ ◄─────► │ light sensor              │
 │   MediaPipe + looming)    │ ◄─────── │ /events   ← wearable events  │  or USB │ button, buzzer, RGB LCD   │
 │ speech, settings, alerts  │          │ webcam    → "point to ask"   │         └───────────────────────────┘
 └───────────────────────────┘          └──────────────────────────────┘
                                                   ▲ USB
                                              wrist webcam
```

- **Phone:** React app served by Flask through ngrok, so any phone browser works. Hazard watch runs entirely in the browser (MediaPipe EfficientDet-Lite0 detection and tracking, plus a model-free looming detector using block-matching optical flow and scale fitting).
- **Laptop:** Flask server. Gemini vision with automatic fallback across models (and OpenRouter as a backup), ElevenLabs text-to-speech with a disk cache, an OpenCV webcam reader, and the wearable link.
- **Wearable:** Arduino UNO R4 WiFi with a Grove Base Shield. It joins the phone's hotspot; the laptop finds it automatically by scanning its subnet (USB works too). A simple line protocol carries `BTN`, `FALL_PENDING:30`, `FALL`, `LIGHT:512` and commands such as `LCD:…` and `ALARM:ON`.

---

## Hardware

- Arduino UNO R4 WiFi + Grove Base Shield (switch set to **5V**)
- Grove: 3-axis accelerometer (MMA7660; ADXL345/LIS3DH also detected), light sensor (A0), button (D2), buzzer (D3), RGB LCD 16×2 (I2C)
- USB webcam (wrist)
- Phone (chest) and a power bank or phone USB-C for the Arduino

---

## Run it

**Windows, one click:** double-click `start.bat`. It installs what's missing, builds the app, starts the server and ngrok, and copies the phone link.

**Manually:**
```bash
cd backend
cp .env.example .env            # add GEMINI_API_KEY and ELEVENLABS_API_KEY
pip install -r requirements.txt
cd ../frontend && npm install && npm run build
cd ../backend && python Main.py # then, in another terminal:
ngrok http 5000                 # open the https link on your phone
```

**Wearable over Wi-Fi:** copy `firmware/guardian/arduino_secrets.h.example` to `arduino_secrets.h`, add your hotspot name and password, and upload `guardian.ino` once over USB. Put the laptop on the same hotspot; the server finds the board by itself (or set `ARDUINO_HOST=` to the address shown on the LCD).

**Testing without hardware:** set `MOCK_HARDWARE=1` and/or `MOCK_VISION=1` in `.env`, and trigger events with `/test/fall`, `/test/button`, `/test/double`, `/test/stop` and `/test/dark`.

API keys stay in `backend/.env` on the laptop. They're never in the app or on GitHub.

More detail for developers is in [NOTES.md](NOTES.md).

---

## Built with

Arduino (C++) · Python · Flask · OpenCV · pyserial · Google Gemini · ElevenLabs · OpenRouter · React · MediaPipe Tasks Vision · ngrok
