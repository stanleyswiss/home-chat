// HomeChat frontend — vanilla JS. Works on plain HTTP (uses the `paste` event,
// not the secure-context-gated Clipboard API, so it works on the LAN IP too).

const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(path, { credentials: 'same-origin', ...opts });

let me = null;
let ws = null;
let staged = [];            // { id, name, mime, url, size }
let registerMode = false;

let marks = {};             // { username: { delivered, read } }  (receipt high-water marks)
let presenceUsers = [];     // [ { username, status } ]  (currently connected)
let knownUsers = [];        // all registered usernames (for @mention autocomplete)
let lastMsgId = 0;          // highest message id seen
let deliveredAcked = 0, readAcked = 0;
const msgIndex = new Map(); // id -> { ticksEl|null }

let manualAway = false;     // sticky: stays away until the user clears it
let idle = false;
let idleTimer = null;
const IDLE_MS = 3 * 60 * 1000;

const isPopup = window.name === 'homechat-popup' || window.opener != null;

// ---------- Notifications (sound + tab badge + native desktop) ----------
// Sound and the tab-title badge work on plain HTTP. Native desktop notifications
// require a secure context (HTTPS or localhost), so we feature-detect and
// gracefully disable that toggle where the browser won't allow it.

const settings = {
  sound: localStorage.getItem('hc_sound') !== '0',      // default ON
  desktop: localStorage.getItem('hc_desktop') === '1',  // default OFF (needs permission)
};
const canDesktop = ('Notification' in window) && window.isSecureContext;
let audioCtx = null;
let unread = 0;
const baseTitle = 'HomeChat';

function initAudio() {
  if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
}

// A short, pleasant two-note chime synthesized on the fly (no audio file).
function playChime() {
  if (!settings.sound) return;
  initAudio();
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  [[880, 0], [1318.5, 0.12]].forEach(([freq, t]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + t);
    gain.gain.exponentialRampToValueAtTime(0.25, now + t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.35);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + t);
    osc.stop(now + t + 0.4);
  });
}

