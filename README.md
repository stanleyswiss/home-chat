# HomeChat

A tiny **self-hosted, LAN-only chat** that runs in the browser. Real-time messages,
username + password login, **paste-a-screenshot-straight-in**, drag-drop attachments
with inline image/PDF rendering, WhatsApp-style **read receipts**, **online/away/offline
presence**, and **notification sounds**.

Runs as a single Node process on a machine on your home network. No cloud, no external
accounts, no telemetry — your messages never leave your LAN.

> Built for a household (two people on different floors who wanted to share screenshots
> without going through a cloud messenger), but it works for any small trusted group on
> the same network.

## Features

- 💬 **Real-time chat** over WebSocket — instant, no refresh
- 📋 **Paste images directly** from the clipboard (screenshot tools, Print Screen, etc.)
- 🖱️ **Drag & drop** files anywhere, plus a file picker
- 🖼️ **Inline rendering** — images (click to zoom), PDFs (embedded viewer), other files as download cards
- ✓✓ **Delivery & read receipts** — sent → delivered → read (blue), persisted across reloads/restarts
- 😄 **Emoji reactions** — react to any message (👍 ❤️ 😂 😮 😢 🙏); aggregated chips with counts, real-time, persisted
- 🏷️ **@mentions** — type `@` for username autocomplete; mentions are highlighted, and messages that tag you stand out
- 🟢 **Presence** — online / away / offline, with auto-away on idle and a manual "Away" toggle
- 🔔 **Notification sound** + unread badge in the tab title; optional native desktop notifications (HTTPS only — see Notes)
- ⧉ **Pop-out window** — open the chat in its own chrome-less window
- 🔒 **Username + password** auth (scrypt-hashed; never stored in plaintext)
- 💾 **Persistent history** in SQLite — survives restarts
- 📎 Up to 25 MB per file

## Quick start

Requires **Node.js 22.5+** (uses the built-in `node:sqlite`).

```bash
git clone https://github.com/stanleyswiss/home-chat.git
cd home-chat
npm install
npm start
```

You'll see:

```
  HomeChat running:
    Local:   http://localhost:8787
    Network: http://192.168.x.x:8787  (share this one with other devices on your LAN)
```

Open the **Network** URL on any device on the same Wi-Fi/LAN. The first visitor sees a
**"Create an account"** screen — each person picks a username + password once, then just
logs in. Sessions last a year.

### Configuration

| Env var                | Default      | Description                               |
|------------------------|--------------|-------------------------------------------|
| `PORT`                 | `8787`       | Port to listen on                         |
| `HOST`                 | `0.0.0.0`    | Bind address (`0.0.0.0` = all interfaces) |
| `HOMECHAT_DATA_DIR`    | `./data`     | Where the SQLite database is stored       |
| `HOMECHAT_UPLOAD_DIR`  | `./uploads`  | Where uploaded files are stored           |

```bash
PORT=9000 npm start
```

> **Node version note:** `node:sqlite` is stable on Node 23+ and available on 22.5+.
> On some 22.x builds you may need to start with `node --experimental-sqlite server.js`.

## How it works

A single Node process serves the static frontend, a small JSON API, file uploads, and a
WebSocket for real-time delivery. The only runtime dependency is `ws` (a pure-JS
WebSocket library — no native compilation). Storage uses Node's built-in `node:sqlite`,
and password hashing uses built-in `node:crypto` (scrypt).

```
server.js        HTTP + WebSocket server, routing, uploads, presence, receipts
db.js            SQLite schema & connection
auth.js          scrypt password hashing + cookie sessions
public/
  index.html     app shell
  style.css      WhatsApp-style dark UI
  app.js         client: chat, paste/drag upload, receipts, presence, notifications
data/            SQLite database (created at runtime, gitignored)
uploads/         stored attachments (created at runtime, gitignored)
```

### Data model

- `users` — accounts (scrypt hash + salt)
- `sessions` — cookie session tokens
- `messages` — chat messages (optional body + optional attachment)
- `attachments` — uploaded file metadata (files live on disk in `uploads/`)
- `read_state` — per-user delivered/read high-water marks (drives receipts)
- `reactions` — emoji reactions, one row per (message, user, emoji)

## Security & scope

This is designed for a **trusted LAN**, not the public internet:

- It binds to `0.0.0.0` so other devices on your network can reach it. It is **not**
  exposed to the internet unless you deliberately forward a port or put it behind a proxy.
- Passwords are scrypt-hashed; session cookies are `HttpOnly` + `SameSite=Lax`.
- There's no rate limiting, account recovery, or admin panel — keep it on your LAN.

**If you want to expose it beyond your LAN, put it behind HTTPS first** (a reverse proxy
such as Caddy/nginx, or a tunnel). The clipboard-paste, native notifications, and any
future installable-PWA support all rely on a **secure context**, which browsers only grant
over HTTPS or `localhost` — see below.

### Secure-context caveats (plain HTTP over a LAN IP)

Browsers treat `localhost` as a secure context but **not** a plain-HTTP LAN IP like
`http://192.168.1.50`. This project is built to degrade gracefully:

| Feature | Plain HTTP (LAN IP) | HTTPS / localhost |
|---|---|---|
| Paste images | ✅ (uses the `paste` event, not the Clipboard API) | ✅ |
| Notification sound + tab badge | ✅ | ✅ |
| Native desktop notifications | ❌ (toggle disabled, with an in-app note) | ✅ |
| Installable PWA | ❌ | ✅ (not bundled here) |

## Running it persistently

To keep it alive across reboots on Linux, a `systemd --user` unit works well:

```ini
# ~/.config/systemd/user/home-chat.service
[Unit]
Description=HomeChat
After=network.target

[Service]
WorkingDirectory=%h/home-chat
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now home-chat
loginctl enable-linger "$USER"   # so it runs without an active login session
```

## License

[MIT](LICENSE) © stanleyswiss
