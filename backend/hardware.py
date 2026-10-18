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
                        also "disconnected" / "connected" with "link": "usb"|"wifi" (auto-reconnects)
    hw.light         -> latest light reading (0-1023, low = dark) or None
    hw.set_lcd("Low vision", "Thanks for help")
    hw.alarm(True)
    hw.test_fall()

Connection: USB if the Arduino is plugged in, otherwise WiFi. Over WiFi the Arduino joins
your phone hotspot (see firmware/guardian/arduino_secrets.h) and this finds it automatically;
the laptop must be on the same hotspot. Set ARDUINO_HOST=<ip shown on the LCD> to skip the search.

IMPORTANT: run Flask with use_reloader=False (debug reloader opens the port twice),
and close the Arduino IDE Serial Monitor - only one program can hold the USB port.
"""

import os
import queue
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import serial
from serial.tools import list_ports

BAUD = 115200
NET_PORT = 5005          # match NET_PORT in guardian.ino
DARK_LEVEL = 150         # match DARK_LEVEL in guardian.ino
DARK_ALERT_COOLDOWN_S = 30
SILENCE_S = 6            # the Arduino reports light every second; this long silent = lost


# ---------- links: the same text protocol over USB or WiFi ----------
class SerialLink:
    kind = "usb"

    def __init__(self, port, baud=BAUD):
        self.ser = serial.Serial(port, baud, timeout=1)
        self.name = port
        time.sleep(2)  # the Arduino resets when the port opens

    def readline(self):
        return self.ser.readline()  # b"" on timeout

    def write(self, data):
        self.ser.write(data)

    def close(self):
        try:
            self.ser.close()
        except Exception:
            pass


class NetLink:
    kind = "wifi"

    def __init__(self, sock, host):
        self.sock = sock
        self.sock.settimeout(1)
        self.name = f"WiFi {host}"
        self.buf = b""

    def readline(self):
        while b"\n" not in self.buf:
            try:
                chunk = self.sock.recv(512)
            except socket.timeout:
                return b""
            if not chunk:
                raise OSError("WiFi connection closed")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return line + b"\n"

    def write(self, data):
        self.sock.sendall(data)

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def _find_serial_port():
    ports = list(list_ports.comports())
    hints = ("arduino", "ch340", "cp210", "usb serial", "wch", "seeed")
    for p in ports:
        text = f"{p.device} {p.description} {p.manufacturer or ''}".lower()
        if any(h in text for h in hints) or "usbmodem" in text \
                or "ttyacm" in text or "ttyusb" in text:
            return p.device
    raise RuntimeError("no USB Arduino (ports seen: " + (", ".join(p.device for p in ports) or "none") + ")")


def _probe(host, timeout=0.6):
    """Connect to host:NET_PORT and check it's our Arduino (PING -> READY). Returns a socket or None."""
    try:
        sock = socket.create_connection((host, NET_PORT), timeout=timeout)
    except OSError:
        return None
    try:
        sock.settimeout(3)
        sock.sendall(b"PING\n")
        data, deadline = b"", time.time() + 3
        while time.time() < deadline:
            chunk = sock.recv(512)
            if not chunk:
                break
            data += chunk
            if b"READY" in data:
                return sock
    except OSError:
        pass
    sock.close()
    return None


def _local_subnets():
    """The laptop's networks, e.g. ['172.20.10'] on an iPhone hotspot."""
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # picks the main interface; sends nothing
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted({ip.rsplit(".", 1)[0] for ip in ips
                   if not ip.startswith(("127.", "169.254."))})


def _find_wifi_arduino():
    """Ask every address on the laptop's network(s) whether it's the SightSea Arduino (~2-3 s)."""
    hosts = [f"{net}.{i}" for net in _local_subnets() for i in range(1, 255)]
    found = None
    with ThreadPoolExecutor(max_workers=64) as ex:
        for host, sock in zip(hosts, ex.map(_probe, hosts)):
            if sock and found is None:
                found = (sock, host)
            elif sock:
                sock.close()
    if not found:
        raise RuntimeError("no WiFi Arduino on " + (", ".join(n + ".x" for n in _local_subnets()) or "any network"))
    return found


