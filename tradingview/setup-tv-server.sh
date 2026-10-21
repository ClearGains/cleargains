#!/usr/bin/env bash
# Sets up a headless Ubuntu 22.04 ARM (Oracle A1) server to run TradingView's
# web app in Chromium, controllable over the Chrome DevTools Protocol (for the
# tradingview-mcp bridge), with a private remote screen (noVNC) for the one-off
# TradingView login. Everything listens on localhost only — reach it through
# an SSH tunnel, never the open internet.
set -euo pipefail

sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  xvfb x11vnc fluxbox novnc websockify git curl ca-certificates fonts-liberation

# Chromium (snap is the supported ARM64 build on Ubuntu 22.04)
sudo snap install chromium

# Node.js 20 for the MCP bridge
if ! command -v node >/dev/null || ! node -v | grep -q '^v2[0-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# tradingview-mcp bridge (MIT, drives TradingView via CDP)
if [ ! -d ~/tradingview-mcp ]; then
  git clone --depth 1 https://github.com/tradesdontlie/tradingview-mcp.git ~/tradingview-mcp
fi
(cd ~/tradingview-mcp && npm install --omit=dev)

mkdir -p ~/tv-profile

# ── systemd services ─────────────────────────────────────────────────────────
sudo tee /etc/systemd/system/tv-xvfb.service >/dev/null <<'EOF'
[Unit]
Description=Virtual screen :99
[Service]
User=ubuntu
ExecStart=/usr/bin/Xvfb :99 -screen 0 1600x900x24 -nolisten tcp
Restart=always
[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/tv-wm.service >/dev/null <<'EOF'
[Unit]
Description=Window manager on :99
After=tv-xvfb.service
Requires=tv-xvfb.service
[Service]
User=ubuntu
Environment=DISPLAY=:99
ExecStart=/usr/bin/fluxbox
Restart=always
[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/tv-chromium.service >/dev/null <<'EOF'
[Unit]
Description=Chromium with TradingView, DevTools on localhost:9222
After=tv-wm.service
Requires=tv-xvfb.service
[Service]
User=ubuntu
Environment=DISPLAY=:99
ExecStart=/snap/bin/chromium --no-first-run --no-default-browser-check \
  --user-data-dir=/home/ubuntu/tv-profile \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --window-size=1600,900 --start-maximized https://www.tradingview.com/chart/
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/tv-vnc.service >/dev/null <<'EOF'
[Unit]
Description=VNC of :99 on localhost only
After=tv-xvfb.service
Requires=tv-xvfb.service
[Service]
User=ubuntu
ExecStart=/usr/bin/x11vnc -display :99 -localhost -forever -shared -nopw -quiet
Restart=always
[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/tv-novnc.service >/dev/null <<'EOF'
[Unit]
Description=noVNC (browser VNC) on localhost:6080
After=tv-vnc.service
[Service]
User=ubuntu
ExecStart=/usr/bin/websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900
Restart=always
[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now tv-xvfb tv-wm tv-chromium tv-vnc tv-novnc
sleep 8
systemctl --no-pager --plain is-active tv-xvfb tv-wm tv-chromium tv-vnc tv-novnc
curl -s http://127.0.0.1:9222/json/version | head -c 300; echo
echo "Setup done."
