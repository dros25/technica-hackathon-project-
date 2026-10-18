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

**Touch controls:** tap a control once to hear what it is, **double-tap** to use it (like VoiceOver). This includes the camera view: one tap says "Tap to describe…", the **second** tap takes the picture. The fall alarm's "I'm okay" always works on one tap. Mouse and keyboard work normally. Turn it off in Settings (VoiceOver/TalkBack users should); then one tap on the camera view describes right away.

**ngrok free plan limits** (per ngrok *account*, not per laptop): **20,000 requests and 1 GB of data a month**. Check usage on the ngrok dashboard. What uses them:
- Each open SightSea page waits on `/events` (long poll): about **3 requests a minute** idle (it was 60 a minute before the long poll). Close tabs and phones you're not using.
- Each description: 1 request (plus 1 for a phrase spoken in the natural voice for the first time).
- The **Wearable camera live view** (Settings > Camera > Wearable) streams pictures through ngrok: up to ~0.5 GB an hour. Keep the camera on **Phone** unless you need the wrist camera.
- The AI models for hazard watch load from Google's servers, not through ngrok.
- One account nearly ran out (19.8k requests, Sun ~3:30 am) before the long poll; the backend now runs on the other teammate's ngrok token. Backup if ngrok runs out: a Cloudflare quick tunnel (`winget install Cloudflare.cloudflared`, then `cloudflared tunnel --url http://localhost:5000`): free, no account, no request limit, no "Visit Site" page, but a new link every start.

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
- waits on /events (long poll, see below)       - /events   wearable + wrist events       - USB cable OR Wi-Fi (phone hotspot)
                                                - wrist webcam (OpenCV)
                                                - serves the built app on port 5000
```

### How a description happens, and where the time goes
**Phone tap** (double-tap the camera view) or **wearable button press**:
1. Button only: the board waits 0.4 s to make sure it isn't a double press, then sends `BUTTON` over USB/Wi-Fi to the laptop.
2. Button only: the phone hears about it through the long poll (~0.1-0.2 s, see below).
3. The phone grabs a camera frame (640 px JPEG for a tap, 480 px lighter JPEG for Live guide checks) and uploads it to `/narrate` through ngrok. With the wrist webcam plugged in, the laptop grabs the frame itself instead (no upload) and the answer comes back as a `wrist_description` event.
4. The laptop asks Gemini (no "thinking" step, short length cap, for speed; it falls back per model to lower thinking, then a plain call, if a model rejects those settings).
5. The laptop asks ElevenLabs for the audio, **after** Gemini finishes, and sends text + audio back together.
6. The phone plays it.

Steps 4 and 5 are most of the wait. The backend window prints both: `[narrate] <model name> in 1.4s: ...` (the Gemini time) then `[narrate] voice in 0.9s`. Ideas not done yet: speak with the phone voice as soon as the text arrives (or stream the ElevenLabs audio), pre-load common phrases in the natural voice at startup, shorten the board's double-press wait to 0.3 s, and one-tap for the camera view (decided against for now).

### Wearable events reach the phone by long poll (`/events?since=N&wait=20`)
A web page can only ask, the server can only answer, so the laptop can't push a button press to the phone by itself. Before: the phone asked "anything new?" every second (0-1 s delay, 3,600 requests an hour, almost all "no"). Now: the phone asks once and the laptop **holds the request** until something happens (button, fall, dark, wearable connected/disconnected) or 20 s pass, then answers; the phone asks again right away (after 2 s if the server can't be reached). Measured: a button press reached the phone in ~200 ms, and 2 requests in 45 s idle. Events are numbered (`since=N`), so nothing is missed between requests. Flask runs `threaded=True` so a held request doesn't block descriptions. Old pages without `wait` still get an immediate answer.

### Voices
Descriptions use the chosen ElevenLabs voice (cached per phrase on the phone and in `backend/.tts_cache`). The phone's own voice is used when the natural voice isn't ready: hazard warnings and button labels the first time a phrase is said, a slow (>7 s) or failed ElevenLabs request, ElevenLabs out of credits, or audio playback blocked. The phone voice now matches the ElevenLabs voice's **gender**, so it no longer flips between a man and a woman (it is still a different-sounding voice).

### Hazard watch (`frontend/src/hazard.js`, `frontend/src/looming.js`)
Runs only in **Live guide** mode (Settings toggle can turn it off). Two detectors run together on the phone:
1. **Object detector** (MediaPipe EfficientDet-Lite0, 80 categories). Tracks boxes; time-to-contact = how fast a box grows. Known objects get named on-device; a second model (EfficientNet-Lite0, 1,000 categories) refines the name once per warning ("Cat" becomes "Tiger").
2. **Looming detector** (model-free). Measures expansion of image patches on a 160x120 copy of the frame, so it catches **anything** approaching, even unrecognized objects. Requires expansion in both directions, so turning, swaying and objects sliding past don't trigger it.

Three kinds of alert:
- **Fast collision warning** (something coming at you quickly): instant beep + vibration + short speech ("Bike ahead!", "Something, right!"). If the object wasn't named well, the crop goes to `/identify` and Gemini's name is spoken right after ("It's a shopping cart.").
- **In your path** (you're walking toward a still object): goes by **distance, not speed**. "Chair ahead, a few steps." (~4 m) then, once it's about a step away, "Chair right in front of you." (~1.5 m). Standing still or passing it off to the side: nothing.
- **Heads-up** (a person or vehicle moving toward you, not urgent): "Person is coming toward you, on your left."

The Live guide's Gemini check (every few seconds) follows the same rule: only things in the path within ~4 steps, always with the number of steps, and spoken again only when closer.

Tuning lives in the "Tunables" blocks at the top of both files (time-to-contact limits per class, confirmation frames, looming thresholds). The Settings sensitivity (low/normal/high) scales all limits.

### Wrist camera, "point to ask" (`backend/camera.py`)
A USB webcam on the forearm, plugged into the laptop. With it connected, pressing the wearable button describes what the wrist camera sees; the **chest phone speaks** the answer (one voice). Without it, the button describes from the chest camera. Pick the camera with `WRIST_CAMERA=` in `.env` (default 1; 0 is usually the laptop's own camera); check the aim at `http://localhost:5000/wrist/snapshot.jpg`.

