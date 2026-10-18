/*
  SightSea wearable - Arduino side (Technica 2026)
  Board: Arduino UNO R4 WiFi + Grove Base Shield (set shield switch to 5V)

  Wiring (Grove cables):
    Button            -> D2
    Buzzer            -> D3
    Light Sensor      -> A0
    3-Axis Accel      -> any I2C socket  (auto-detects ADXL345, LIS3DHTR, MMA7660)
    LCD RGB Backlight -> any I2C socket

  Library: "Grove - LCD RGB Backlight" (Arduino IDE > Library Manager)

  Serial protocol (115200 baud, one message per line):
    Arduino -> laptop:  BTN | FALL_PENDING:<sec> | FALL (alarm) | CANCEL | LIGHT:<0-1023> | FALLDET:ON/OFF | READY | ERR:<msg>
    (Same protocol over USB serial and over WiFi TCP port 5005.)  WIFI:<ip> is sent once on connect.
    Laptop -> Arduino:  LCD:<line1>|<line2>   ALARM:ON/OFF   TESTFALL   CANCEL   FALLDET:ON/OFF   PING
                        DIAG (accel status + I2C scan)   STREAM (toggle MAG:<g> output)
*/

#include <Wire.h>
#include "rgb_lcd.h"

// ---------- WiFi (optional) ----------
// Put your hotspot name/password in arduino_secrets.h (next to this file, NOT in git):
//   #define WIFI_SSID "MyPhone"
//   #define WIFI_PASS "password123"
// Without that file the sketch still works over USB only.
#if __has_include("arduino_secrets.h")
  #include "arduino_secrets.h"
  #include <WiFiS3.h>
  #define USE_WIFI 1
#else
  #define USE_WIFI 0
#endif

#if USE_WIFI
const uint16_t NET_PORT = 5005;   // the laptop connects here
WiFiServer netServer(NET_PORT);
WiFiClient netClient;
#endif

// Everything the Arduino reports goes to USB serial AND (if connected) the WiFi client.
// Lines are buffered so WiFi sends one packet per message, not one per character.
class Link : public Print {
 public:
  size_t write(uint8_t c) override {
    Serial.write(c);
#if USE_WIFI
    if (c == '\n') {
      line += '\n';
      if (netClient && netClient.connected()) netClient.print(line);
      line = "";
    } else if (c != '\r' && line.length() < 120) {
      line += (char)c;
    }
#endif
    return 1;
  }
 private:
  String line;
};
Link out;

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
unsigned long chirpUntil = 0;
Mode mode = NORMAL;
unsigned long impactTime = 0;
unsigned long stillStart = 0;

bool laptopAlarm = false;

String line1 = "Low vision";
String line2 = "Thanks for help";

int lastButton = LOW;              // Grove button reads HIGH when pressed
unsigned long lastButtonChange = 0;

unsigned long lastAccelRead = 0;
unsigned long lastLightSend = 0;
unsigned long lastBeepToggle = 0;
bool beepOn = false;
int lightValue = 1023;

String serialBuf = "";

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
      out.print("I2C:0x");
      out.println(a, HEX);
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
  lastShownSec = -1;
  lastPressTime = 0;
  out.print("FALL_PENDING:");
  out.println(COUNTDOWN_MS / 1000);
  lcd.setRGB(255, 160, 0);  // amber while counting down
}

// Step 2: nobody cancelled -> full alarm
void triggerAlarm() {
  mode = FALLEN;
  out.println("FALL");
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
  out.println("CANCEL");
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
  if (streamMag) { out.print("MAG:"); out.println(mag, 2); }

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
  if (reading != lastButton && now - lastButtonChange > 50) {
    lastButtonChange = now;
    lastButton = reading;
    if (reading == HIGH) {  // pressed
      if (mode == PENDING || mode == FALLEN) {
        // During a fall only a double-click cancels, so a stray press can't
        if (lastPressTime != 0 && now - lastPressTime <= DOUBLE_CLICK_MS) cancelFall();
        else lastPressTime = now;
      } else {
        if (mode == IMPACT) { mode = NORMAL; stillStart = 0; }  // they're moving the button: fine
        out.println("BTN");
      }
    }
  }
}