function showDesktopNotification(m) {
  if (!settings.desktop || !canDesktop || Notification.permission !== 'granted') return;
  if (isActive()) return; // don't pop up while they're actively looking
  const body = m.body
    ? m.body.slice(0, 120)
    : m.attachment ? (m.attachment.mime.startsWith('image/') ? '📷 Photo' : '📎 ' + m.attachment.name) : '';
  try {
    const n = new Notification(`${m.username} · HomeChat`, {
      body, tag: 'homechat-msg', renotify: true,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}

function bumpUnread() {
  if (isActive()) return;
  unread++;
  document.title = `(${unread}) ${baseTitle}`;
}
function clearUnread() { unread = 0; document.title = baseTitle; }

// Notify on an incoming message from someone else.
function notifyIncoming(m) {
  if (m.username === me) return;
  playChime();
  bumpUnread();
  showDesktopNotification(m);
}

// --- settings UI ---
function renderNotifUI() {
  $('opt-sound').checked = settings.sound;
  const desk = $('opt-desktop');
  desk.checked = settings.desktop && canDesktop && Notification.permission === 'granted';
  desk.disabled = !canDesktop;
  const note = $('notif-note');
  if (!canDesktop) {
    note.textContent = window.isSecureContext
      ? 'Desktop pop-ups aren’t supported in this browser.'
      : 'Desktop pop-ups need HTTPS — they work on this machine via localhost, but not over the home network address. Sound + tab badge still work everywhere.';
  } else if (Notification.permission === 'denied') {
    note.textContent = 'Blocked in browser settings — re-allow notifications for this site to use this.';
  } else {
    note.textContent = '';
  }
}

function wireNotifUI() {
  $('notif-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('notif-menu').classList.toggle('hidden');
    renderNotifUI();
  });
  document.addEventListener('click', (e) => {
    if (!$('notif-menu').contains(e.target) && e.target !== $('notif-btn'))
      $('notif-menu').classList.add('hidden');
  });
  $('opt-sound').addEventListener('change', (e) => {
    settings.sound = e.target.checked;
    localStorage.setItem('hc_sound', settings.sound ? '1' : '0');
    if (settings.sound) { initAudio(); playChime(); }
  });
  $('opt-desktop').addEventListener('change', async (e) => {
    if (e.target.checked) {
      if (!canDesktop) { e.target.checked = false; return; }
      const perm = await Notification.requestPermission();
      settings.desktop = perm === 'granted';
      if (settings.desktop) new Notification('HomeChat', { body: 'Desktop notifications are on 👍' });
    } else {
      settings.desktop = false;
    }
    localStorage.setItem('hc_desktop', settings.desktop ? '1' : '0');
    renderNotifUI();
  });
  $('notif-test').addEventListener('click', () => { initAudio(); playChime(); });
}

// ---------- Auth ----------

const authEl = $('auth'), chatEl = $('chat');

function showAuth() {
  authEl.classList.remove('hidden');
  chatEl.classList.add('hidden');
}
function showChat() {
  authEl.classList.add('hidden');
  chatEl.classList.remove('hidden');
  $('me-name').textContent = me;
  if (isPopup) $('popout').classList.add('hidden');
  wireNotifUI();
  renderNotifUI();
  buildPicker();
  // Unlock audio on the first user gesture (autoplay policy).
  window.addEventListener('pointerdown', initAudio, { once: true });
  window.addEventListener('keydown', initAudio, { once: true });
  loadHistory();
  connectWS();
  startActivityTracking();
  $('input').focus();
}

function setMode(toRegister) {
  registerMode = toRegister;
  $('auth-sub').textContent = toRegister ? 'Create an account for the household' : 'Sign in to chat with the household';
  $('auth-btn').textContent = toRegister ? 'Create account' : 'Sign in';
  $('toggle-text').textContent = toRegister ? 'Already have an account?' : 'New here?';
  $('toggle-link').textContent = toRegister ? 'Sign in' : 'Create an account';
  $('password').autocomplete = toRegister ? 'new-password' : 'current-password';
  $('auth-error').textContent = '';
}

$('toggle-link').addEventListener('click', (e) => { e.preventDefault(); setMode(!registerMode); });

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('username').value.trim();
  const password = $('password').value;
  const endpoint = registerMode ? '/api/register' : '/api/login';
  const res = await api(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('auth-error').textContent = data.error || 'Something went wrong'; return; }
  me = data.username;
  showChat();
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  if (ws) { ws.onclose = null; ws.close(); }
  me = null;
  location.reload();
});

// ---------- WebSocket ----------

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { pushStatus(); maybeAck(); };
  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === 'message') {
      addMessage(data.message, true);
      lastMsgId = Math.max(lastMsgId, data.message.id);
      notifyIncoming(data.message);
      maybeAck();
    } else if (data.type === 'presence') {
      presenceUsers = data.users || [];
      renderPresence();
    } else if (data.type === 'receipts') {
      marks = data.marks || {};
      updateReceipts();
      renderPresence();
    } else if (data.type === 'reactions') {
      renderReactions(data.messageId, data.reactions);
    }
  };
  ws.onclose = () => {
    $('presence').textContent = 'reconnecting…';
    setTimeout(() => { if (me) connectWS(); }, 1500);
  };
}

// ---------- Presence / status ----------

function renderPresence() {
  // Roster = everyone who's connected now + everyone who has ever used the app,
  // minus me. Connected → online/away; otherwise offline.
  const statusOf = {};
  presenceUsers.forEach((u) => { statusOf[u.username] = u.status; });
  const roster = new Set([...presenceUsers.map((u) => u.username), ...Object.keys(marks)]);
  roster.delete(me);

  if (roster.size === 0) { $('presence').innerHTML = '<span class="dim">no one else here yet</span>'; return; }
  const html = [...roster].sort().map((u) => {
    const s = statusOf[u] || 'offline';
    const label = s === 'online' ? 'online' : s === 'away' ? 'away' : 'offline';
    return `<span class="peer"><span class="dot ${s}"></span>${escapeHtml(u)} · ${label}</span>`;
  }).join('<span class="sep">•</span>');
  $('presence').innerHTML = html;
}

