# SightSea: project notes

**Read this first** (people and AI assistants alike). Update it when you change how something works.

SightSea (formerly Guardian) is a hands-free guide for blind and low-vision walkers (Technica 2026). A phone on the chest watches the path and warns about anything coming at you fast; a wrist camera answers "what am I pointing at?"; a wearable handles fall detection and asks passersby for help.

---

## How to run it

**Windows, one step:** double-click `start.bat` in the project root (or run `.\start.bat` in PowerShell from the root, not from `frontend`). It:
1. checks for Node.js, Python and ngrok and installs any that are missing;
2. asks once for your ngrok token and Gemini key (saved to `backend\.env`);
3. installs packages, builds the app, and starts the backend and the public link;
4. prints the `https://...ngrok-free.app` link and copies it. Open it on any phone.

Faster restarts: `.\start.bat -SkipInstall -SkipBuild`

**By hand** (any OS):
```
cd frontend && npm install && npm run build
cd ../backend && pip install -r requirements.txt && python Main.py
ngrok http 5000          # in a second terminal
```

On the phone: open the https link, tap **Visit Site** on ngrok's notice, allow the camera, then **tap the screen once** so sound works. Use Chrome where possible.

**Touch controls:** tap a control once to hear what it is, **double-tap** to use it (like VoiceOver). The fall alarm's "I'm okay" always works on one tap. Mouse and keyboard work normally. Turn it off in Settings (VoiceOver/TalkBack users should).

---

## Keys and settings

- Real keys live in `backend/.env` on each laptop. That file is gitignored and must **never** be committed.
- `backend/.env.example` lists every setting with no values. Copy it to `.env` and fill it in.
- Share real key values privately (a shared password-manager vault such as Bitwarden).
- **Whose keys get used?** Those in the `.env` of whichever laptop is running the backend (the one the ngrok link points to). The phone never holds keys. To check, the backend's startup log and `/health` show the **last 4 characters** of each key it loaded.
- No key yet? Set `MOCK_VISION=1` for fake descriptions (no quota used).

---

## Architecture

```
Phone (React web app, chest-mounted)            Laptop (Flask, backend/Main.py)          Arduino wearable
- camera + hazard watch (ON-DEVICE, no network) - /narrate  Gemini scene descriptions    - fall detection (accelerometer)
- speech: hazard > answers > narration (natural ElevenLabs voice, cached; phone voice fallback)          - /identify Gemini names an object        - light sensor, LCD, buzzer, button
- polls /events every 1 s                       - /events   wearable + wrist events       - USB cable OR Wi-Fi (phone hotspot)
                                                - wrist webcam (OpenCV)
                                                - serves the built app on port 5000
```

### Hazard watch (`frontend/src/hazard.js`, `frontend/src/looming.js`)
Runs only in **Live guide** mode (Settings toggle can turn it off). Two detectors run together on the phone:
1. **Object detector** (MediaPipe EfficientDet-Lite0, 80 categories). Tracks boxes; time-to-contact = how fast a box grows. Known objects get named on-device; a second model (EfficientNet-Lite0, 1,000 categories) refines the name once per warning ("Cat" becomes "Tiger").
2. **Looming detector** (model-free). Measures expansion of image patches on a 160x120 copy of the frame, so it catches **anything** approaching, even unrecognized objects. Requires expansion in both directions, so turning, swaying and objects sliding past don't trigger it.

On a warning: instant beep + vibration + short speech ("Bike ahead!", "Something, right!"). If the object wasn't named well, the crop goes to `/identify` and Gemini's name is spoken right after ("It's a shopping cart.").

Tuning lives in the "Tunables" blocks at the top of both files (time-to-contact limits per class, confirmation frames, looming thresholds). The Settings sensitivity (low/normal/high) scales all limits.

### Wrist camera, "point to ask" (`backend/camera.py`)
A USB webcam on the forearm, plugged into the laptop. With it connected, pressing the wearable button describes what the wrist camera sees; the **chest phone speaks** the answer (one voice). Without it, the button describes from the chest camera. Pick the camera with `WRIST_CAMERA=` in `.env` (default 1; 0 is usually the laptop's own camera); check the aim at `http://localhost:5000/wrist/snapshot.jpg`.

The same webcam also powers **Settings > Camera > Wearable**: the app's camera view shows it (`/camera/stream`) and Tap / Live guide describe from it (`/narrate` with `source=wearable`; the server skips the AI when the view hasn't changed). Hazard watch needs the phone's own video, so it pauses in that mode. One module (`camera.py`) serves both, so they never fight over the camera.

### Wearable (`firmware/guardian/guardian.ino`, laptop side `backend/hardware.py`)
Arduino UNO R4 WiFi + Grove shield: button D2, buzzer D3, light sensor A0, accelerometer and LCD on I2C. Fall = free-fall or impact, then stillness, then a **30 s countdown** (double-click the button or tap "I'm okay" to cancel), then the alarm.

