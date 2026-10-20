# SightSea

**A guide for blind and low-vision people.** Wear your phone on your chest or hold it up, or wear a small camera on your wrist, and SightSea tells you what's in your path and warns about anything coming at you fast. Point the camera at something and press a button to ask "what is this?". A small wearable detects falls and asks people nearby for help.

Built at **Technica 2026** (University of Maryland) by Diana DeRosa and Ian Yoon. 

---

## What it does

| | Feature | How it works |
|---|---|---|
| 🗣️ | **Tap to describe** | Double-tap the screen or press the wearable button. Gemini describes the scene in 1–2 sentences, obstacles and directions first, spoken in a natural ElevenLabs voice. |
| 🌊 | **Live guide** | Watches your path and speaks only about your next few steps: "Chair ahead, two steps." "Stairs going down." It ignores carpets, side walls and room descriptions, and never repeats itself. |
| ⚠️ | **Hazard watch** | Runs **on the phone, offline, in a fraction of a second**. Calm heads-ups first ("Someone is coming toward you", "Table ahead, in your path"), then an urgent chime and warning if something is about to hit you. A "looming" detector measures how fast parts of the view are expanding (time to contact), so it also catches things it can't name. Uses the phone camera. |
| 👉 | **Point to ask** | Point the phone, or a wearable camera, at something and press the button: "That's a blue water bottle." Reads signs and labels too. |
| 📷 | **Your choice of camera** | Use the phone's own camera, worn on the chest in a holder or held and pointed, or a small USB camera worn on the wrist, chest or a cap. Switch in Settings. |
| 🆘 | **Fall detection** | Accelerometer looks for free-fall or impact followed by stillness. A 30-second spoken countdown follows (double-press the button or tap "I'm okay" to cancel), then a buzzer and red LCD saying **"I've fallen! Please help me"** for people nearby. |
| 🔆 | **Dark warning** | A light sensor warns when it's getting dark around you. |
| 🪧 | **LCD for passersby** | Shows a message such as "Low vision / Thanks for help", editable from the app. |

**Accessible by design:** tap anything once to hear what it is, double-tap to use it, like a screen reader. Labels are pre-loaded in the natural voice so they play instantly. Large high-contrast "sunlit shallows" theme, Atkinson Hyperlegible font, one screen with no scrolling, every alert spoken, a choice of ElevenLabs voices, and decoration that stays out of screen readers and stops moving with Reduce Motion.

### Wearable button
| Press | Action |
|---|---|
| Press | Describe what's ahead (or what the wearable camera points at) |
| Double press | Switch Tap mode / Live guide |
| Hold 1 s, let go | Stop talking, Live guide off |
| Double press during a fall | Cancel the alarm |

---

## How it works

```
 Phone (React web app)                   Laptop (Python / Flask)                 Wearable (Arduino UNO R4 WiFi)
 ┌───────────────────────────┐  HTTPS   ┌──────────────────────────────┐  Wi-Fi  ┌───────────────────────────┐
 │ camera view               │ (ngrok)  │ /narrate  → Gemini vision    │  TCP    │ accelerometer (falls)     │
 │ hazard watch (on-device,  │ ───────► │ /speak    → ElevenLabs voice │ ◄─────► │ light sensor              │
 │   MediaPipe + looming)    │ ◄─────── │ /events   ← wearable events  │  or USB │ button, buzzer, RGB LCD   │
 │ speech, settings, alerts  │          │ webcam    → "point to ask"   │         └───────────────────────────┘
 └───────────────────────────┘          └──────────────────────────────┘
                                                   ▲ USB
                                         wearable camera
                                     (chest, wrist or cap)
```

- **Phone:** React app served by Flask through ngrok, so any phone browser works with nothing to install. Hazard watch runs entirely in the browser: MediaPipe EfficientDet-Lite0 detection with tracking, where an object's box growing over time gives its time to contact, plus a model-free looming detector (block-matching optical flow with scale fitting). Gemini names unfamiliar hazards a moment after the warning.
- **Laptop:** Flask server. Gemini vision with automatic fallback across models (and OpenRouter as a backup), ElevenLabs text-to-speech with a disk cache, an OpenCV webcam reader, and the wearable link.
- **Wearable:** Arduino UNO R4 WiFi with a Grove Base Shield. It joins the phone's hotspot; the laptop finds it automatically by scanning its subnet (USB works too). A simple line protocol carries `BTN`, `FALL_PENDING:30`, `FALL`, `LIGHT:512` and commands such as `LCD:…` and `ALARM:ON`.

---

## Hardware

- Arduino UNO R4 WiFi + Grove Base Shield (switch set to **5V**)
- Grove: 3-axis accelerometer (MMA7660; ADXL345/LIS3DH also detected), light sensor (A0), button (D2), buzzer (D3), RGB LCD 16×2 (I2C)
- Optional USB webcam, worn on the chest, wrist or a cap
- A phone (with a chest strap or lanyard holder), and a power bank or the phone's USB-C to power the Arduino

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

## What's next

- A small wireless wearable camera (such as an ESP32-CAM) instead of a USB cable
- Running the server in the cloud or on the phone, so no laptop is needed
- Texting an emergency contact with your location when the fall alarm goes off
- A vibration motor for silent hazard alerts, and testing with blind and low-vision users

---

## Built with

Arduino (C++) · Python · Flask · OpenCV · pyserial · Google Gemini · ElevenLabs · OpenRouter · React · MediaPipe Tasks Vision · ngrok · Claude