class Hardware:
    """Talks to the SightSea Arduino over USB if it's plugged in, otherwise over WiFi.

    port: force a USB port (e.g. "COM5").  host: force the Arduino's WiFi address.
    Both can also come from .env as ARDUINO_PORT / ARDUINO_HOST.
    """

    def __init__(self, port=None, host=None):
        self._fixed_port = port or os.getenv("ARDUINO_PORT") or None
        self._fixed_host = host or os.getenv("ARDUINO_HOST") or None
        self.light = None
        self._lcd_lines = None       # re-sent after a reconnect
        self.fall_detection = True   # Arduino default; re-sent after a reconnect
        self._events = queue.Queue()
        self._write_lock = threading.Lock()
        self._last_dark_alert = 0.0
        self._was_dark = False
        self._last_line = time.time()
        # Never fails: if the Arduino isn't there yet, keep looking (USB and Wi-Fi) in the background,
        # so the wearable can be switched on after the server starts.
        try:
            self._link = self._open_any()
            self.connected = True
            print(f"[hardware] connected over {self._link.kind.upper()} ({self._link.name})")
            self._push({"type": "connected", "link": self._link.kind})
        except Exception as e:
            self._link = None
            self.connected = False
            print(f"[hardware] wearable not found yet ({e}); will keep looking")
        threading.Thread(target=self._read_loop, daemon=True).start()

    @property
    def link(self):
        """'usb', 'wifi', or None while disconnected."""
        return self._link.kind if (self.connected and self._link) else None

    transport = link

    @property
    def port(self):
        return self._link.name if self._link else None

    @property
    def wifi_ip(self):
        return self._link.name.replace("WiFi ", "") if self.link == "wifi" else None

    def _open_any(self):
        errors = []
        if not self._fixed_host:                 # USB first: it's the fallback that always works
            try:
                return SerialLink(self._fixed_port or _find_serial_port())
            except Exception as e:
                errors.append(f"USB: {e}")
        if not self._fixed_port:
            try:
                if self._fixed_host:
                    sock = _probe(self._fixed_host, timeout=2)
                    if not sock:
                        raise RuntimeError(f"no answer from {self._fixed_host}:{NET_PORT}")
                    return NetLink(sock, self._fixed_host)
                sock, host = _find_wifi_arduino()
                return NetLink(sock, host)
            except Exception as e:
                errors.append(f"WiFi: {e}")
        raise RuntimeError("No Arduino found. " + "; ".join(errors))

    # ---------- reading ----------
    def _read_loop(self):
        if self._link is None:
            self._reconnect(announce=False)
        while True:
            try:
                raw = self._link.readline()
                if not raw:
                    # only WiFi needs a silence check: an unplugged USB cable raises an error by itself,
                    # and reopening USB restarts the Arduino (which then goes quiet while joining WiFi)
                    if self._link.kind == "wifi" and time.time() - self._last_line > SILENCE_S:
                        raise OSError(f"no data for {SILENCE_S} s")
                    continue
            except (serial.SerialException, OSError) as e:
                print(f"[hardware] lost connection ({self._link.name}): {e}")
                self._reconnect()
                continue
            self._last_line = time.time()
            line = raw.decode(errors="ignore").strip()
            if line:
                self._handle_line(line)

    def _reconnect(self, announce=True):
        """Keep retrying USB and WiFi until the Arduino is back."""
        self.connected = False
        if announce:
            self._push({"type": "disconnected"})
        if self._link:
            self._link.close()
        last_note = 0.0
        while True:
            time.sleep(2)
            try:
                link = self._open_any()
            except Exception as e:
                if time.time() - last_note > 15:
                    print(f"[hardware] waiting for Arduino... ({e})")
                    last_note = time.time()
                continue
            with self._write_lock:
                self._link = link
            self._last_line = time.time()
            self.connected = True
            print(f"[hardware] connected over {link.kind.upper()} ({link.name})")
            self._push({"type": "connected", "link": link.kind})
            if self._lcd_lines:
                self.set_lcd(*self._lcd_lines)  # restore the user's message
            if not self.fall_detection:
                self.set_fall_detection(False)  # board resets to ON
            return

    def _handle_line(self, line):
        if line == "BTN":
            self._push({"type": "button"})          # press: describe what's ahead
        elif line == "BTN2":
            self._push({"type": "button_double"})   # double press: switch Tap / Live guide
        elif line == "STOP":
            self._push({"type": "stop"})            # held 1-3 s: stop everything (silence)
        elif line == "BTNHOLD":
            self._push({"type": "button_hold"})     # held 3 s: repeat the last thing said
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
            if line == "WIFI:RETRY":
                print("[hardware] Arduino is trying to join WiFi again (not on WiFi yet)")
            elif line.startswith("WIFI:"):
                print(f"[hardware] Arduino is on WiFi at {line[5:]}")
            else:
                print(f"[arduino] {line}")  # READY, ERR:..., I2C:... etc.

    def _push(self, event):
        event["time"] = time.time()
        self._events.put(event)

    def inject(self, event_type, value=None):
        """Fake an event for testing the app (/test/<event>)."""
        ev = {"type": event_type}
        if value is not None:
            ev["value"] = value
        self._push(ev)

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
                self._link.write((cmd.strip() + "\n").encode())
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
