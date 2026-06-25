// HomeChat — LAN-only family chat. HTTP + WebSocket in one Node process.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import db, { DATA_DIR, UPLOAD_DIR } from './db.js';
import {
  createUser, findUser, userCount, verifyPassword,
  createSession, getSessionUser, destroySession, parseCookies,
} from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD = 25 * 1024 * 1024; // 25 MB
const COOKIE = 'homechat_session';
const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

await mkdir(DATA_DIR, { recursive: true });
await mkdir(UPLOAD_DIR, { recursive: true });

// ---- helpers ---------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return; // keep draining the stream, stop buffering
      size += c.length;
      if (size > limit) {
        aborted = true;
        chunks.length = 0; // free memory; respond cleanly instead of killing the socket
        reject(new Error('TOO_LARGE'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function authUser(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return getSessionUser(cookies[COOKIE]);
}

// ---- receipts (per-user delivered/read high-water marks) -------------------

// All registered usernames — used by the client for @mention autocomplete.
function allUsernames() {
  return db.prepare('SELECT username FROM users ORDER BY username COLLATE NOCASE').all().map((r) => r.username);
}

// Returns { username: { delivered, read } } for every user that has progress.
function allMarks() {
  const rows = db.prepare('SELECT username, delivered_upto, read_upto FROM read_state').all();
  const out = {};
  for (const r of rows) out[r.username] = { delivered: r.delivered_upto, read: r.read_upto };
  return out;
}

// Bump a user's marks forward (never backward). kind = 'delivered' | 'read'.
// 'read' implies 'delivered'. Returns true if anything actually changed.
function bumpMark(user, kind, upto) {
  upto = Number(upto) || 0;
  if (upto <= 0) return false;
  const cur = db.prepare('SELECT delivered_upto, read_upto FROM read_state WHERE user_id = ?').get(user.id)
    || { delivered_upto: 0, read_upto: 0 };
  let { delivered_upto: d, read_upto: r } = cur;
  if (kind === 'read') { r = Math.max(r, upto); d = Math.max(d, upto); }
  else { d = Math.max(d, upto); }
  if (d === cur.delivered_upto && r === cur.read_upto) return false;
  db.prepare(
    `INSERT INTO read_state (user_id, username, delivered_upto, read_upto, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       username = excluded.username,
       delivered_upto = excluded.delivered_upto,
       read_upto = excluded.read_upto,
       updated_at = excluded.updated_at`
  ).run(user.id, user.username, d, r, Date.now());
  return true;
}

// Aggregate reactions for a message: [{ emoji, users: [usernames] }].
function reactionsFor(messageId) {
  const rows = db
    .prepare('SELECT emoji, username FROM reactions WHERE message_id = ? ORDER BY created_at')
    .all(messageId);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.emoji)) map.set(r.emoji, []);
    map.get(r.emoji).push(r.username);
  }
  return [...map].map(([emoji, users]) => ({ emoji, users }));
}

function messageWithAttachment(row) {
  const msg = {
    id: row.id, username: row.username, body: row.body,
    created_at: row.created_at, attachment: null,
    reactions: reactionsFor(row.id),
  };
  if (row.attachment_id) {
    const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(row.attachment_id);
    if (a) {
      msg.attachment = {
        id: a.id, url: `/uploads/${a.stored_name}`,
        name: a.original_name, mime: a.mime, size: a.size,
      };
    }
  }
  return msg;
}

// ---- static + uploads ------------------------------------------------------

async function serveStatic(res, urlPath) {
  let file = urlPath === '/' ? '/index.html' : urlPath;
  const full = join(PUBLIC_DIR, file.replace(/\.\./g, ''));
  if (!full.startsWith(PUBLIC_DIR) || !existsSync(full)) return send(res, 404, { error: 'Not found' });
  const data = await readFile(full);
  res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
  res.end(data);
}

