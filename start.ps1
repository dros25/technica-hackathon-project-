# SightSea one-click start (Windows)
#
# Double-click start.bat (or run: powershell -ExecutionPolicy Bypass -File start.ps1)
#   - checks Node.js, Python and ngrok, and installs any that are missing (winget)
#   - asks once for your ngrok token and Gemini key if they aren't set up
#   - installs packages, builds the app, starts the backend and the public https link
#
# Options:
#   -SkipInstall   skip pip/npm installs (faster restarts)
#   -SkipBuild     reuse the last app build
#   -Domain x.ngrok-free.app   use your free static ngrok domain (or put NGROK_DOMAIN=... in backend\.env)

param(
    [switch]$SkipInstall,
    [switch]$SkipBuild,
    [string]$Domain = ""
)

$ErrorActionPreference = "Continue"  # native tools write to stderr; failures are checked by exit code
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"
$EnvFile = Join-Path $Backend ".env"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "`n[X] $msg" -ForegroundColor Red; exit 1 }

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

function Has($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Ensure-Tool($cmd, $wingetId, $label) {
    if (Has $cmd) { Ok "$label found"; return }
    if (-not (Has "winget")) { Fail "$label is missing and winget isn't available. Install $label manually, then run this again." }
    Warn "$label not found - installing it now (this can take a minute)..."
    winget install --id $wingetId -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
    Refresh-Path
    if (-not (Has $cmd)) { Fail "$label was installed but isn't on PATH yet. Close this window and double-click start.bat again." }
    Ok "$label installed"
}

function Get-EnvValue($name) {
    if (-not (Test-Path $EnvFile)) { return "" }
    foreach ($line in Get-Content $EnvFile) {
        if ($line -match "^\s*$name\s*=\s*(.+?)\s*$") { return $Matches[1].Trim('"', "'") }
    }
    return ""
}

function Add-EnvValue($name, $value) {
    $raw = ""
    if (Test-Path $EnvFile) { $raw = [IO.File]::ReadAllText($EnvFile) }
    if ($raw.Length -gt 0 -and -not $raw.EndsWith("`n")) { Add-Content -Path $EnvFile -Value "" }
    Add-Content -Path $EnvFile -Value "$name=$value"
}

# ---------- 1. Tools ----------
Step "Checking tools"
Ensure-Tool "node" "OpenJS.NodeJS.LTS" "Node.js"
# Prefer the "py" launcher: "python" is sometimes a Microsoft Store placeholder
if (Has "py") { $Py = "py" } elseif (Has "python") { $Py = "python" } else {
    Ensure-Tool "python" "Python.Python.3.12" "Python"
    $Py = "python"
}
# The Microsoft Store "python" stub opens the Store instead of running Python
$pyCheck = & $Py --version 2>&1
if ($LASTEXITCODE -ne 0 -or "$pyCheck" -notmatch "Python 3") {
    Warn "The 'python' command isn't a real Python install - installing Python 3.12..."
    winget install --id Python.Python.3.12 -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
    Refresh-Path
    if (Has "py") { $Py = "py" } else { $Py = "python" }
}
Ok "Python: $(& $Py --version 2>&1)"
Ensure-Tool "ngrok" "ngrok.ngrok" "ngrok"

# ---------- 2. Keys and settings ----------
Step "Checking keys"
if (-not (Test-Path $EnvFile)) { New-Item -ItemType File -Path $EnvFile | Out-Null }

if (-not (Get-EnvValue "GEMINI_API_KEY") -and (Get-EnvValue "MOCK_VISION") -ne "1") {
    Warn "No GEMINI_API_KEY in backend\.env (needed for 'Tap to describe')."
    $key = Read-Host "    Paste your Gemini API key (or press Enter to use fake test descriptions)"
    if ($key) { Add-EnvValue "GEMINI_API_KEY" $key.Trim(); Ok "Saved to backend\.env (never committed to GitHub)" }
    else { Add-EnvValue "MOCK_VISION" "1"; Warn "Using fake descriptions (MOCK_VISION=1). Add a key to backend\.env later." }
} else { Ok "backend\.env is set up" }

$ngrokConfigs = @(
    (Join-Path $env:LOCALAPPDATA "ngrok\ngrok.yml"),
    (Join-Path $env:USERPROFILE "AppData\Local\ngrok\ngrok.yml"),
    (Join-Path $env:USERPROFILE ".config\ngrok\ngrok.yml"),
    (Join-Path $env:USERPROFILE ".ngrok2\ngrok.yml")
)
$hasToken = $false
foreach ($cfg in $ngrokConfigs) {
    if ((Test-Path $cfg) -and (Select-String -Path $cfg -Pattern "authtoken" -Quiet)) { $hasToken = $true }
}
if (-not $hasToken) {
    Warn "ngrok needs a free account token (one time only)."
    Write-Host "    1. Sign up / log in at https://dashboard.ngrok.com"
    Write-Host "    2. Copy your token from https://dashboard.ngrok.com/get-started/your-authtoken"
    $token = Read-Host "    Paste your ngrok token"
    if (-not $token) { Fail "ngrok can't start without a token." }
    ngrok config add-authtoken $token.Trim() | Out-Host
    Ok "ngrok token saved"
} else { Ok "ngrok token found" }

if (-not $Domain) { $Domain = Get-EnvValue "NGROK_DOMAIN" }

# ---------- 3. Packages ----------
if (-not $SkipInstall) {
    Step "Installing backend packages"
    & $Py -m pip install --disable-pip-version-check -q -r (Join-Path $Backend "requirements.txt")
    if ($LASTEXITCODE -ne 0) { Fail "pip install failed (see the messages above)." }
    Ok "Backend packages ready"

    Step "Installing app packages"
    Push-Location $Frontend
    npm.cmd install --no-audit --no-fund
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Fail "npm install failed (see the messages above)." }
    Ok "App packages ready"
}

