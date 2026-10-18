// Copy this file to secrets.h (same folder) and fill it in. secrets.h never goes to GitHub.
// With secrets.h present the wearable also talks over Wi-Fi; without it, USB only.

#define WIFI_SSID "Your iPhone's name"     // Settings > General > About > Name (= hotspot name)
#define WIFI_PASS "hotspot password"       // Settings > Personal Hotspot > Wi-Fi Password

// Optional: only if the laptop never finds the wearable (some hotspots block broadcasts).
// Use the address the backend prints at startup ("this laptop's addresses: ..."), with commas:
// #define LAPTOP_IP 172,20,10,2
