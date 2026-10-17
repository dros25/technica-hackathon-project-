"""
wrist_camera.py - USB webcam worn on the wrist ("point to ask").

The user points their hand at something and presses the wearable button; the
backend describes what this camera sees and the chest phone speaks it.

A background thread keeps reading frames so a snapshot is always the *current*
view (webcams otherwise hand you a stale buffered frame). If the camera is
unplugged it keeps retrying, so it can be plugged in after the server starts.

Install:  pip install opencv-python-headless
.env:     WRIST_CAMERA=1     camera index (default 1; 0 is usually the laptop's own camera)
          WRIST_CAMERA=off   disable it (the button then describes from the chest camera)
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
except ImportError:  # server still runs; the button falls back to the chest camera
    cv2 = None

FRESH_S = 2.0  # a frame older than this means the camera has stopped


class WristCamera:
    def __init__(self):
        setting = os.getenv("WRIST_CAMERA", "1").strip().lower()
        self.enabled = cv2 is not None and setting.isdigit()
        self.index = int(setting) if setting.isdigit() else None
        self._cap = None
        self._frame = None
        self._frame_at = 0.0
        self._lock = threading.Lock()
        if cv2 is None:
            print("[wrist] OpenCV not installed (pip install opencv-python-headless) - wrist camera off")
        elif not self.enabled:
            print("[wrist] WRIST_CAMERA is off - the button describes from the chest camera")
        else:
            threading.Thread(target=self._loop, daemon=True).start()

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
                        print(f"[wrist] no camera at index {self.index} yet - plug it in, "
                              "or set WRIST_CAMERA to another number in .env")
                        said_missing = True
                    time.sleep(3)
                    continue
                print(f"[wrist] camera {self.index} ready")
                said_missing = False
            ok, frame = self._cap.read()
            if not ok:
                print("[wrist] camera stopped sending frames, reconnecting...")
                self._cap.release()
                self._cap = None
                time.sleep(1)
                continue
            with self._lock:
                self._frame = frame
                self._frame_at = time.time()

    @property
    def available(self):
        return self.enabled and self._frame is not None and time.time() - self._frame_at < FRESH_S

    def snapshot_jpeg(self, max_width=1024):
        """Current view as JPEG bytes, or None if the camera isn't delivering frames."""
        with self._lock:
            if self._frame is None or time.time() - self._frame_at > FRESH_S:
                return None
            frame = self._frame.copy()
        h, w = frame.shape[:2]
        if w > max_width:
            frame = cv2.resize(frame, (max_width, int(h * max_width / w)))
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        return buf.tobytes() if ok else None