The same webcam also powers **Settings > Camera > Wearable**: the app's camera view shows it (`/camera/stream`) and Tap / Live guide describe from it (`/narrate` with `source=wearable`; the server skips the AI when the view hasn't changed). Hazard watch needs the phone's own video, so it pauses in that mode. One module (`camera.py`) serves both, so they never fight over the camera.

### Wearable (`firmware/guardian/guardian.ino`, laptop side `backend/hardware.py`)
Arduino UNO R4 WiFi + Grove shield: button D2, buzzer D3, light sensor A0, accelerometer and LCD on I2C. Fall detection is tuned for a **wrist-worn** sensor (arms flail, so it never demands perfect stillness): read 100 times a second (sensor set to 200 Hz so short impact spikes stay sharp); **1)** a drop then a hit (below 0.6 g for 80 ms, then above 2 g within 1 s) **or** one hard hit alone (above 3 g); **2)** then **mostly still**: 80% of readings within 0.35 g of 1 g over any 2 s, within 10 s of the hit (arm movement here and there is fine); **3)** then a **30 s countdown** (double-click the button or tap "I'm okay" to cancel), then the alarm. It decides ~2.3 s after the hit. Known false alarm: a very hard cane tap followed by standing completely still for 2 s (the countdown covers it). Thresholds are in the firmware's fall-detection tunables; send `STREAM` over USB to watch live g-force while tuning. Button (outside a fall): **press** = describe what's ahead (always a fresh look); **double press** = switch Tap mode / Live guide; **hold 1 s and let go** = stop talking (and Live guide off). There's no "repeat the last thing" gesture: it made a normal press sound like it repeated itself.

**Work on `main` only.** `hazard-watch` is merged and no longer used: `git checkout main && git pull`. Anything pushed to `hazard-watch` after a merge is missing the newer work on `main`.

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
| `GET /events` | wearable and wrist events for the phone (button, fall, dark...); `?since=N&wait=20` = long poll |
| `/wrist/describe`, `/wrist/snapshot.jpg` | test the wrist camera |
| `/lcd`, `/cancel`, `/alarm`, `/fall-detection` | wearable controls |
| `/test/<fall\|button\|double\|stop\|cancel\|dark>` | fake events for testing (real wearable if connected, else simulated) |

---

## Working together (two people, two AI assistants)

- Work on **your own branch**; merge through pull requests. Don't both push to the same branch at once.
- `hazard-watch` was **merged into `main`** (Sat ~10 pm, together with the SightSea UI, voice and Wi-Fi work). **Start new branches from `main`.**
- Before starting work: `git checkout main && git pull`, then read this file.
- After changing anything, update this file and write a clear commit message. That's how the other person's assistant finds out what changed.
- Never commit `backend/.env`. Check `git status` before pushing.
- **Finished branches (safe to delete):** `hazard-watch` (merged Sat ~10 pm), `buttons` (pull request #1, scrapped: `main` already has the button work), `fall-detection` (pull request #2, merged Sun ~1 am: wrist fall detection). Delete a finished branch on GitHub from its pull request page ("Delete branch") or the repo's Branches page (trash icon); locally with `git branch -d <name>` while on `main`.

---

## Status

**Built**
- Phone app (SightSea): one-screen layout that never scrolls, big camera view with the spoken description below it, full-screen Settings, tap-to-hear / double-tap-to-use, natural voice for everything with a voice picker (phrases cached so repeats cost no credits), Live guide, hazard watch (object + looming), spoken warnings with follow-up names, fall countdown screen, wearable message editor
- Backend: Gemini with model fallback, ElevenLabs voice (optional), OpenRouter backup, wrist camera, `/identify`
- Wearable: fall detection with countdown, light sensor, LCD, buzzer, button; USB or Wi-Fi (phone hotspot, the laptop finds it, powered by the iPhone)
- `start.bat` one-click setup and public link
- Poster (design canvas in claude.ai)

**Planned / ideas, not built yet**
- Cane sleeve: elastic wrap with two buttons (round = ask / double = Live guide; ridged = repeat / hold = I'm okay) and a vibration motor for hazard buzzes
- Second Grove button on D4 and press patterns in firmware
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
