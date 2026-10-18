"""
hardware.py - laptop-side bridge to the Guardian Arduino, over USB and/or Wi-Fi.

The Arduino speaks the same one-line messages either way:
  USB:   serial at 115200 baud (as before)
  Wi-Fi: UDP on the phone's hotspot. The Arduino sends "G1|<id>|<line>" to port 5005 here
         (broadcast until it knows our address); we send commands back to it on port 5006.
USB wins when both are live, so nothing is handled twice.

Install:  pip install pyserial
Test:     python hardware.py          (prints events and which link is up, lets you type commands)

Use from the Flask server:
    from hardware import Hardware
    hw = Hardware()                    # never fails: waits for USB and listens for Wi-Fi
    hw.get_events()  -> [{"type": "button"}, {"type": "button_double"}, {"type": "stop"}, {"type": "button_hold"},
                         {"type": "fall_pending", "seconds": 30},
                         {"type": "fall"} (alarm), {"type": "cancel"}, {"type": "dark"},
                         {"type": "connected", "link": "wifi"}, {"type": "disconnected"}, ...]
    hw.connected, hw.link ("usb" / "wifi" / None), hw.light (0-1023, low = dark) or None
    hw.set_lcd("Low vision", "Thanks for help"), hw.alarm(True), hw.test_fall(),
    hw.set_fall_detection(True/False), hw.cancel_fall()

IMPORTANT: run Flask with use_reloader=False (debug reloader opens the port twice),
and close the Arduino IDE Serial Monitor - only one program can hold the USB port.
On Windows, allow Python through the firewall when asked (needed for Wi-Fi).
"""

import queue
import socket
import threading
import time

try:
    import serial
    from serial.tools import list_ports
except ImportError:  # Wi-Fi still works without pyserial
    serial = None
    list_ports = None

BAUD = 115200
DARK_LEVEL = 150             # match DARK_LEVEL in guardian.ino
DARK_ALERT_COOLDOWN_S = 30
UDP_LISTEN_PORT = 5005       # Arduino -> laptop
UDP_ARDUINO_PORT = 5006      # laptop -> Arduino
WIFI_TIMEOUT_S = 8           # no heartbeat for this long = Wi-Fi link down
DEDUPE_S = 5                 # Wi-Fi events are sent 3x; ignore repeats within this window


def local_ips():
    """This laptop's network addresses (for LAPTOP_IP in secrets.h if the hotspot blocks broadcasts)."""
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:  # the address used to reach the internet (usually the hotspot one)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def find_serial_port():
    if list_ports is None:
        return None
    hints = ("arduino", "ch340", "cp210", "usb serial", "wch", "seeed")
    for p in list_ports.comports():
        text = f"{p.device} {p.description} {p.manufacturer or ''}".lower()
        if any(h in text for h in hints) or "usbmodem" in text or "ttyacm" in text or "ttyusb" in text:
            return p.device
    return None