function myStatus() {
  if (manualAway) return 'away';
  if (document.visibilityState !== 'visible') return 'away';
  if (idle) return 'away';
  return 'online';
}

function updateMyStatusUI() {
  const s = myStatus();
  $('my-dot').className = 'dot ' + s;
  $('my-status-text').textContent = manualAway ? 'Away' : s === 'online' ? 'Available' : 'Away';
}

function pushStatus() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'status', status: myStatus() }));
  updateMyStatusUI();
}

$('my-status').addEventListener('click', () => {
  manualAway = !manualAway;
  if (!manualAway) { idle = false; resetIdleTimer(); }
  pushStatus();
});

$('popout').addEventListener('click', () => {
  window.open(location.href, 'homechat-popup', 'popup=yes,width=440,height=760');
});

function startActivityTracking() {
  const activity = () => {
    if (idle) { idle = false; pushStatus(); }
    maybeAck();
    resetIdleTimer();
  };
  ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach((ev) =>
    window.addEventListener(ev, activity, { passive: true }));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') clearUnread();
    pushStatus(); maybeAck(); resetIdleTimer();
  });
  window.addEventListener('focus', () => { clearUnread(); pushStatus(); maybeAck(); });
  window.addEventListener('blur', () => { pushStatus(); });
  resetIdleTimer();
}

function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { idle = true; pushStatus(); }, IDLE_MS);
}

// ---------- Receipts ----------

function receiptStatus(id) {
  const others = Object.keys(marks).filter((u) => u !== me);
  if (others.length === 0) return 'sent';
  let allRead = true, allDelivered = true;
  for (const u of others) {
    const m = marks[u];
    if (!m || m.read < id) allRead = false;
    if (!m || m.delivered < id) allDelivered = false;
  }
  return allRead ? 'read' : allDelivered ? 'delivered' : 'sent';
}

function renderTicks(el, status) {
  if (!el) return;
  el.className = 'ticks' + (status === 'read' ? ' read' : '');
  el.textContent = status === 'sent' ? '✓' : '✓✓';
  el.title = status === 'read' ? 'Read' : status === 'delivered' ? 'Delivered' : 'Sent';
}

function updateReceipts() {
  for (const [id, rec] of msgIndex) {
    if (rec.ticksEl) renderTicks(rec.ticksEl, receiptStatus(id));
  }
}

// Send delivered/read acks up to the latest message we've seen.
function maybeAck() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !lastMsgId) return;
  if (lastMsgId > deliveredAcked) {
    ws.send(JSON.stringify({ type: 'delivered', upto: lastMsgId }));
    deliveredAcked = lastMsgId;
  }
  if (isActive() && lastMsgId > readAcked) {
    ws.send(JSON.stringify({ type: 'read', upto: lastMsgId }));
    readAcked = lastMsgId;
  }
}

function isActive() { return document.visibilityState === 'visible' && document.hasFocus(); }

// ---------- Reactions ----------

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
let pickerTarget = null;

function buildPicker() {
  const p = $('react-picker');
  p.innerHTML = REACTIONS.map((e) => `<button class="rp-emoji" data-emoji="${e}">${e}</button>`).join('');
  p.querySelectorAll('.rp-emoji').forEach((b) =>
    b.addEventListener('click', () => {
      if (pickerTarget != null) sendReact(pickerTarget, b.dataset.emoji);
      hidePicker();
    }));
}

function openPicker(btn, mid) {
  pickerTarget = mid;
  const p = $('react-picker');
  p.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  const pw = p.offsetWidth || 230, ph = p.offsetHeight || 44;
  let left = Math.max(8, Math.min(r.left + r.width / 2 - pw / 2, window.innerWidth - pw - 8));
  let top = r.top - ph - 8;
  if (top < 8) top = r.bottom + 8; // flip below if no room above
  p.style.left = left + 'px';
  p.style.top = top + 'px';
}

