"""
camera.py - the USB webcam worn by the user (wrist or chest), plugged into the laptop.

One module serves both uses, so they never fight over the same camera:
  * "Point to ask": with the webcam connected, the wearable button describes what it sees
    (wrist_* events in Main.py).
  * Settings > Camera > Wearable: the app's camera view, Tap and Live guide use this webcam.

A background thread keeps reading frames, so a snapshot is always the *current* view
(webcams otherwise hand you a stale buffered frame). If the camera is unplugged it keeps
retrying, so it can be plugged in after the server starts.

Install:  pip install opencv-python
.env:     WRIST_CAMERA=1     camera index (default 1; 0 is usually the laptop's own camera)
          WRIST_CAMERA=off   disable it (the button then describes from the phone camera)
          (CAMERA_INDEX=... works too)
"""

import os
import platform
import threading
import time

os.environ.setdefault("OPENCV_LOG_LEVEL", "SILENT")  # no error spam while waiting for the camera
os.environ.setdefault("OPENCV_VIDEOIO_PRIORITY_OBSENSOR", "0")
try:
    import cv2
    try:
        cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_SILENT)
    except AttributeError:
        pass
except ImportError:  # server still runs; the phone camera still works
    cv2 = None

FRESH_S = 2.0  # a frame older than this means the camera has stopped


class Webcam:
    def __init__(self):
        setting = (os.getenv("WRIST_CAMERA") or os.getenv("CAMERA_INDEX") or "1").strip().lower()
        self.enabled = cv2 is not None and setting.isdigit()
        self.index = int(setting) if self.enabled else None
        self._cap = None
        self._frame = None
        self._frame_at = 0.0
        self._lock = threading.Lock()
        if cv2 is None:
            self.error = "OpenCV not installed (pip install opencv-python)"
        elif not self.enabled:
            self.error = "Webcam turned off (WRIST_CAMERA=off in .env)"
        else:
            self.error = f"No webcam at index {self.index} yet. Plug it in, or set WRIST_CAMERA in .env."
            threading.Thread(target=self._loop, daemon=True).start()
        if self.error and not self.enabled:
            print(f"[camera] {self.error}")

    # ---------- reading ----------
    def _open(self):
        # DirectShow opens webcams much faster on Windows than the default backend
        api = cv2.CAP_DSHOW if platform.system() == "Windows" else cv2.CAP_ANY
        cap = cv2.VideoCapture(self.index, api)
        if not cap.isOpened():
            cap.release()
            return None
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    def _loop(self):
        said_missing = False
        while True:
            if self._cap is None:
                self._cap = self._open()
                if self._cap is None:
                    if not said_missing:
                        print(f"[camera] no webcam at index {self.index} yet - plug it in, "
                              "or set WRIST_CAMERA to another number in .env")
                        said_missing = True
                    time.sleep(3)
                    continue
                print(f"[camera] webcam {self.index} ready")
                self.error = None
                said_missing = False
            ok, frame = self._cap.read()
            if not ok:
                print("[camera] webcam stopped sending frames, reconnecting...")
                self.error = "The webcam disconnected."
                self._cap.release()
                self._cap = None
                time.sleep(1)
                continue
            with self._lock:
                self._frame = frame
                self._frame_at = time.time()

    def _latest(self):
        with self._lock:
            if self._frame is None or time.time() - self._frame_at > FRESH_S:
                return None
            return self._frame.copy()

    # ---------- what the server uses ----------
    @property
    def available(self):
        return self.enabled and self._frame is not None and time.time() - self._frame_at < FRESH_S

    def open(self):
        """Compatibility: the camera opens itself in the background; just report availability."""
        return self.available

    def jpeg(self, width=640, quality=80):
        """Current view as JPEG bytes (resized to `width`), or None if no fresh frame."""
        frame = self._latest()
        if frame is None:
            return None
        h, w = frame.shape[:2]
        if w > width:
            frame = cv2.resize(frame, (width, int(h * width / w)), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        return buf.tobytes() if ok else None

    def snapshot_jpeg(self, max_width=1024):
        """Sharper still for "point to ask" (reading signs and labels)."""
        return self.jpeg(width=max_width, quality=85)

    def signature(self):
        """Tiny grayscale thumbnail, to notice when the scene changes (Live guide)."""
        frame = self._latest()
        if frame is None:
            return None
        small = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (32, 24), interpolation=cv2.INTER_AREA)
        return small.astype("float32")

    def status(self):
        return {"available": self.available, "index": self.index, "enabled": self.enabled,
                "installed": cv2 is not None, "error": None if self.available else self.error}


def difference(a, b):
    """Average pixel change (0-255) between two signatures."""
    if a is None or b is None or a.shape != b.shape:
        return 255.0
    return float(abs(a - b).mean())