function serveUpload(req, res, storedName) {
  if (!authUser(req)) return send(res, 401, { error: 'Unauthorized' });
  const safe = basename(storedName); // prevent traversal
  const a = db.prepare('SELECT * FROM attachments WHERE stored_name = ?').get(safe);
  const full = join(UPLOAD_DIR, safe);
  if (!a || !existsSync(full)) return send(res, 404, { error: 'Not found' });
  // Inline so browsers render images/PDFs in-page instead of downloading.
  res.writeHead(200, {
    'Content-Type': a.mime || 'application/octet-stream',
    'Content-Disposition': `inline; filename="${encodeURIComponent(a.original_name)}"`,
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  createReadStream(full).pipe(res);
}

// ---- request router --------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method;

    // --- API ---
    if (path === '/api/register' && method === 'POST') {
      const { username, password } = JSON.parse((await readBody(req)).toString() || '{}');
      const u = (username || '').trim();
      if (!u || !password || u.length > 32) return send(res, 400, { error: 'Username and password required' });
      if (findUser(u)) return send(res, 409, { error: 'That username is taken' });
      const user = createUser(u, password);
      const token = createSession(user.id);
      return send(res, 200, { username: user.username }, { 'Set-Cookie': cookie(token) });
    }

    if (path === '/api/login' && method === 'POST') {
      const { username, password } = JSON.parse((await readBody(req)).toString() || '{}');
      const user = findUser((username || '').trim());
      if (!user || !verifyPassword(password || '', user.salt, user.pass_hash))
        return send(res, 401, { error: 'Wrong username or password' });
      const token = createSession(user.id);
      return send(res, 200, { username: user.username }, { 'Set-Cookie': cookie(token) });
    }

    if (path === '/api/logout' && method === 'POST') {
      const cookies = parseCookies(req.headers.cookie || '');
      destroySession(cookies[COOKIE]);
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    }

    if (path === '/api/me' && method === 'GET') {
      const user = authUser(req);
      return send(res, 200, { user: user || null, hasUsers: userCount() > 0 });
    }

    if (path === '/api/messages' && method === 'GET') {
      const me = authUser(req);
      if (!me) return send(res, 401, { error: 'Unauthorized' });
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
      const rows = db
        .prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?')
        .all(limit)
        .reverse();
      // Seed receipts from the persisted baseline, and tell the client who is online now.
      return send(res, 200, {
        messages: rows.map(messageWithAttachment),
        me: me.username,
        marks: allMarks(),
        presence: presenceList(),
        users: allUsernames(),
      });
    }

    if (path === '/api/upload' && method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Unauthorized' });
      const buf = await readBody(req);
      if (!buf.length) return send(res, 400, { error: 'Empty file' });
      const mime = req.headers['content-type'] || 'application/octet-stream';
      const original = decodeURIComponent(req.headers['x-filename'] || 'file');
      const id = randomUUID();
      const ext = extname(original) || extFromMime(mime);
      const storedName = `${id}${ext}`;
      await writeFile(join(UPLOAD_DIR, storedName), buf);
      db.prepare(
        'INSERT INTO attachments (id, stored_name, original_name, mime, size, created_at) VALUES (?,?,?,?,?,?)'
      ).run(id, storedName, original, mime, buf.length, Date.now());
      return send(res, 200, { id, url: `/uploads/${storedName}`, name: original, mime, size: buf.length });
    }

    if (path.startsWith('/uploads/') && method === 'GET') {
      return serveUpload(req, res, path.slice('/uploads/'.length));
    }

    // --- static frontend ---
    if (method === 'GET') return serveStatic(res, path);

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err.message === 'TOO_LARGE') return send(res, 413, { error: 'File too large (max 25 MB)' });
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  }
});

function cookie(token, maxAge = 60 * 60 * 24 * 365) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function extFromMime(mime) {
  const map = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'image/webp': '.webp', 'application/pdf': '.pdf', 'text/plain': '.txt' };
  return map[mime] || '';
}

// ---- WebSocket (real-time broadcast) ---------------------------------------

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') return socket.destroy();
  const user = authUser(req);
  if (!user) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    ws.status = 'online';
    wss.emit('connection', ws, req);
  });
});

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

// Aggregate presence per USER (not per connection): a person on phone+desktop
// counts once, shown as their most-present status (online beats away).
function presenceList() {
  const byUser = new Map();
  for (const ws of clients) {
    const cur = byUser.get(ws.user.username);
    if (!cur || ws.status === 'online') byUser.set(ws.user.username, ws.status);
  }
  return [...byUser].map(([username, status]) => ({ username, status }));
}

function broadcastPresence() {
  broadcast({ type: 'presence', users: presenceList() });
}

wss.on('connection', (ws) => {
  clients.add(ws);
  broadcastPresence();
  // Tell the newcomer the current receipt baseline (covers what it missed offline).
  ws.send(JSON.stringify({ type: 'receipts', marks: allMarks() }));

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (data.type === 'chat') {
      const body = (data.body || '').slice(0, 8000) || null;
      const attachmentId = data.attachmentId || null;
      if (!body && !attachmentId) return;
      const info = db
        .prepare('INSERT INTO messages (user_id, username, body, attachment_id, created_at) VALUES (?,?,?,?,?)')
        .run(ws.user.id, ws.user.username, body, attachmentId, Date.now());
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
      // Sender has implicitly read up to their own message.
      bumpMark(ws.user, 'read', row.id);
      broadcast({ type: 'message', message: messageWithAttachment(row) });
      broadcast({ type: 'receipts', marks: allMarks() });

    } else if (data.type === 'react') {
      const emoji = data.emoji;
      const messageId = Number(data.messageId);
      if (!ALLOWED_REACTIONS.includes(emoji) || !messageId) return;
      const existing = db
        .prepare('SELECT id FROM reactions WHERE message_id=? AND user_id=? AND emoji=?')
        .get(messageId, ws.user.id, emoji);
      if (existing) {
        db.prepare('DELETE FROM reactions WHERE id=?').run(existing.id);
      } else {
        if (!db.prepare('SELECT id FROM messages WHERE id=?').get(messageId)) return;
        db.prepare(
          'INSERT INTO reactions (message_id, user_id, username, emoji, created_at) VALUES (?,?,?,?,?)'
        ).run(messageId, ws.user.id, ws.user.username, emoji, Date.now());
      }
      broadcast({ type: 'reactions', messageId, reactions: reactionsFor(messageId) });

    } else if (data.type === 'delivered' || data.type === 'read') {
      if (bumpMark(ws.user, data.type, data.upto)) {
        broadcast({ type: 'receipts', marks: allMarks() });
      }

    } else if (data.type === 'status') {
      ws.status = data.status === 'away' ? 'away' : 'online';
      broadcastPresence();

    } else if (data.type === 'typing') {
      broadcast({ type: 'typing', username: ws.user.username });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastPresence();
  });
});

// Best-effort LAN address so the startup banner shows a URL other devices can use.
function lanAddress() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

server.listen(PORT, HOST, () => {
  const lan = lanAddress();
  console.log(`\n  HomeChat running:`);
  console.log(`    Local:   http://localhost:${PORT}`);
  if (lan) console.log(`    Network: http://${lan}:${PORT}  (share this one with other devices on your LAN)`);
  console.log('');
});