function hidePicker() { $('react-picker').classList.add('hidden'); pickerTarget = null; }

function sendReact(mid, emoji) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'react', messageId: mid, emoji }));
}

function renderReactions(mid, reactions) {
  const rec = msgIndex.get(mid);
  if (!rec || !rec.reactsEl) return;
  const el = rec.reactsEl;
  if (!reactions || reactions.length === 0) { el.innerHTML = ''; el.classList.remove('has'); return; }
  el.classList.add('has');
  el.innerHTML = reactions.map((r) => {
    const mine = r.users.includes(me);
    return `<button class="chip${mine ? ' mine' : ''}" data-mid="${mid}" data-emoji="${r.emoji}"
      title="${escapeHtml(r.users.join(', '))}">${r.emoji}<span class="cnt">${r.users.length}</span></button>`;
  }).join('');
}

// Close the picker on outside click or Escape.
document.addEventListener('click', (e) => {
  const p = $('react-picker');
  if (!p.classList.contains('hidden') && !p.contains(e.target) && !e.target.closest('.react-btn')) hidePicker();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePicker(); });

// ---------- Messages ----------

const messagesEl = $('messages');
let lastDay = null;

async function loadHistory() {
  messagesEl.innerHTML = '';
  msgIndex.clear();
  lastDay = null;
  const res = await api('/api/messages?limit=200');
  if (!res.ok) return;
  const data = await res.json();
  me = data.me || me;
  marks = data.marks || {};
  presenceUsers = data.presence || [];
  knownUsers = data.users || [];
  data.messages.forEach((m) => addMessage(m, false));
  if (data.messages.length) lastMsgId = data.messages[data.messages.length - 1].id;
  updateReceipts();
  renderPresence();
  scrollToBottom();
  maybeAck(); // ack everything that arrived while we were away
}

