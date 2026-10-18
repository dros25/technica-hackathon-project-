/*
  Guardian wearable - Arduino side (Technica 2026)
  Board: Arduino UNO R4 WiFi + Grove Base Shield (set shield switch to 5V)

  Wiring (Grove cables):
    Button            -> D2
    Buzzer            -> D3
    Light Sensor      -> A0
    3-Axis Accel      -> any I2C socket  (auto-detects ADXL345, LIS3DHTR, MMA7660)
    LCD RGB Backlight -> any I2C socket

  Library: "Grove - LCD RGB Backlight" (Arduino IDE > Library Manager)

  Wi-Fi (optional, no laptop cable needed): copy secrets.example.h to secrets.h in this folder,
  put in your phone hotspot's name and password, and upload. Power the board from the phone
  (iPhone 15+ USB-C) or any USB battery. On iPhone turn on Personal Hotspot > Maximize
  Compatibility (the board only uses 2.4 GHz). No secrets.h = USB only, exactly as before.
  Over Wi-Fi the same messages go by UDP: to the laptop on port 5005 as "G1|<id>|<message>",
  commands back on port 5006. With both USB and Wi-Fi up, the laptop uses USB and ignores the copies.

  Serial protocol (115200 baud, one message per line):
    Arduino -> laptop:  BTN (describe) | BTN2 (switch mode) | STOP (silence) | BTNHOLD (repeat) | FALL_PENDING:<sec> | FALL (alarm) | CANCEL | LIGHT:<0-1023> | FALLDET:ON/OFF | READY | ERR:<msg>
    Laptop -> Arduino:  LCD:<line1>|<line2>   ALARM:ON/OFF   TESTFALL   CANCEL   FALLDET:ON/OFF   PING
                        DIAG (accel status + I2C scan)   STREAM (toggle MAG:<g> output)
*/

#include <Wire.h>
#include "rgb_lcd.h"

#if __has_include("secrets.h")
  #include "secrets.h"
  #define USE_WIFI 1
  #include <WiFiS3.h>
#endif

// ---------- Pins ----------
const int BUTTON_PIN = 2;
const int BUZZER_PIN = 3;
const int LIGHT_PIN  = A0;

// ---------- Tunables (adjust after testing) ----------
const float IMPACT_G            = 2.5;   // spike that counts as a hit
const float IMPACT_G_MMA        = 1.8;   // same, for the low-range MMA7660
const float STILL_TOLERANCE_G   = 0.25;  // |mag - 1g| below this = "still"
const unsigned long STILL_MS    = 2000;  // must be still this long after impact
const unsigned long IMPACT_TIMEOUT_MS = 6000; // give up if no stillness by then
const int DARK_LEVEL = 150;  // below this = dark (check real readings and adjust)

const float FREEFALL_G          = 0.4;   // falling bodies read near 0g
const unsigned long FREEFALL_MS = 60;    // free-fall must last this long

// ---------- Accelerometer (auto-detects the common Grove versions) ----------
enum AccelType { ACC_NONE, ACC_ADXL345, ACC_LIS3DH, ACC_MMA7660 };
AccelType accelType = ACC_NONE;
uint8_t accelAddr = 0;
bool accelOk = false;
bool streamMag = false;
float lastMag = 0;
unsigned long freefallStart = 0;

rgb_lcd lcd;

// NORMAL -> IMPACT (hit/free-fall seen) -> PENDING (30 s countdown) -> FALLEN (full alarm)
enum Mode { NORMAL, IMPACT, PENDING, FALLEN };
const unsigned long COUNTDOWN_MS    = 30000;  // time to cancel before the alarm sounds
const unsigned long DOUBLE_CLICK_MS = 600;    // max gap between the two clicks of a cancel
bool fallDetection = true;                    // toggled from the phone (FALLDET:ON/OFF)
unsigned long pendingStart = 0;
long lastShownSec = -1;
unsigned long lastPressTime = 0;

// Button (one):  press = describe what's ahead
//                 double press = switch Tap mode / Live guide
//                 hold 1-3 s, then let go = stop everything (silence)
//                 hold 3 s = repeat the last thing said (fires at 3 s, while still held)
// During a fall countdown or alarm: double press cancels; single presses are ignored.
const unsigned long MULTI_CLICK_MS = 400;     // a second press within this = double press
const unsigned long STOP_HOLD_MS   = 1000;    // released after at least this long = stop
const unsigned long REPEAT_HOLD_MS = 3000;    // held this long = repeat
int lastButton = LOW;                         // Grove button reads HIGH when pressed
unsigned long lastButtonChange = 0;
unsigned long pressStart = 0;                 // when the current press began (0 = not pressed)
bool repeatSent = false;
int clickCount = 0;
unsigned long lastRelease = 0;
unsigned long chirpUntil = 0;
Mode mode = NORMAL;
unsigned long impactTime = 0;
unsigned long stillStart = 0;

