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

### Wrist camera, "point to ask" (`backend/wrist_camera.py`)
A USB webcam on the forearm, plugged into the laptop. With it connected, pressing the wearable button describes what the wrist camera sees; the **chest phone speaks** the answer (one voice). Without it, the button describes from the chest camera. Pick the camera with `WRIST_CAMERA=` in `.env`; check the aim at `http://localhost:5000/wrist/snapshot.jpg`.

### Wearable (`firmware/guardian/guardian.ino`, laptop side `backend/hardware.py`)
Arduino UNO R4 WiFi + Grove shield: button D2, buzzer D3, light sensor A0, accelerometer and LCD on I2C. ("D2" = the shield socket wired to digital pin 2.) Fall = free-fall or impact, then stillness, then a **30 s countdown** (double-click the button or tap "I'm okay" to cancel), then the alarm.

**Button** (one button; patterns detected on the board, also listed in the app's Settings):
| Press | Action |
|---|---|
| Press | Describe what's ahead (wrist camera if connected, else the chest phone) |
| Double press | Switch Tap mode / Live guide (spoken) |
| Hold 1–3 s, then let go | Stop everything: silence, drop answers still on the way, Live guide + hazard watch off ("Stopped.") |
| Hold 3 s | Repeat the last thing said (fires at 3 s, while still held) |
| During a fall countdown or alarm | Double press cancels; single presses and holds are ignored |

A single press acts ~0.4 s after release (it waits to rule out a double press). "Stop" happens on release, so holding on to 3 s gives repeat instead. Stop never cancels a fall alarm. The phone also has a **Stop everything** button. Timing constants: `MULTI_CLICK_MS`, `STOP_HOLD_MS`, `REPEAT_HOLD_MS` in the firmware.

**One button only:** set `#define HAS_BUTTON2 0` at the top of the firmware (an empty pin reads random noise). Then: press = describe (acts ~0.4 s after release, to rule out a double), double press = switch mode, hold 1 s = repeat (on release), hold 3 s = help. Timing constants: `MULTI_CLICK_MS`, `HOLD_MS`, `HELP_HOLD_MS`.

It talks to the laptop over **USB, Wi-Fi, or both** (same messages either way; USB wins when both are up, so nothing is handled twice). The app's status shows which: "Online, wearable on Wi-Fi / USB".

#### Wireless setup (no laptop on your back)
The laptop sits on a table; the wearable is powered by the iPhone and talks over the iPhone's hotspot.
1. **iPhone:** Settings > General > About > **Name**: rename it to something plain like `IanPhone` (iPhone names use a curly apostrophe, "Ian’s iPhone", that won't match one typed into the firmware). Then Settings > Personal Hotspot > turn on **Allow Others to Join** and **Maximize Compatibility** (the board only uses 2.4 GHz Wi-Fi). Keep that screen open while things connect the first time.
2. **Laptop:** join the iPhone's hotspot, then run `start.bat`. It sets the hotspot to a **Private** network and adds a firewall rule for the wearable if it can; if it says it can't (needs admin), follow what it prints. When Windows asks about Python, **allow it on private and public networks.**
3. **Firmware:** in `firmware/guardian/`, copy `secrets.example.h` to `secrets.h`, fill in the hotspot name (exactly as renamed) and password, and upload with the Arduino IDE (USB, once). `secrets.h` is gitignored.
4. **Power:** unplug from the laptop and plug the Arduino into the **iPhone 15's USB-C port** (USB-C cable). The LCD shows "Wi-Fi..." then the normal message; within a few seconds the phone says "Wearable connected over Wi-Fi."
5. **If it never connects:** check the backend window. After 30 s without the wearable it prints a checklist, including "this laptop's addresses". Put that address in `secrets.h` as `#define LAPTOP_IP 172,20,10,2` (commas, not dots) and upload again. Some hotspots block the broadcast the board uses to find the laptop.

Tips: the Arduino IDE Serial Monitor shows `WIFI:` lines (connecting, IP, not found). Charge the iPhone before demoing: camera + AI + hotspot + powering the board drains it faster. While the hotspot is missing, the board retries every 15–60 s, and each try pauses the board for a few seconds; remove `secrets.h` for USB-only use.

### Backend endpoints (`backend/Main.py`)
| Endpoint | What it does |
|---|---|
| `/health` | status, which keys are loaded (last 4 chars), wearable link (usb/wifi), wrist camera |
| `POST /narrate` | scene description (tap and live modes) |
| `POST /identify` | 1–4 word name of an object crop (hazard follow-up) |
| `GET /events` | wearable and wrist events for the phone (button, fall, dark...) |
| `/wrist/describe`, `/wrist/snapshot.jpg` | test the wrist camera |
| `/lcd`, `/cancel`, `/alarm`, `/fall-detection` | wearable controls |
| `/test/<fall\|button\|double\|stop\|hold\|cancel\|dark>` | fake events for testing (real wearable if connected, else simulated) |

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
- Wearable: fall detection with countdown, light sensor, LCD, buzzer, one button (press / double / hold to stop / hold 3 s to repeat); USB or Wi-Fi (phone hotspot, powered by the iPhone)
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
- The looming detector catches unrecognized objects later (they must cover a reasonable patch of the view) and struggles with plain, textureless surfaces.
- Two phones on the same backend split wearable events between them. Use one phone as "the user's" phone.
- Python 3.15 may lack some package builds (OpenCV). Use Python 3.12 if `pip install` fails.
- The laptop must stay on for the public link to work.