// ---------- Light ----------
void updateLight(unsigned long now) {
  if (now - lastLightSend < 1000) return;
  lastLightSend = now;
  lightValue = analogRead(LIGHT_PIN);
  out.print("LIGHT:");
  out.println(lightValue);
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
    out.println("FALLDET:ON");
  } else if (cmd == "FALLDET:OFF") {
    fallDetection = false;
    if (mode == PENDING || mode == FALLEN) cancelFall();
    else if (mode == IMPACT) { mode = NORMAL; stillStart = 0; }
    out.println("FALLDET:OFF");
  } else if (cmd == "PING") {
    out.println("READY");
  } else if (cmd == "DIAG") {
    out.print("ACCEL:");
    out.print(accelName());
    if (accelOk) { out.print(" @0x"); out.print(accelAddr, HEX); }
    out.print(" mag=");
    out.println(lastMag, 2);
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

// ---------- WiFi link ----------
#if USE_WIFI
String netBuf = "";
unsigned long lastWifiTry = 0;
unsigned long lastNetPoll = 0;

String wifiProblem = "";  // why the last join failed, for the LCD
void diagnoseWifi();

bool wifiConnect() {
  lastWifiTry = millis();
  if (WiFi.status() == WL_NO_MODULE) { wifiProblem = "No WiFi chip"; return false; }
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long t = millis();
  // give it up to 10 s to join and get an address from the hotspot
  while ((WiFi.status() != WL_CONNECTED || WiFi.localIP() == IPAddress(0, 0, 0, 0)) && millis() - t < 10000) delay(200);
  if (WiFi.status() != WL_CONNECTED) {
    diagnoseWifi();
    return false;
  }
  wifiProblem = "";
  netServer.begin();
  out.print("WIFI:");
  out.println(WiFi.localIP());
  return true;
}

// Join failed: is the hotspot visible at all? (not visible = name wrong or 5 GHz only;
// visible = probably the password)
void diagnoseWifi() {
  out.print("ERR:WiFi join failed, status ");
  out.println(WiFi.status());
  int n = WiFi.scanNetworks();
  bool seen = false;
  out.print("ERR:networks I can see: ");
  for (int i = 0; i < n; i++) {
    if (i) out.print(", ");
    out.print(WiFi.SSID(i));
    if (strcmp(WiFi.SSID(i), WIFI_SSID) == 0) seen = true;
  }
  out.println(n <= 0 ? "(none)" : "");
  if (seen) {
    wifiProblem = "Check password";
    out.println("ERR:your hotspot is visible, so the password is probably wrong");
  } else {
    wifiProblem = "Hotspot not seen";
    out.println("ERR:your hotspot is not visible: check the exact name, and turn on Maximize Compatibility (2.4 GHz)");
  }
}

void updateNet(unsigned long now) {
  if (now - lastNetPoll < 20) return;  // each WiFi call talks to the radio chip; don't spam it
  lastNetPoll = now;
  if (WiFi.status() != WL_CONNECTED) {
    // retry in the background, but never in the middle of a fall countdown or alarm
    if (mode == NORMAL && now - lastWifiTry > 60000) {
      out.println("WIFI:RETRY");  // joining blocks a few seconds; say so first
      wifiConnect();
    }
    return;
  }
  WiFiClient c = netServer.available();
  if (c) netClient = c;  // the laptop (re)connected
  while (netClient && netClient.available()) {
    char ch = netClient.read();
    if (ch == '\n') {
      handleCommand(netBuf);
      netBuf = "";
    } else if (ch != '\r' && netBuf.length() < 64) {
      netBuf += ch;
    }
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
  showLines("SightSea", "Starting...");
  lcd.setRGB(0, 80, 255);

  accelOk = initAccel();
  if (accelOk) {
    out.print("ACCEL:");
    out.println(accelName());
  } else {
    out.println("ERR:no accelerometer found, I2C devices:");
    scanI2C();
  }

#if USE_WIFI
  showLines("Joining WiFi", WIFI_SSID);
  if (wifiConnect()) {
    IPAddress ip = WiFi.localIP();
    showLines("WiFi connected", String(ip[0]) + "." + ip[1] + "." + ip[2] + "." + ip[3]);
    delay(2500);  // time to read the address
  } else {
    showLines("WiFi failed", wifiProblem);
    delay(4000);  // time to read why
  }
#else
  delay(1000);
#endif
  showNormal();
  out.println("READY");
}

void loop() {
  unsigned long now = millis();
  readSerial();
#if USE_WIFI
  updateNet(now);
#endif
  updateButton(now);
  updateFall(now);
  updateLight(now);
  updatePending(now);
  updateBuzzer(now);
}