**Button** (one button; patterns detected on the board, also listed in the app's Settings):
| Press | Action |
|---|---|
| Press | Describe what's ahead (wrist camera if connected, else the phone) |
| Double press | Switch Tap mode / Live guide (spoken) |
| Hold 1–3 s, then let go | Stop everything: silence, drop answers still on the way, Live guide + hazard watch off ("Stopped.") |
| Hold 3 s | Repeat the last thing said (fires at 3 s, while still held) |
| During a fall countdown or alarm | Double press cancels; single presses and holds are ignored |

A single press acts ~0.4 s after release (it waits to rule out a double press). "Stop" happens on release, so holding on to 3 s gives repeat instead. Stop never cancels a fall alarm. Board messages: `BTN`, `BTN2`, `STOP`, `BTNHOLD` (sent through the same `out` link, so they work over USB and Wi-Fi). Timing constants: `MULTI_CLICK_MS`, `STOP_HOLD_MS`, `REPEAT_HOLD_MS` in the firmware.

It talks to the laptop over **USB, Wi-Fi, or both** (same messages either way; USB wins when both are up, so nothing is handled twice). The app's status shows which: "Online, wearable on Wi-Fi / USB".

#### Wireless setup (no laptop on your back)
The laptop sits on a table; the wearable is powered by the iPhone (or a battery) and talks over the iPhone's hotspot. The **laptop finds the Arduino** (it asks every address on its network, PING -> READY on TCP 5005), so there's **no Windows firewall prompt**.
1. **iPhone:** Settings > Personal Hotspot > turn on **Allow Others to Join** and **Maximize Compatibility** (the board only uses 2.4 GHz Wi-Fi).
2. **Firmware:** in `firmware/guardian/`, copy `arduino_secrets.h.example` to `arduino_secrets.h`, fill in the hotspot name and password, and upload with the Arduino IDE (USB, once). `arduino_secrets.h` is gitignored. Without it the sketch is USB-only.
3. The LCD shows "Joining WiFi", then **"WiFi connected"** and the board's address (e.g. `172.20.10.4`).
4. **Laptop:** join the same hotspot and start the backend. Within a few seconds: `[hardware] connected over WIFI (WiFi 172.20.10.4)` and the phone says "Wearable connected over Wi-Fi." The wearable can be switched on before or after the server starts.
5. **Power:** unplug from the laptop and plug the Arduino into the **iPhone's USB-C port** or a USB battery.
6. **If it never connects:** put the address from the LCD in `backend/.env` as `ARDUINO_HOST=172.20.10.4` and restart the backend.

USB always works too: plug the cable in and the laptop uses it first. If the link drops, the laptop keeps retrying USB and Wi-Fi; the board retries Wi-Fi every 15 s (never during a fall countdown). Charge the iPhone before demoing: camera + AI + hotspot + powering the board drains it faster.

### Backend endpoints (`backend/Main.py`)
| Endpoint | What it does |
|---|---|
| `/health` | status, which keys are loaded (last 4 chars), wearable link (usb/wifi), webcam |
| `POST /narrate` | scene description (tap and live modes) |
| `POST /identify` | 1–4 word name of an object crop (hazard follow-up) |
| `POST /speak`, `GET /voices` | natural voice for any phrase (cached on disk in `backend/.tts_cache`), voice list for the picker |
| `/camera/stream`, `/camera/status` | the USB webcam's live view for Settings > Camera > Wearable |
| `GET /events` | wearable and wrist events for the phone (button, fall, dark...) |
| `/wrist/describe`, `/wrist/snapshot.jpg` | test the wrist camera |
| `/lcd`, `/cancel`, `/alarm`, `/fall-detection` | wearable controls |
| `/test/<fall\|button\|double\|stop\|hold\|cancel\|dark>` | fake events for testing (real wearable if connected, else simulated) |

---

## Working together (two people, two AI assistants)

- Work on **your own branch**; merge through pull requests. Don't both push to the same branch at once.
- `hazard-watch` was **merged into `main`** (Sat ~10 pm, together with the SightSea UI, voice and Wi-Fi work). **Start new branches from `main`.**
- Before starting work: `git checkout main && git pull`, then read this file.
- After changing anything, update this file and write a clear commit message. That's how the other person's assistant finds out what changed.
- Never commit `backend/.env`. Check `git status` before pushing.

---

## Status

**Built**
- Phone app (SightSea): one-screen layout that never scrolls, big camera view with the spoken description below it, full-screen Settings, tap-to-hear / double-tap-to-use, natural voice for everything with a voice picker (phrases cached so repeats cost no credits), Live guide, hazard watch (object + looming), spoken warnings with follow-up names, fall countdown screen, wearable message editor
- Backend: Gemini with model fallback, ElevenLabs voice (optional), OpenRouter backup, wrist camera, `/identify`
- Wearable: fall detection with countdown, light sensor, LCD, buzzer, one button (press / double / hold 1 s to stop / hold 3 s to repeat); USB or Wi-Fi (phone hotspot, the laptop finds it, powered by the iPhone)
- `start.bat` one-click setup and public link
- Poster (design canvas in claude.ai)

**Planned / ideas, not built yet**
- Cane sleeve: elastic wrap with two buttons (round = ask / double = Live guide; ridged = repeat / hold = I'm okay) and a vibration motor for hazard buzzes
- Fall countdown 10 s for demos (currently 30 s)
- Always-on cloud hosting (Google Cloud Run), so the website works without the laptop
- "What's connected" panel in the app

---

## Known limits
- Hazard watch is tested on simulated video. Tune thresholds on the real camera.
- Wi-Fi wearable is tested with a simulated board and a compile check, not yet on the real Arduino and iPhone hotspot.
- ElevenLabs keys can have their own credit limit; when it runs out the app uses the phone's voice and the backend says so (retries after 5 min).
- The looming detector catches unrecognized objects later (they must cover a reasonable patch of the view) and struggles with plain, textureless surfaces.
- Two phones on the same backend split wearable events between them. Use one phone as "the user's" phone.
- Python 3.15 may lack some package builds (OpenCV). Use Python 3.12 if `pip install` fails.
- The laptop must stay on for the public link to work.
