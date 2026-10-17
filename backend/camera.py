"""
camera.py - the wearable's USB webcam, plugged into the laptop that runs the server.

A background thread keeps grabbing frames, so a button press gets the *current* view
instantly (no warm-up, no stale buffered frame).

    cam = Webcam()            # opens lazily on first use
    cam.jpeg(width=640)       # latest frame as JPEG bytes, or None
    cam.signature()           # tiny grayscale thumbnail, to notice when the scene changes
    cam.status()              # {"available": bool, "index": int, "error": str|None}

Which camera: CAMERA_INDEX in .env. Otherwise it prefers an external USB webcam
(index 1, 2) and falls back to the laptop's built-in one (index 0).
"""

import os
import threading
import time

try:
    import cv2
except ImportError:  # opencv not installed: phone camera still works
    cv2 = None


class Webcam:
    def __init__(self):
        self._lock = threading.Lock()
        self._cap = None
        self._frame = None
        self._frame_at = 0.0
        self.index = None
        self.error = None if cv2 else "opencv-python is not installed (pip install opencv-python)"
        self._opening = False

    # ---------- opening ----------
    def _candidates(self):
        if os.getenv("CAMERA_INDEX", "").strip():
            return [int(os.getenv("CAMERA_INDEX"))]
        return [1, 2, 0]  # external USB webcams usually come after the built-in camera

    def _try_open(self, idx):
        backend = cv2.CAP_DSHOW if os.name == "nt" else cv2.CAP_ANY  # DirectShow opens fast on Windows
        cap = cv2.VideoCapture(idx, backend)
        if not cap.isOpened():
            cap.release()
            return None
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        for _ in range(10):  # first frames can be black while exposure settles
            ok, frame = cap.read()
            if ok and frame is not None and frame.mean() > 2:
                return cap
            time.sleep(0.05)
        cap.release()
        return None

    def open(self):
        if cv2 is None or self._cap is not None or self._opening:
            return self._cap is not None
        self._opening = True
        try:
            for idx in self._candidates():
                cap = self._try_open(idx)
                if cap is not None:
                    self._cap, self.index, self.error = cap, idx, None
                    print(f"[camera] using camera {idx}")
                    threading.Thread(target=self._reader, daemon=True).start()
                    return True
            self.error = "No webcam found. Plug it in, close other apps using it, or set CAMERA_INDEX in .env."
            print(f"[camera] {self.error}")
            return False
        finally:
            self._opening = False

    def _reader(self):
        while self._cap is not None:
            ok, frame = self._cap.read()
            if not ok:
                print("[camera] lost the webcam, will reopen on next use")
                with self._lock:
                    self._cap.release()
                    self._cap, self._frame = None, None
                    self.error = "The webcam disconnected."
                return
            with self._lock:
                self._frame, self._frame_at = frame, time.time()

    # ---------- reading ----------
    def _latest(self):
        if self._cap is None and not self.open():
            return None
        deadline = time.time() + 2
        while time.time() < deadline:
            with self._lock:
                if self._frame is not None and time.time() - self._frame_at < 2:
                    return self._frame.copy()
            time.sleep(0.03)
        return None

    def jpeg(self, width=640, quality=80):
        frame = self._latest()
        if frame is None:
            return None
        h, w = frame.shape[:2]
        if w > width:
            frame = cv2.resize(frame, (width, int(h * width / w)), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        return buf.tobytes() if ok else None

    def signature(self):
        frame = self._latest()
        if frame is None:
            return None
        small = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (32, 24), interpolation=cv2.INTER_AREA)
        return small.astype("float32")

    def status(self):
        return {"available": self._cap is not None, "index": self.index, "error": self.error,
                "installed": cv2 is not None}


def difference(a, b):
    """Average pixel change (0-255) between two signatures."""
    if a is None or b is None or a.shape != b.shape:
        return 255.0
    return float(abs(a - b).mean())