# ---------- 4. Build ----------
$BuildDir = Join-Path $Frontend "build"
if (-not $SkipBuild -or -not (Test-Path $BuildDir)) {
    Step "Building the app"
    Push-Location $Frontend
    npm.cmd run build
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Fail "The app build failed (see the messages above)." }
    Ok "Build ready"
}

# ---------- 5. Wearable Wi-Fi: Windows must not block its messages ----------
Step "Checking the network for the wearable (Wi-Fi)"
$publicNets = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq "Public" }
foreach ($net in $publicNets) {
    try {
        Set-NetConnectionProfile -InterfaceIndex $net.InterfaceIndex -NetworkCategory Private -ErrorAction Stop
        Ok "Set '$($net.Name)' to a Private network so the wearable can reach this laptop"
    } catch {
        Warn "'$($net.Name)' is a Public network: Windows may block the wearable's Wi-Fi messages."
        Warn "Fix: Settings > Network & internet > Wi-Fi > $($net.Name) > Network profile type: Private"
    }
}
$rule = netsh advfirewall firewall show rule name="SightSea wearable" 2>$null
if ($LASTEXITCODE -ne 0) {
    netsh advfirewall firewall add rule name="SightSea wearable" dir=in action=allow protocol=UDP localport=5005 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok "Firewall rule added for the wearable (UDP 5005)" }
    else {
        Warn "Couldn't add a firewall rule (needs admin). Only matters for the Wi-Fi wearable. If it never connects,"
        Warn "run PowerShell as administrator once and paste:"
        Write-Host '    netsh advfirewall firewall add rule name="SightSea wearable" dir=in action=allow protocol=UDP localport=5005'
    }
} else { Ok "Firewall rule for the wearable is in place" }
if (-not $publicNets) { Ok "Network type is fine" }

# ---------- 6. Free port 5000 / stop old copies ----------
Step "Starting SightSea"
$old = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue
if ($old) {
    Warn "Something is already using port 5000 - stopping it so the new backend can start."
    $old | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
}
Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Backend in its own window so you can watch its log (close that window to stop it)
Start-Process -FilePath $Py -ArgumentList "Main.py" -WorkingDirectory $Backend
$up = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try { Invoke-RestMethod "http://localhost:5000/health" -TimeoutSec 2 | Out-Null; $up = $true; break } catch {}
}
if (-not $up) { Fail "The backend didn't start. Check its window for the error." }
Ok "Backend running on http://localhost:5000"

# ---------- 7. Public link ----------
$ngrokArgs = @("http", "5000")
if ($Domain) { $ngrokArgs += "--url=$Domain" }
Start-Process -FilePath "ngrok" -ArgumentList $ngrokArgs
$public = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $t = Invoke-RestMethod "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 2
        $public = ($t.tunnels | Where-Object { $_.public_url -like "https*" } | Select-Object -First 1).public_url
        if ($public) { break }
    } catch {}
}
if (-not $public) { Fail "ngrok didn't give a link. Check the ngrok window for the error." }

try { Set-Clipboard -Value $public } catch {}
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Green
Write-Host "   SightSea is live:  $public" -ForegroundColor Green
Write-Host "   (copied to your clipboard - open it on any phone, anywhere)" -ForegroundColor Green
Write-Host "  ============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  First visit on a phone: tap 'Visit Site' on ngrok's page, allow the camera,"
Write-Host "  then tap the screen once so sound works."
Write-Host "  Wrist camera check: http://localhost:5000/wrist/snapshot.jpg"
Write-Host "  To stop: close the backend and ngrok windows."
if (-not $Domain) {
    Write-Host ""
    Warn "Tip: this link changes every restart. Claim your free static domain at"
    Warn "https://dashboard.ngrok.com/domains and add NGROK_DOMAIN=your-name.ngrok-free.app to backend\.env"
}
