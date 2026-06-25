// SQLite persistence layer using Node's built-in node:sqlite (no native build).
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable so an isolated instance (e.g. for testing) can use its own storage.
export const DATA_DIR = process.env.HOMECHAT_DATA_DIR || join(__dirname, 'data');
export const UPLOAD_DIR = process.env.HOMECHAT_UPLOAD_DIR || join(__dirname, 'uploads');

// Dirs must exist before the DB file is opened (this runs at import time).
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, 'homechat.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    pass_hash  TEXT NOT NULL,
    salt       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id            TEXT PRIMARY KEY,
    stored_name   TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username      TEXT NOT NULL,
    body          TEXT,
    attachment_id TEXT REFERENCES attachments(id),
    created_at    INTEGER NOT NULL
  );

  -- Per-user high-water marks for delivery/read receipts. Persisted so
  -- receipts survive reloads and server restarts (not just live deltas).
  CREATE TABLE IF NOT EXISTS read_state (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    username       TEXT NOT NULL,
    delivered_upto INTEGER NOT NULL DEFAULT 0,
    read_upto      INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL DEFAULT 0
  );

  -- Emoji reactions: one row per (message, user, emoji). A user may stack
  -- several different emojis on a message; toggling re-adds/removes a row.
  CREATE TABLE IF NOT EXISTS reactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username   TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(message_id, user_id, emoji)
  );
`);

export default db;
