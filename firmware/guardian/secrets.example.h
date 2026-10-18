// Copy this file to secrets.h (same folder) and fill it in. secrets.h never goes to GitHub.
// With secrets.h present the wearable also talks over Wi-Fi; without it, USB only.

// iPhone hotspot name = the phone's name (Settings > General > About > Name).
// iPhones use a curly apostrophe ("Ian’s iPhone") that won't match one typed here, so
// RENAME the phone to something plain first, e.g. IanPhone, and use exactly that.
#define WIFI_SSID "IanPhone"
#define WIFI_PASS "hotspot password"       // Settings > Personal Hotspot > Wi-Fi Password

// Optional: only if the laptop never finds the wearable (some hotspots block broadcasts).
// Use the address the backend prints at startup ("this laptop's addresses: ..."), with commas:
// #define LAPTOP_IP 172,20,10,2
