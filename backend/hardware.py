"""
hardware.py - laptop-side bridge to the SightSea Arduino.

Install:  pip install pyserial
Test:     python hardware.py          (prints events, lets you type commands)

Use from the Flask server:
    from hardware import Hardware
    hw = Hardware()                    # auto-finds the Arduino
    hw.get_events()  -> [{"type": "button"}, {"type": "fall_pending", "seconds": 30},
                         {"type": "fall"} (alarm), {"type": "cancel"}, {"type": "dark"}, ...]
    hw.set_fall_detection(True/False), hw.cancel_fall()
                        also "disconnected" / "reconnected" (auto-reconnects if unplugged)
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
DARK_LEVEL = 150         # match DARK_LEVEL in guardian.ino
DARK_ALERT_COOLDOWN_S = 30


class Hardware:
    def __init__(self, port=None, baud=BAUD):
        self._fixed_port = port      # if given, always use this port
        self.baud = baud
        self.port = port or self._find_port()
        self.ser = serial.Serial(self.port, baud, timeout=1)
        time.sleep(2)  # Arduino resets when the port opens
        self.light = None
        self.connected = True
        self._lcd_lines = None       # re-sent after a reconnect
        self.fall_detection = True   # Arduino default; re-sent after a reconnect
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
            except (serial.SerialException, OSError) as e:
                print(f"[hardware] lost connection: {e}")
                self._reconnect()
                continue
            if not raw:
                continue
            line = raw.decode(errors="ignore").strip()
            self._handle_line(line)

    def _reconnect(self):
        """Keep retrying until the Arduino is back (unplugged, reset, IDE grabbed the port...)."""
        self.connected = False
        self._push({"type": "disconnected"})
        try:
            self.ser.close()
        except Exception:
            pass
        while True:
            time.sleep(2)
            try:
                port = self._fixed_port or self._find_port()
                with self._write_lock:
                    self.ser = serial.Serial(port, self.baud, timeout=1)
                self.port = port
                time.sleep(2)  # board resets on open
                self.connected = True
                print(f"[hardware] reconnected on {port}")
                self._push({"type": "reconnected"})
                if self._lcd_lines:
                    self.set_lcd(*self._lcd_lines)  # restore the user's message
                if not self.fall_detection:
                    self.set_fall_detection(False)  # board resets to ON
                return
            except Exception as e:
                print(f"[hardware] waiting for Arduino... ({e})")

    def _handle_line(self, line):
        if line == "BTN":
            self._push({"type": "button"})
        elif line.startswith("FALL_PENDING"):
            try:
                seconds = int(line.split(":", 1)[1])
            except (IndexError, ValueError):
                seconds = 30
            self._push({"type": "fall_pending", "seconds": seconds})
        elif line == "FALL":  # countdown ran out: full alarm
            self._push({"type": "fall"})
        elif line in ("FALLDET:ON", "FALLDET:OFF"):
            self.fall_detection = line.endswith("ON")
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
        """Returns False instead of crashing if the Arduino is disconnected."""
        if not self.connected:
            return False
        try:
            with self._write_lock:
                self.ser.write((cmd.strip() + "\n").encode())
            return True
        except (serial.SerialException, OSError) as e:
            print(f"[hardware] write failed: {e}")
            return False

    def set_lcd(self, line1, line2=""):
        clean = lambda s: s.replace("|", " ").replace("\n", " ")[:16]
        self._lcd_lines = (clean(line1), clean(line2))
        return self.send(f"LCD:{clean(line1)}|{clean(line2)}")

    def alarm(self, on):
        self.send("ALARM:ON" if on else "ALARM:OFF")

    def test_fall(self):
        self.send("TESTFALL")

    def set_fall_detection(self, on):
        self.fall_detection = bool(on)
        return self.send("FALLDET:ON" if on else "FALLDET:OFF")

    def cancel_fall(self):
        """Phone's "I'm okay" - Arduino stops the alarm and replies CANCEL."""
        return self.send("CANCEL")


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