class Hardware:
    def __init__(self, port=None, baud=BAUD, wifi=True):
        self._fixed_port = port      # if given, always use this USB port
        self.baud = baud
        self.port = None
        self.ser = None
        self.serial_ok = False
        self.light = None
        self.fall_detection = True   # Arduino default; re-sent after a reconnect
        self._lcd_lines = None       # re-sent after a reconnect
        self._events = queue.Queue()
        self._write_lock = threading.Lock()
        self._last_dark_alert = 0.0
        self._was_dark = False

        self._udp = None
        self.wifi_addr = None        # (ip, port) of the Arduino on the hotspot
        self.wifi_ip = None
        self._wifi_seen = 0.0
        self._recent_ids = {}        # Wi-Fi message id -> time seen
        self._cmd_id = int(time.time()) % 100000
        self._was_connected = False
        self._last_ack = 0.0

        if serial is not None:
            threading.Thread(target=self._serial_loop, daemon=True).start()
        else:
            print("[hardware] pyserial not installed - USB off (pip install pyserial)")
        if wifi:
            self._start_udp()
        threading.Thread(target=self._watch_link, daemon=True).start()

    # ---------- link state ----------
    @property
    def wifi_ok(self):
        return self.wifi_addr is not None and time.time() - self._wifi_seen < WIFI_TIMEOUT_S

    @property
    def connected(self):
        return self.serial_ok or self.wifi_ok

    @property
    def link(self):
        return "usb" if self.serial_ok else "wifi" if self.wifi_ok else None

    def _watch_link(self):
        """Announce connect/disconnect, and restore settings the board forgets when it restarts."""
        started = time.time()
        hinted = False
        while True:
            if not hinted and not self.connected and time.time() - started > 30:
                hinted = True
                print("[hardware] no wearable yet. Wi-Fi checklist: laptop on the phone's hotspot; "
                      "hotspot 'Maximize Compatibility' on; Windows network set to Private (or Python "
                      "allowed on public networks); secrets.h name/password exact; else set LAPTOP_IP "
                      f"in secrets.h to one of: {', '.join(local_ips()) or 'unknown'}")
            now = self.connected
            if now and not self._was_connected:
                print(f"[hardware] wearable connected over {self.link.upper()}")
                self._push({"type": "connected", "link": self.link})
                self._restore_settings()
            elif not now and self._was_connected:
                print("[hardware] wearable disconnected")
                self._push({"type": "disconnected"})
            self._was_connected = now
            time.sleep(0.5)

    def _restore_settings(self):
        if self._lcd_lines:
            self.set_lcd(*self._lcd_lines)
        if not self.fall_detection:
            self.set_fall_detection(False)

    # ---------- USB ----------
    def _serial_loop(self):
        said_waiting = False
        while True:
            if not self.serial_ok:
                port = self._fixed_port or find_serial_port()
                if not port:
                    if not said_waiting:
                        print("[hardware] no USB Arduino yet - also listening on Wi-Fi")
                        said_waiting = True
                    time.sleep(3)
                    continue
                try:
                    ser = serial.Serial(port, self.baud, timeout=1)
                    time.sleep(2)  # Arduino resets when the port opens
                    with self._write_lock:
                        self.ser = ser
                    self.port = port
                    self.serial_ok = True
                    said_waiting = False
                    print(f"[hardware] USB connected on {port}")
                except Exception as e:
                    if not said_waiting:
                        print(f"[hardware] USB port {port} busy or unavailable ({e}) - retrying")
                        said_waiting = True
                    time.sleep(3)
                    continue
            try:
                raw = self.ser.readline()
            except Exception as e:
                print(f"[hardware] USB lost: {e}")
                self.serial_ok = False
                try:
                    self.ser.close()
                except Exception:
                    pass
                time.sleep(1)
                continue
            if raw:
                self._handle_line(raw.decode(errors="ignore").strip(), source="usb")

    # ---------- Wi-Fi ----------
    def _start_udp(self):
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.bind(("0.0.0.0", UDP_LISTEN_PORT))
            self._udp = sock
            threading.Thread(target=self._udp_loop, daemon=True).start()
            print(f"[hardware] listening for the wearable on Wi-Fi (UDP {UDP_LISTEN_PORT}); "
                  f"this laptop's addresses: {', '.join(local_ips()) or 'unknown'}")
        except OSError as e:
            print(f"[hardware] Wi-Fi listener unavailable ({e}) - USB only")

    def _udp_loop(self):
        while True:
            try:
                data, addr = self._udp.recvfrom(256)
            except OSError:
                time.sleep(0.5)
                continue
            msg = data.decode(errors="ignore").strip()
            if not msg.startswith("G1|"):
                continue
            parts = msg.split("|", 2)
            if len(parts) < 3:
                continue
            msg_id, line = parts[1], parts[2]
            first_contact = not self.wifi_ok
            self.wifi_addr = (addr[0], UDP_ARDUINO_PORT)
            self.wifi_ip = addr[0]
            self._wifi_seen = time.time()
            now = time.time()
            if first_contact or now - self._last_ack > 5:
                if first_contact:
                    print(f"[hardware] wearable found on Wi-Fi at {addr[0]}")
                self._last_ack = now
                self._send_udp("ACK", copies=1)  # tells the Arduino our address so it stops broadcasting
            if line == "HELLO":
                continue  # heartbeat
            self._recent_ids = {k: t for k, t in self._recent_ids.items() if now - t < DEDUPE_S}
            if msg_id in self._recent_ids:
                continue
            self._recent_ids[msg_id] = now
            self._handle_line(line, source="wifi")

    def _send_udp(self, cmd, copies=2):
        if not self._udp or not self.wifi_addr:
            return False
        self._cmd_id += 1
        payload = f"G1|{self._cmd_id}|{cmd}".encode()
        try:
            for _ in range(copies):  # UDP can drop packets; the Arduino ignores the repeat
                self._udp.sendto(payload, self.wifi_addr)
            return True
        except OSError as e:
            print(f"[hardware] Wi-Fi send failed: {e}")
            return False

    # ---------- messages from the Arduino ----------
    def _handle_line(self, line, source="usb"):
        if source == "wifi" and self.serial_ok:
            return  # USB is live and carries the same messages: don't handle twice
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
            print(f"[arduino/{source}] {line}")  # READY, WIFI:..., ERR:..., I2C:... etc.

    def _push(self, event):
        event["time"] = time.time()
        self._events.put(event)

    def inject(self, event_type, value=None):
        """Fake an event (testing without the wearable)."""
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

    # ---------- commands to the Arduino ----------
    def send(self, cmd):
        """USB if it's up, else Wi-Fi. Returns False instead of crashing if neither is."""
        cmd = cmd.strip()
        if self.serial_ok:
            try:
                with self._write_lock:
                    self.ser.write((cmd + "\n").encode())
                return True
            except Exception as e:
                print(f"[hardware] USB write failed: {e}")
        if self.wifi_ok:
            return self._send_udp(cmd)
        return False

    def set_lcd(self, line1, line2=""):
        clean = lambda s: s.replace("|", " ").replace("\n", " ")[:16]
        self._lcd_lines = (clean(line1), clean(line2))
        return self.send(f"LCD:{clean(line1)}|{clean(line2)}")

    def alarm(self, on):
        self.send("ALARM:ON" if on else "ALARM:OFF")

    def test_fall(self):
        if not self.send("TESTFALL"):
            print("[hardware] TESTFALL: wearable not connected")

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
    print("Type: lcd <line1>|<line2>, alarm on, alarm off, fall, light, link, quit")
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
        elif cmd == "link":
            print("link:", hw.link or "none", "| Wi-Fi IP:", hw.wifi_ip, "| USB port:", hw.port)
        else:
            hw.send(cmd)