function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (sameDay) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function linkify(s) {
  return escapeHtml(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Wrap @username tokens (for known users) in a styled span. Requires whitespace or
// start before the @, which also keeps it from matching inside URLs (e.g. /@x).
function highlightMentions(html) {
  if (!knownUsers.length) return html;
  const names = knownUsers.map(escapeRegex).sort((a, b) => b.length - a.length).join('|');
  const re = new RegExp('(^|\\s)@(' + names + ')(?![\\w.-])', 'gi');
  return html.replace(re, (_m, pre, name) => {
    const mine = name.toLowerCase() === (me || '').toLowerCase();
    return `${pre}<span class="mention${mine ? ' mention-me' : ''}">@${name}</span>`;
  });
}

function renderText(s) { return highlightMentions(linkify(s)); }

function bodyMentionsMe(body) {
  if (!body || !me) return false;
  return new RegExp('(^|\\s)@' + escapeRegex(me) + '(?![\\w.-])', 'i').test(body);
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function attachmentHtml(a) {
  if (a.mime.startsWith('image/')) {
    return `<div class="attachment"><img src="${a.url}" loading="lazy" alt="${escapeHtml(a.name)}" data-zoom="${a.url}"></div>`;
  }
  if (a.mime === 'application/pdf') {
    return `<div class="attachment"><iframe src="${a.url}#toolbar=1" title="${escapeHtml(a.name)}"></iframe>
      <a class="file-card" href="${a.url}" target="_blank" rel="noopener" style="margin-top:6px">
        <span class="fc-icon">📄</span><span><span class="fc-name">${escapeHtml(a.name)}</span>
        <span class="fc-meta">${fmtSize(a.size)} · open</span></span></a></div>`;
  }
  const icon = a.mime.startsWith('video/') ? '🎬' : a.mime.startsWith('audio/') ? '🎵' : '📎';
  return `<div class="attachment"><a class="file-card" href="${a.url}" target="_blank" rel="noopener" download>
    <span class="fc-icon">${icon}</span><span><span class="fc-name">${escapeHtml(a.name)}</span>
    <span class="fc-meta">${fmtSize(a.size)} · download</span></span></a></div>`;
}

function addMessage(m, animate) {
  const day = dayLabel(m.created_at);
  if (day !== lastDay) {
    const sep = document.createElement('div');
    sep.className = 'day-sep';
    sep.textContent = day;
    messagesEl.appendChild(sep);
    lastDay = day;
  }
  const out = m.username === me;
  const mentionsMe = !out && bodyMentionsMe(m.body);
  const row = document.createElement('div');
  row.className = 'row ' + (out ? 'out' : 'in');
  const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  row.innerHTML = `<div class="bubble${mentionsMe ? ' mentions-me' : ''}">
    <button class="react-btn" data-mid="${m.id}" title="Add a reaction" aria-label="Add a reaction">🙂</button>
    ${out ? '' : `<div class="sender">${escapeHtml(m.username)}</div>`}
    ${m.attachment ? attachmentHtml(m.attachment) : ''}
    ${m.body ? `<div class="text">${renderText(m.body)}</div>` : ''}
    <div class="time">${time}${out ? ' <span class="ticks">✓</span>' : ''}</div>
    <div class="reactions" data-mid="${m.id}"></div>
  </div>`;
  messagesEl.appendChild(row);

  const ticksEl = out ? row.querySelector('.ticks') : null;
  const reactsEl = row.querySelector('.reactions');
  msgIndex.set(m.id, { ticksEl, reactsEl });
  if (ticksEl) renderTicks(ticksEl, receiptStatus(m.id));
  renderReactions(m.id, m.reactions || []);

  if (animate) scrollToBottom();
}

function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

// ---------- Sending ----------

const input = $('input');

function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}

input.addEventListener('input', () => { autoResize(); updateMention(); });

input.addEventListener('keydown', (e) => {
  if (mention.open) {
    if (e.key === 'ArrowDown') { e.preventDefault(); mention.sel = (mention.sel + 1) % mention.items.length; renderMentionBox(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mention.sel = (mention.sel - 1 + mention.items.length) % mention.items.length; renderMentionBox(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptMention(mention.items[mention.sel]); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeMention(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

input.addEventListener('blur', () => setTimeout(closeMention, 150));

// ---------- @mention autocomplete ----------

const mbox = $('mention-box');
const mention = { open: false, start: -1, items: [], sel: 0 };

function updateMention() {
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const m = before.match(/(^|\s)@([\p{L}\p{N}._-]*)$/u);
  if (!m) return closeMention();
  const query = m[2].toLowerCase();
  const others = knownUsers.filter((u) => u.toLowerCase() !== (me || '').toLowerCase());
  let items = others.filter((u) => u.toLowerCase().startsWith(query));
  if (!items.length && query) items = others.filter((u) => u.toLowerCase().includes(query));
  if (!items.length) return closeMention();
  mention.open = true;
  mention.start = caret - m[2].length - 1; // position of '@'
  mention.items = items.slice(0, 6);
  mention.sel = 0;
  renderMentionBox();
}

function renderMentionBox() {
  mbox.innerHTML = mention.items
    .map((u, i) => `<li class="${i === mention.sel ? 'sel' : ''}" data-u="${escapeHtml(u)}">@${escapeHtml(u)}</li>`)
    .join('');
  mbox.classList.remove('hidden');
}

function closeMention() {
  if (!mention.open) return;
  mention.open = false;
  mbox.classList.add('hidden');
  mbox.innerHTML = '';
}

function acceptMention(username) {
  if (!username) return closeMention();
  const caret = input.selectionStart;
  const before = input.value.slice(0, mention.start);
  const after = input.value.slice(caret);
  const insert = '@' + username + ' ';
  input.value = before + insert + after;
  const pos = before.length + insert.length;
  input.setSelectionRange(pos, pos);
  closeMention();
  autoResize();
  input.focus();
}

// mousedown (not click) so the textarea doesn't blur before we insert.
mbox.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (li) { e.preventDefault(); acceptMention(li.dataset.u); }
});

$('send-btn').addEventListener('click', sendMessage);

function sendMessage() {
  const body = input.value.trim();
  if (!body && staged.length === 0) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  if (staged.length === 0) {
    ws.send(JSON.stringify({ type: 'chat', body }));
  } else {
    // First staged item carries the text; the rest send as their own messages.
    staged.forEach((s, i) => {
      ws.send(JSON.stringify({ type: 'chat', body: i === 0 ? body : '', attachmentId: s.id }));
    });
  }
  input.value = '';
  input.style.height = 'auto';
  clearStaged();
  closeMention();
}

// ---------- Uploads: paste, drag-drop, file picker ----------

async function uploadFile(file) {
  const placeholder = { id: null, name: file.name || 'pasted', mime: file.type, size: file.size, uploading: true };
  staged.push(placeholder);
  renderStaged();
  try {
    const res = await api('/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name || `pasted-${Date.now()}.png`),
      },
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'upload failed');
    Object.assign(placeholder, data, { uploading: false });
  } catch (err) {
    staged = staged.filter((s) => s !== placeholder);
    alert('Upload failed: ' + err.message);
  }
  renderStaged();
}

function renderStaged() {
  const el = $('staged');
  if (staged.length === 0) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = staged.map((s, i) => {
    const thumb = s.mime && s.mime.startsWith('image/') && s.url
      ? `<img src="${s.url}" alt="">`
      : `<span style="font-size:28px">${s.mime === 'application/pdf' ? '📄' : '📎'}</span>`;
    return `<div class="staged-item ${s.uploading ? 'uploading' : ''}">
      ${thumb}<span class="si-name">${escapeHtml(s.name)}${s.uploading ? ' · uploading…' : ''}</span>
      <button class="si-remove" data-i="${i}">×</button></div>`;
  }).join('');
  el.querySelectorAll('.si-remove').forEach((b) =>
    b.addEventListener('click', () => { staged.splice(Number(b.dataset.i), 1); renderStaged(); }));
}

function clearStaged() { staged = []; renderStaged(); }

// Paste (works on plain HTTP — this is the CleanShot X / screenshot path)
document.addEventListener('paste', (e) => {
  if (!authEl.classList.contains('hidden')) return; // not logged in
  const items = e.clipboardData?.items;
  if (!items) return;
  let handled = false;
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) { uploadFile(file); handled = true; }
    }
  }
  if (handled) e.preventDefault();
});

// File picker
$('attach-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  [...e.target.files].forEach(uploadFile);
  e.target.value = '';
});

// Drag & drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (chatEl.classList.contains('hidden')) return;
  e.preventDefault(); dragDepth++; $('drop-hint').classList.remove('hidden');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) $('drop-hint').classList.add('hidden'); });
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('drop-hint').classList.add('hidden');
  if (chatEl.classList.contains('hidden')) return;
  [...(e.dataTransfer?.files || [])].forEach(uploadFile);
});

// Lightbox
messagesEl.addEventListener('click', (e) => {
  const img = e.target.closest('img[data-zoom]');
  if (img) { $('lightbox-img').src = img.dataset.zoom; $('lightbox').classList.remove('hidden'); return; }
  const chip = e.target.closest('.chip');
  if (chip) { sendReact(Number(chip.dataset.mid), chip.dataset.emoji); return; }
  const rb = e.target.closest('.react-btn');
  if (rb) { e.stopPropagation(); openPicker(rb, Number(rb.dataset.mid)); }
});
$('lightbox').addEventListener('click', () => $('lightbox').classList.add('hidden'));

// ---------- Boot ----------

(async function init() {
  const res = await api('/api/me');
  const data = await res.json().catch(() => ({}));
  if (data.user) { me = data.user.username; showChat(); }
  else { setMode(!data.hasUsers); showAuth(); }
})();
