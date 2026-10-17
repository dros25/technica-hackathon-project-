cd.."""
hardware.py - laptop-side bridge to the Guardian Arduino.

Install:  pip install pyserial
Test:     python hardware.py          (prints events, lets you type commands)

Use from the Flask server:
    from hardware import Hardware
    hw = Hardware()                    # auto-finds the Arduino
    hw.get_events()  -> [{"type": "button"}, {"type": "fall"}, {"type": "dark"}, ...]
    hw.light         -> latest light reading (0-1023, low = dark) or None
    hw.set_lcd("Low vision", "Thanks for help")
    hw.alarm(True)
    hw.test_fall()

IMPORTANT: run Flask with use_reloader=False (debug reloader opens the port twice),
and close the Arduino IDE Serial Monitor - only one program can hold the port.
"""

import queue
import threading
import time

import serial
from serial.tools import list_ports

BAUD = 115200
DARK_LEVEL = 250         # match DARK_LEVEL in guardian.ino
DARK_ALERT_COOLDOWN_S = 30


class Hardware:
    def __init__(self, port=None, baud=BAUD):
        self.port = port or self._find_port()
        self.ser = serial.Serial(self.port, baud, timeout=1)
        time.sleep(2)  # Arduino resets when the port opens
        self.light = None
        self.connected = True
        self._events = queue.Queue()
        self._write_lock = threading.Lock()
        self._last_dark_alert = 0.0
        self._was_dark = False
        threading.Thread(target=self._read_loop, daemon=True).start()
        print(f"[hardware] connected on {self.port}")

    @staticmethod
    def _find_port():
        ports = list(list_ports.comports())
        hints = ("arduino", "ch340", "cp210", "usb serial", "wch", "seeed")
        for p in ports:
            text = f"{p.device} {p.description} {p.manufacturer or ''}".lower()
            if any(h in text for h in hints) or "usbmodem" in text \
                    or "ttyacm" in text or "ttyusb" in text:
                return p.device
        raise RuntimeError(
            "No Arduino found. Ports seen: "
            + (", ".join(p.device for p in ports) or "none")
            + ". Pass the port manually: Hardware('COM3') or Hardware('/dev/cu.usbmodem1101')"
        )

    # ---------- reading ----------
    def _read_loop(self):
        while True:
            try:
                raw = self.ser.readline()
            except serial.SerialException as e:
                print(f"[hardware] serial error: {e}")
                self.connected = False
                return
            if not raw:
                continue
            line = raw.decode(errors="ignore").strip()
            self._handle_line(line)

    def _handle_line(self, line):
        if line == "BTN":
            self._push({"type": "button"})
        elif line == "FALL":
            self._push({"type": "fall"})
        elif line == "CANCEL":
            self._push({"type": "cancel"})
        elif line.startswith("LIGHT:"):
            try:
                self.light = int(line[6:])
            except ValueError:
                return
            is_dark = self.light < DARK_LEVEL
            now = time.time()
            # alert only when it *becomes* dark, with a cooldown so it doesn't nag
            if is_dark and not self._was_dark and now - self._last_dark_alert > DARK_ALERT_COOLDOWN_S:
                self._last_dark_alert = now
                self._push({"type": "dark", "value": self.light})
            self._was_dark = is_dark
        else:
            print(f"[arduino] {line}")  # READY, ERR:..., I2C:... etc.

    def _push(self, event):
        event["time"] = time.time()
        self._events.put(event)

    def get_events(self):
        """Return and clear all pending events (one consumer only)."""
        out = []
        while True:
            try:
                out.append(self._events.get_nowait())
            except queue.Empty:
                return out

    # ---------- writing ----------
    def send(self, cmd):
        with self._write_lock:
            self.ser.write((cmd.strip() + "\n").encode())

    def set_lcd(self, line1, line2=""):
        clean = lambda s: s.replace("|", " ").replace("\n", " ")[:16]
        self.send(f"LCD:{clean(line1)}|{clean(line2)}")

    def alarm(self, on):
        self.send("ALARM:ON" if on else "ALARM:OFF")

    def test_fall(self):
        self.send("TESTFALL")


if __name__ == "__main__":
    hw = Hardware()

    def printer():
        while True:
            for e in hw.get_events():
                print("EVENT:", e)
            time.sleep(0.2)

    threading.Thread(target=printer, daemon=True).start()
    print("Type: lcd <line1>|<line2>, alarm on, alarm off, fall, light, quit")
    while True:
        cmd = input("> ").strip()
        if cmd == "quit":
            break
        elif cmd.startswith("lcd "):
            a, _, b = cmd[4:].partition("|")
            hw.set_lcd(a, b)
        elif cmd == "alarm on":
            hw.alarm(True)
        elif cmd == "alarm off":
            hw.alarm(False)
        elif cmd == "fall":
            hw.test_fall()
        elif cmd == "light":
            print("light:", hw.light)
        else:
            hw.send(cmd)