bool laptopAlarm = false;

String line1 = "Low vision";
String line2 = "Thanks for help";


unsigned long lastAccelRead = 0;
unsigned long lastLightSend = 0;
unsigned long lastBeepToggle = 0;
bool beepOn = false;
int lightValue = 1023;

String serialBuf = "";

// ---------- Messages to the laptop: USB and (if set up) Wi-Fi ----------
#ifdef USE_WIFI
WiFiUDP udp;
const unsigned int LAPTOP_PORT = 5005;   // laptop listens here
const unsigned int LOCAL_PORT  = 5006;   // we listen here for commands
IPAddress laptopIp;
bool haveLaptop = false;                 // learned from the laptop's first reply
unsigned long lastLaptopMsg = 0;
bool udpStarted = false;
unsigned long lastWifiTry = 0;
unsigned long wifiRetryMs = 15000;       // grows while the hotspot is missing (connecting blocks)
unsigned long lastHeartbeat = 0;
unsigned long lastWifiRead = 0;
unsigned long msgId = 0;
long lastCmdId = -1;
void wifiSend(const String &line, bool important);
#endif

// The R4 WiFi can't tell whether a laptop is listening on USB, so send both ways;
// the laptop ignores the Wi-Fi copy while USB is connected.
void emit(const String &line, bool important) {
  Serial.println(line);
#ifdef USE_WIFI
  wifiSend(line, important);
#endif
}
void emit(const String &line) { emit(line, true); }

