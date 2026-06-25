// Auth: scrypt password hashing + cookie-based sessions, all via node:crypto.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import db from './db.js';

const KEYLEN = 64;

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, KEYLEN).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, salt, expectedHash) {
  const hash = scryptSync(password, salt, KEYLEN);
  const expected = Buffer.from(expectedHash, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

export function createUser(username, password) {
  const { hash, salt } = hashPassword(password);
  const info = db
    .prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)')
    .run(username, hash, salt, Date.now());
  return { id: info.lastInsertRowid, username };
}

export function findUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    Date.now()
  );
  return token;
}

export function getSessionUser(token) {
  if (!token) return null;
  return db
    .prepare(
      `SELECT u.id, u.username FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(token);
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > -1) {
      out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    }
  });
  return out;
}
