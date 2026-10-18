# Guardian: project notes

**Read this first** (people and AI assistants alike). Update it when you change how something works.

Guardian is a hands-free guide for blind and low-vision walkers (Technica 2026). A phone on the chest watches the path and warns about anything coming at you fast; a wrist camera answers "what am I pointing at?"; a wearable handles fall detection and asks passersby for help.

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
- speech: hazard > answers > narration          - /identify Gemini names an object        - light sensor, LCD, buzzer, button
- polls /events every 1 s                       - /events   wearable + wrist events       - serial over USB to the laptop
                                                - wrist webcam (OpenCV)
                                                - serves the built app on port 5000
```

### Hazard watch (`frontend/src/hazard.js`, `frontend/src/looming.js`)
Runs only in **Live guide** mode (Settings toggle can turn it off). Two detectors run together on the phone:
1. **Object detector** (MediaPipe EfficientDet-Lite0, 80 categories). Tracks boxes; time-to-contact = how fast a box grows. Known objects get named on-device; a second model (EfficientNet-Lite0, 1,000 categories) refines the name once per warning ("Cat" becomes "Tiger").
2. **Looming detector** (model-free). Measures expansion of image patches on a 160x120 copy of the frame, so it catches **anything** approaching, even unrecognized objects. Requires expansion in both directions, so turning, swaying and objects sliding past don't trigger it.

On a warning: instant beep + vibration + short speech ("Bike ahead!", "Something, right!"). If the object wasn't named well, the crop goes to `/identify` and Gemini's name is spoken right after ("It's a shopping cart.").

Tuning lives in the "Tunables" blocks at the top of both files (time-to-contact limits per class, confirmation frames, looming thresholds). The Settings sensitivity (low/normal/high) scales all limits.

### Wrist camera, "point to ask" (`backend/wrist_camera.py`)
A USB webcam on the forearm, plugged into the laptop. With it connected, pressing the wearable button describes what the wrist camera sees; the **chest phone speaks** the answer (one voice). Without it, the button describes from the chest camera. Pick the camera with `WRIST_CAMERA=` in `.env`; check the aim at `http://localhost:5000/wrist/snapshot.jpg`.

### Wearable (`firmware/guardian/guardian.ino`)
Arduino UNO R4 WiFi + Grove shield: button D2, buzzer D3, light sensor A0, accelerometer and LCD on I2C. Fall = free-fall or impact, then stillness, then a **30 s countdown** (double-click the button or tap "I'm okay" to cancel), then the alarm.

### Backend endpoints (`backend/Main.py`)
| Endpoint | What it does |
|---|---|
| `/health` | status, which keys are loaded (last 4 chars), wrist camera |
| `POST /narrate` | scene description (tap and live modes) |
| `POST /identify` | 1–4 word name of an object crop (hazard follow-up) |
| `GET /events` | wearable and wrist events for the phone (button, fall, dark...) |
| `/wrist/describe`, `/wrist/snapshot.jpg` | test the wrist camera |
| `/lcd`, `/cancel`, `/alarm`, `/fall-detection` | wearable controls |
| `/test/<fall\|button\|cancel\|dark>` | fake events for testing |

---

## Working together (two people, two AI assistants)

- Work on **your own branch**; merge through pull requests. Don't both push to the same branch at once.
- Current feature branch: `hazard-watch` (not yet merged into `main`).
- After changing anything, update this file and write a clear commit message. That's how the other person's assistant finds out what changed.
- Never commit `backend/.env`. Check `git status` before pushing.

---

## Status

**Built**
- Phone app: tap-to-describe, Live guide, hazard watch (object + looming), spoken warnings with follow-up names, settings, wearable message editor
- Backend: Gemini with model fallback, ElevenLabs voice (optional), OpenRouter backup, wrist camera, `/identify`
- Wearable: fall detection with countdown, light sensor, LCD, buzzer, button
- `start.bat` one-click setup and public link
- Poster (design canvas in claude.ai)

**Planned / ideas, not built yet**
- Cane sleeve: elastic wrap with two buttons (round = ask / double = Live guide; ridged = repeat / hold = I'm okay) and a vibration motor for hazard buzzes
- Second Grove button on D4 and press patterns in firmware
- Fall countdown 10 s for demos (currently 30 s)
- Wireless wearable (currently USB to the laptop)

---

## Known limits
- Hazard watch is tested on simulated video. Tune thresholds on the real camera.
- The looming detector catches unrecognized objects later (they must cover a reasonable patch of the view) and struggles with plain, textureless surfaces.
- Two phones on the same backend split wearable events between them. Use one phone as "the user's" phone.
- Python 3.15 may lack some package builds (OpenCV). Use Python 3.12 if `pip install` fails.
- The laptop must stay on for the public link to work.