// ---------- Accelerometer ----------
bool present(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

void writeReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(accelAddr);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

int readReg(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  Wire.requestFrom(addr, (uint8_t)1);
  return Wire.available() ? Wire.read() : -1;
}

bool readBytes(uint8_t reg, uint8_t *buf, uint8_t n) {
  Wire.beginTransmission(accelAddr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  Wire.requestFrom(accelAddr, n);
  if (Wire.available() < n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

const char *accelName() {
  switch (accelType) {
    case ACC_ADXL345: return "ADXL345";
    case ACC_LIS3DH:  return "LIS3DH";
    case ACC_MMA7660: return "MMA7660";
    default:          return "none";
  }
}

bool initAccel() {
  // ADXL345 (0x53, or 0x1D) - device ID 0xE5
  uint8_t adxl[] = {0x53, 0x1D};
  for (uint8_t a : adxl) {
    if (present(a) && readReg(a, 0x00) == 0xE5) {
      accelType = ACC_ADXL345; accelAddr = a;
      writeReg(0x31, 0x0B);  // full res, +/-16g
      writeReg(0x2C, 0x0A);  // 100 Hz
      writeReg(0x2D, 0x08);  // measure
      return true;
    }
  }
  // LIS3DHTR (0x19, or 0x18) - WHO_AM_I 0x33
  uint8_t lis[] = {0x19, 0x18};
  for (uint8_t a : lis) {
    if (present(a) && readReg(a, 0x0F) == 0x33) {
      accelType = ACC_LIS3DH; accelAddr = a;
      writeReg(0x20, 0x57);  // 100 Hz, all axes on
      writeReg(0x23, 0x38);  // +/-16g, high resolution
      return true;
    }
  }
  // MMA7660FC (0x4C) - small +/-1.5g sensor
  if (present(0x4C)) {
    accelType = ACC_MMA7660; accelAddr = 0x4C;
    writeReg(0x07, 0x00);  // standby
    writeReg(0x08, 0x00);  // 120 samples/s
    writeReg(0x07, 0x01);  // active
    return true;
  }
  return false;
}

bool readAccelMag(float &mag) {
  float x, y, z;
  if (accelType == ACC_ADXL345) {
    uint8_t b[6];
    if (!readBytes(0x32, b, 6)) return false;
    x = (int16_t)((b[1] << 8) | b[0]) * 0.0039;
    y = (int16_t)((b[3] << 8) | b[2]) * 0.0039;
    z = (int16_t)((b[5] << 8) | b[4]) * 0.0039;
  } else if (accelType == ACC_LIS3DH) {
    uint8_t b[6];
    if (!readBytes(0x28 | 0x80, b, 6)) return false;  // 0x80 = auto-increment
    x = ((int16_t)((b[1] << 8) | b[0]) >> 4) * 0.012;
    y = ((int16_t)((b[3] << 8) | b[2]) >> 4) * 0.012;
    z = ((int16_t)((b[5] << 8) | b[4]) >> 4) * 0.012;
  } else if (accelType == ACC_MMA7660) {
    uint8_t b[3];
    if (!readBytes(0x00, b, 3)) return false;
    float v[3];
    for (int i = 0; i < 3; i++) {
      if (b[i] & 0x40) return false;          // mid-update, try next time
      int s = b[i] & 0x3F;
      if (s & 0x20) s -= 64;                  // 6-bit signed
      v[i] = s / 21.33;
    }
    x = v[0]; y = v[1]; z = v[2];
  } else {
    return false;
  }
  mag = sqrt(x * x + y * y + z * z);
  return true;
}

void scanI2C() {
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.print("I2C:0x");
      Serial.println(a, HEX);
    }
  }
}

// ---------- Display ----------
void showLines(const String &a, const String &b) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(a.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(b.substring(0, 16));
}

// Normal: calm green. Dark: full white so people nearby can still read the message.
void setNormalColor() {
  if (lightValue < DARK_LEVEL) lcd.setRGB(255, 255, 255);
  else                         lcd.setRGB(0, 200, 60);
}

void showNormal() {
  showLines(line1, line2);
  setNormalColor();
}

// ---------- Fall handling ----------
// Step 1: fall detected -> 30 s countdown the user can cancel with a double-click
void triggerFall() {
  mode = PENDING;
  pendingStart = millis();
  clickCount = 0;
  pressStart = 0;
  lastShownSec = -1;
  lastPressTime = 0;
  emit("FALL_PENDING:" + String(COUNTDOWN_MS / 1000));
  lcd.setRGB(255, 160, 0);  // amber while counting down
}

// Step 2: nobody cancelled -> full alarm
void triggerAlarm() {
  mode = FALLEN;
  emit("FALL");
  showLines("I've fallen!", "Please help me");
  lcd.setRGB(255, 0, 0);
}

void cancelFall() {
  mode = NORMAL;
  stillStart = 0;
  lastPressTime = 0;
  chirpUntil = 0;
  digitalWrite(BUZZER_PIN, LOW);
  beepOn = false;
  emit("CANCEL");
  showNormal();
}

void updatePending(unsigned long) {
  if (mode != PENDING) return;
  // Use a fresh millis(): pendingStart may have been set after this loop's `now` was taken,
  // and now - pendingStart would underflow and fire the alarm instantly.
  unsigned long now = millis();
  unsigned long elapsed = now - pendingStart;
  if (elapsed >= COUNTDOWN_MS) { triggerAlarm(); return; }
  long secLeft = (COUNTDOWN_MS - elapsed + 999) / 1000;
  if (secLeft != lastShownSec) {
    lastShownSec = secLeft;
    showLines("Fall! Alarm " + String(secLeft) + "s", "Double-click=OK");
    // soft chirp every 10 s, then every second for the last 5
    if (secLeft % 10 == 0 || secLeft <= 5) chirpUntil = now + 80;
  }
}

void updateFall(unsigned long now) {
  if (!fallDetection || !accelOk || now - lastAccelRead < 20) return;  // ~50 Hz
  lastAccelRead = now;

  float mag;
  if (!readAccelMag(mag)) return;
  lastMag = mag;
  if (streamMag) { Serial.print("MAG:"); Serial.println(mag, 2); }

  if (mode == NORMAL) {
    // A fall shows up as free-fall (near 0g) and/or a hard impact spike.
    // The free-fall check matters for the small +/-1.5g MMA7660, which can't see big spikes.
    bool freefall = false;
    if (mag < FREEFALL_G) {
      if (freefallStart == 0) freefallStart = now;
      else if (now - freefallStart >= FREEFALL_MS) freefall = true;
    } else {
      freefallStart = 0;
    }
    // MMA7660 saturates at +/-1.5g per axis, so it needs a lower impact threshold
    float impactG = (accelType == ACC_MMA7660) ? IMPACT_G_MMA : IMPACT_G;
    if (mag > impactG || freefall) {
      mode = IMPACT;
      impactTime = now;
      stillStart = 0;
      freefallStart = 0;
    }
  } else if (mode == IMPACT) {
    if (fabs(mag - 1.0) < STILL_TOLERANCE_G) {
      if (stillStart == 0) stillStart = now;
      else if (now - stillStart >= STILL_MS) triggerFall();
    } else {
      stillStart = 0;  // still moving: probably got back up
    }
    if (mode == IMPACT && now - impactTime > IMPACT_TIMEOUT_MS) {
      mode = NORMAL;
    }
  }
}

// ---------- Buzzer ----------
void updateBuzzer(unsigned long now) {
  bool shouldBeep = (mode == FALLEN) || laptopAlarm;
  if (!shouldBeep) {
    bool chirp = now < chirpUntil;  // short countdown chirps
    if (chirp != beepOn) { digitalWrite(BUZZER_PIN, chirp ? HIGH : LOW); beepOn = chirp; }
    return;
  }
  unsigned long interval = beepOn ? 200 : 300;
  if (now - lastBeepToggle >= interval) {
    beepOn = !beepOn;
    digitalWrite(BUZZER_PIN, beepOn ? HIGH : LOW);
    lastBeepToggle = now;
  }
}

// ---------- Button ----------
void updateButton(unsigned long now) {
  int reading = digitalRead(BUTTON_PIN);
  bool falling = (mode == PENDING || mode == FALLEN);
  if (reading != lastButton && now - lastButtonChange > 50) {   // debounced change
    lastButtonChange = now;
    lastButton = reading;
    if (reading == HIGH) {  // pressed
      if (falling) {
        // During a fall only a double-click cancels, so a stray press can't
        if (lastPressTime != 0 && now - lastPressTime <= DOUBLE_CLICK_MS) cancelFall();
        else lastPressTime = now;
        return;
      }
      if (mode == IMPACT) { mode = NORMAL; stillStart = 0; }  // they're moving the button: fine
      pressStart = now;
      repeatSent = false;
    } else {                // released
      if (!falling && pressStart != 0 && !repeatSent) {
        unsigned long held = now - pressStart;
        if (held >= STOP_HOLD_MS) {
          clickCount = 0;
          emit("STOP");                               // held 1-3 s: stop everything
        } else {
          clickCount++;
          lastRelease = now;
          if (clickCount >= 2) { emit("BTN2"); clickCount = 0; }  // double press: right away
        }
      }
      pressStart = 0;
    }
  }
  // Held 3 s: repeat (fires while still held)
  if (pressStart != 0 && !repeatSent && lastButton == HIGH && !falling && now - pressStart >= REPEAT_HOLD_MS) {
    repeatSent = true;
    clickCount = 0;
    emit("BTNHOLD");
  }
  // One press and no second one in time: describe
  if (clickCount == 1 && pressStart == 0 && now - lastRelease > MULTI_CLICK_MS) {
    clickCount = 0;
    emit("BTN");
  }
}

// ---------- Light ----------
void updateLight(unsigned long now) {
  if (now - lastLightSend < 1000) return;
  lastLightSend = now;
  lightValue = analogRead(LIGHT_PIN);
  emit("LIGHT:" + String(lightValue), false);  // sent every second; a lost one doesn't matter
  if (mode == NORMAL) setNormalColor();
}

// ---------- Commands from laptop ----------
void handleCommand(String cmd) {
  cmd.trim();
  if (cmd.startsWith("LCD:")) {
    String body = cmd.substring(4);
    int bar = body.indexOf('|');
    line1 = (bar >= 0) ? body.substring(0, bar) : body;
    line2 = (bar >= 0) ? body.substring(bar + 1) : "";
    if (mode == NORMAL) showNormal();
  } else if (cmd == "ALARM:ON") {
    laptopAlarm = true;
  } else if (cmd == "ALARM:OFF") {
    laptopAlarm = false;
  } else if (cmd == "TESTFALL") {
    triggerFall();
  } else if (cmd == "CANCEL") {          // "I'm okay" from the phone
    if (mode == PENDING || mode == FALLEN) cancelFall();
    else if (mode == IMPACT) { mode = NORMAL; stillStart = 0; }
  } else if (cmd == "FALLDET:ON") {
    fallDetection = true;
    emit("FALLDET:ON");
  } else if (cmd == "FALLDET:OFF") {
    fallDetection = false;
    if (mode == PENDING || mode == FALLEN) cancelFall();
    else if (mode == IMPACT) { mode = NORMAL; stillStart = 0; }
    emit("FALLDET:OFF");
  } else if (cmd == "PING") {
    emit("READY");
  } else if (cmd == "DIAG") {
    Serial.print("ACCEL:");
    Serial.print(accelName());
    if (accelOk) { Serial.print(" @0x"); Serial.print(accelAddr, HEX); }
    Serial.print(" mag=");
    Serial.println(lastMag, 2);
    scanI2C();
  } else if (cmd == "STREAM") {
    streamMag = !streamMag;
  }
}

void readSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      handleCommand(serialBuf);
      serialBuf = "";
    } else if (c != '\r' && serialBuf.length() < 64) {
      serialBuf += c;
    }
  }
}

// ---------- Wi-Fi ----------
#ifdef USE_WIFI
IPAddress broadcastAddress() {
  IPAddress ip = WiFi.localIP(), mask = WiFi.subnetMask(), b;
  for (int i = 0; i < 4; i++) b[i] = ip[i] | (~mask[i] & 0xFF);
  return b;
}

// Connecting blocks for a few seconds, so only retry now and then (and less often if it keeps failing)
void wifiConnect(bool force) {
  if (WiFi.status() == WL_CONNECTED) return;
  if (!force && millis() - lastWifiTry < wifiRetryMs) return;
  lastWifiTry = millis();
  udpStarted = false;
  haveLaptop = false;
  Serial.print("WIFI:connecting to ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  if (WiFi.status() == WL_CONNECTED) {
    unsigned long t = millis();
    while (WiFi.localIP() == IPAddress(0, 0, 0, 0) && millis() - t < 4000) delay(100);
    udp.begin(LOCAL_PORT);
    udpStarted = true;
    wifiRetryMs = 15000;
    Serial.print("WIFI:connected, IP ");
    Serial.println(WiFi.localIP());
  } else {
    wifiRetryMs = min(wifiRetryMs * 2, 60000UL);
    Serial.println("WIFI:not found (hotspot on? Maximize Compatibility on?) - will retry");
  }
}

void wifiSendRaw(const String &payload) {
  if (!udpStarted || WiFi.status() != WL_CONNECTED) return;
#ifdef LAPTOP_IP
  if (!haveLaptop) { laptopIp = IPAddress(LAPTOP_IP); haveLaptop = true; }
  bool known = true;                    // fixed address from secrets.h: never broadcast
#else
  bool known = haveLaptop && millis() - lastLaptopMsg < 15000;
#endif
  udp.beginPacket(known ? laptopIp : broadcastAddress(), LAPTOP_PORT);
  udp.print(payload);
  udp.endPacket();
}

// Important messages go 3 times (UDP can drop packets); the laptop ignores repeats by id
void wifiSend(const String &line, bool important) {
  String payload = "G1|" + String(++msgId) + "|" + line;
  for (int i = 0; i < (important ? 3 : 1); i++) wifiSendRaw(payload);
}

void readWifi() {
  if (!udpStarted) return;
  int size = udp.parsePacket();
  while (size > 0) {
    char buf[96];
    int n = udp.read(buf, sizeof(buf) - 1);
    buf[n > 0 ? n : 0] = 0;
    String msg(buf);
    if (msg.startsWith("G1|")) {
      int bar = msg.indexOf('|', 3);
      if (bar > 0) {
        long id = msg.substring(3, bar).toInt();
        laptopIp = udp.remoteIP();
        haveLaptop = true;
        lastLaptopMsg = millis();
        if (id != lastCmdId) {          // the laptop sends each command twice
          lastCmdId = id;
          handleCommand(msg.substring(bar + 1));
        }
      }
    }
    size = udp.parsePacket();
  }
}

void updateWifi(unsigned long now) {
  wifiConnect(false);
  if (now - lastHeartbeat >= 2000) {    // "I'm here" so the laptop knows the link is up
    lastHeartbeat = now;
    wifiSend("HELLO", false);
  }
  if (now - lastWifiRead >= 50) {       // each check talks to the Wi-Fi chip: not every loop
    lastWifiRead = now;
    readWifi();
  }
}
#endif

// ---------- Main ----------
void setup() {
  Serial.begin(115200);
  unsigned long waitStart = millis();
  while (!Serial && millis() - waitStart < 3000) {}  // R4: catch startup messages
  pinMode(BUTTON_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  Wire.begin();

  lcd.begin(16, 2);
  showLines("Guardian", "Starting...");
  lcd.setRGB(0, 80, 255);

  accelOk = initAccel();
  if (accelOk) {
    Serial.print("ACCEL:");
    Serial.println(accelName());
  } else {
    Serial.println("ERR:no accelerometer found, I2C devices:");
    scanI2C();
  }

#ifdef USE_WIFI
  showLines("Guardian", "Wi-Fi...");
  wifiConnect(true);
#endif

  delay(1000);
  showNormal();
  emit("READY");
}

void loop() {
  unsigned long now = millis();
  readSerial();
  updateButton(now);
  updateFall(now);
  updateLight(now);
  updatePending(now);
  updateBuzzer(now);
#ifdef USE_WIFI
  updateWifi(now);
#endif
}
