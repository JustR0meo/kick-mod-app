// Kick Mod Paneli - yerel sunucu (bağımlılık yok, Node 18+)
let WebSocket;
try { WebSocket = require('ws'); } catch { console.log('\n[HATA] "ws" paketi yok. Önce şunu çalıştır:  npm install\n'); process.exit(1); }
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch {}
const CLIENT_ID = process.env.KICK_CLIENT_ID || cfg.clientId;
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || cfg.clientSecret;
const PORT = Number(cfg.port || 3000);
if (!CLIENT_ID || !CLIENT_SECRET || CLIENT_ID.includes('BURAYA')) {
  console.log('\n[HATA] config.json eksik. config.example.json dosyasını config.json olarak kopyala,');
  console.log('       içine Kick geliştirici panelinden aldığın clientId ve clientSecret değerlerini yaz.\n');
  process.exit(1);
}
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT = `${BASE}/callback`;
const SCOPES = 'user:read channel:read chat:write moderation:ban moderation:chat_message:manage';
const TOKFILE = path.join(__dirname, 'tokens.json');
let tokens = null;
try { tokens = JSON.parse(fs.readFileSync(TOKFILE, 'utf8')); } catch {}
const pending = new Map(); // state -> verifier

const b64u = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function saveTokens(t) {
  tokens = { ...t, expires_at: Date.now() + ((t.expires_in || 3600) - 60) * 1000 };
  fs.writeFileSync(TOKFILE, JSON.stringify(tokens, null, 2));
}

async function tokenRequest(params) {
  const r = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.message || j.error || ('Token hatası ' + r.status));
  return j;
}

async function getAccessToken() {
  if (!tokens) throw Object.assign(new Error('Giriş yapılmamış'), { code: 401 });
  if (Date.now() > tokens.expires_at) {
    if (!tokens.refresh_token) { tokens = null; throw Object.assign(new Error('Oturum doldu, tekrar giriş yap'), { code: 401 }); }
    try { saveTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })); }
    catch (e) { tokens = null; try { fs.unlinkSync(TOKFILE); } catch {} throw Object.assign(new Error('Oturum yenilenemedi, tekrar giriş yap'), { code: 401 }); }
  }
  return tokens.access_token;
}

async function kick(method, p, body) {
  const token = await getAccessToken();
  const r = await fetch('https://api.kick.com/public/v1' + p, {
    method,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = {}; try { j = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok) {
    const msg = j.message || j.error || text.slice(0, 120) || '';
    throw Object.assign(new Error(`Kick ${r.status}${msg ? ': ' + msg : ''}`), { code: r.status });
  }
  return j;
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);



// ---- Güncelleme sistemi ----
// config.json içindeki updateUrl (ör. https://raw.githubusercontent.com/KULLANICI/kick-mod-app/main/) adresinden
// version.json okunur; yeni sürüm varsa listedeki dosyalar indirilir. config.json ve tokens.json'a ASLA dokunulmaz.
const ALLOWED = ['server.js', 'public/index.html', 'package.json', 'version.json'];
function localVersion() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version; } catch { return '0.0.0'; } }
function cmpVer(a, b) { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; }
async function fetchText(u) {
  const r = await fetch(u + (u.includes('?') ? '&' : '?') + 't=' + Date.now(), { headers: { 'Cache-Control': 'no-cache' } });
  if (!r.ok) throw new Error('İndirilemedi (' + r.status + '): ' + u.split('/').slice(-2).join('/'));
  return r.text();
}
function updBase() {
  const b = String(cfg.updateUrl || '').trim();
  if (!b.startsWith('https://')) throw new Error('updateUrl https:// ile başlamalı');
  return b.endsWith('/') ? b : b + '/';
}
async function checkUpdate() {
  const base = updBase();
  let m; try { m = JSON.parse(await fetchText(base + 'version.json')); } catch (e) { throw new Error('version.json okunamadı: ' + e.message); }
  const current = localVersion();
  return { base, current, latest: m.version, files: m.files || [], notes: m.notes || '', newer: cmpVer(m.version, current) > 0 };
}
async function applyUpdate() {
  const u = await checkUpdate();
  if (!u.newer) return { updated: false };
  const files = [...new Set((u.files || []).filter(f => ALLOWED.includes(f)))].filter(f => f !== 'version.json');
  const got = {};
  for (const f of files) { const t = await fetchText(u.base + f); if (!t || t.length < 20) throw new Error(f + ' boş geldi, güncelleme iptal'); got[f] = t; }
  if (got['server.js']) { try { new (require('vm').Script)(got['server.js']); } catch (e) { throw new Error('Yeni server.js hatalı, güncelleme iptal: ' + e.message); } }
  const bk = path.join(__dirname, 'backup', u.current); fs.mkdirSync(bk, { recursive: true });
  for (const f of files) { const p = path.join(__dirname, f); if (fs.existsSync(p)) { fs.mkdirSync(path.dirname(path.join(bk, f)), { recursive: true }); fs.copyFileSync(p, path.join(bk, f)); } }
  for (const f of files) { const p = path.join(__dirname, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, got[f]); }
  fs.writeFileSync(path.join(__dirname, 'version.json'), JSON.stringify({ version: u.latest, files: u.files, notes: u.notes }, null, 2));
  return { updated: true, version: u.latest };
}

// ---- Kick chat (Pusher) bağlantısı: sunucu tarafında, panele SSE ile aktarılır ----
const PUSHER_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';
const streams = new Map(); // room -> { ws, clients:Set, closed }
function emit(st, obj) { const line = 'data: ' + JSON.stringify(obj) + '\n\n'; for (const c of st.clients) c.write(line); }
function openUpstream(room) {
  const st = streams.get(room); if (!st || st.closed) return;
  const ws = new WebSocket(PUSHER_URL);
  st.ws = ws;
  ws.on('open', () => emit(st, { status: 'Kick sohbet sunucusuna bağlanıldı, kanala abone olunuyor…' }));
  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.event === 'pusher:connection_established') ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: 'chatrooms.' + room + '.v2' } }));
    else if (m.event === 'pusher:ping') ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
    else if (m.event === 'pusher_internal:subscription_succeeded') emit(st, { ready: true });
    else if (m.event === 'pusher:error') emit(st, { status: 'Kick hata verdi: ' + (typeof m.data === 'string' ? m.data : JSON.stringify(m.data)) });
    else if (m.event && !m.event.startsWith('pusher')) emit(st, { pusher: m });
  });
  ws.on('unexpected-response', (rq, rs) => emit(st, { status: 'Kick bağlantıyı reddetti (HTTP ' + rs.statusCode + ')', down: true }));
  ws.on('error', e => emit(st, { status: 'Bağlantı hatası: ' + e.message }));
  ws.on('close', (code, reason) => {
    emit(st, { status: 'Bağlantı koptu (kod ' + code + (reason && reason.length ? ', ' + reason.toString() : '') + '), 3 sn sonra tekrar denenecek…', down: true });
    if (!st.closed) setTimeout(() => openUpstream(room), 3000);
  });
}
function attach(room, res) {
  let st = streams.get(room);
  if (!st) { st = { clients: new Set(), closed: false }; streams.set(room, st); }
  st.clients.add(res);
  if (!st.ws) openUpstream(room); else emit(st, { status: 'Panel yeniden bağlandı.' });
  const ka = setInterval(() => res.write(': ka\n\n'), 20000);
  res.on('close', () => {
    clearInterval(ka); st.clients.delete(res);
    if (!st.clients.size) { st.closed = true; try { st.ws && st.ws.close(); } catch {} streams.delete(room); }
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  try {
    // başka sitelerden gelen istekleri engelle
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && origin !== BASE && origin !== `http://localhost:${PORT}`) return send(res, 403, { error: 'Yasak' });

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }

    if (url.pathname === '/login') {
      const state = b64u(crypto.randomBytes(16));
      const verifier = b64u(crypto.randomBytes(48));
      pending.set(state, verifier);
      const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
      const q = new URLSearchParams({
        response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPES,
        code_challenge: challenge, code_challenge_method: 'S256', state,
      });
      res.writeHead(302, { Location: 'https://id.kick.com/oauth/authorize?' + q });
      return res.end();
    }

    if (url.pathname === '/callback') {
      const state = url.searchParams.get('state'), code = url.searchParams.get('code');
      const verifier = pending.get(state); pending.delete(state);
      if (!code || !verifier) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Giriş başarısız: ' + (url.searchParams.get('error_description') || 'geçersiz istek') + '\n/ adresine dönüp tekrar dene.'); }
      try {
        saveTokens(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }));
        res.writeHead(302, { Location: '/' }); return res.end();
      } catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Token alınamadı: ' + e.message); }
    }

    if (url.pathname === '/api/stream') {
      const room = url.searchParams.get('room') || '';
      if (!/^\d{1,12}$/.test(room)) { res.writeHead(400); return res.end('room?'); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      return attach(room, res);
    }

    if (url.pathname === '/api/logout') { tokens = null; try { fs.unlinkSync(TOKFILE); } catch {} return send(res, 200, { ok: true }); }

    if (url.pathname === '/api/me') {
      const j = await kick('GET', '/users');
      const u = (j.data && j.data[0]) || {};
      return send(res, 200, { name: u.name || 'Giriş yapıldı', user_id: u.user_id });
    }

    if (url.pathname === '/api/channel') {
      const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();
      if (!slug) return send(res, 400, { error: 'Kanal adı yok' });
      const j = await kick('GET', '/channels?slug=' + encodeURIComponent(slug));
      const c = j.data && j.data[0];
      if (!c) return send(res, 404, { error: 'Kanal bulunamadı' });
      const st = c.stream || {};
      return send(res, 200, {
        broadcaster_user_id: c.broadcaster_user_id, slug: c.slug,
        title: c.stream_title || '', category: (c.category && c.category.name) || '',
        is_live: !!st.is_live, viewers: st.viewer_count || 0, start_time: st.start_time || null, language: st.language || '',
      });
    }

    // Chatroom ID'yi otomatik bulmayı dener (Kick bazen Cloudflare ile engeller)
    if (url.pathname === '/api/chatroom') {
      const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();
      const r = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(slug), { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.chatroom) return send(res, 502, { error: 'Otomatik bulunamadı' });
      return send(res, 200, { chatroom_id: j.chatroom.id });
    }

    if (url.pathname === '/api/ban' && req.method === 'POST') {
      const b = await readBody(req);
      const body = { broadcaster_user_id: num(b.broadcaster_user_id), user_id: num(b.user_id) };
      if (!body.broadcaster_user_id || !body.user_id) return send(res, 400, { error: 'Eksik bilgi' });
      if (b.duration) body.duration = Math.min(10080, Math.max(1, num(b.duration) || 1));
      if (b.reason) body.reason = String(b.reason).slice(0, 100);
      await kick('POST', '/moderation/bans', body);
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/unban' && req.method === 'POST') {
      const b = await readBody(req);
      const body = { broadcaster_user_id: num(b.broadcaster_user_id), user_id: num(b.user_id) };
      if (!body.broadcaster_user_id || !body.user_id) return send(res, 400, { error: 'Eksik bilgi' });
      await kick('DELETE', '/moderation/bans', body);
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/delete' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.message_id) return send(res, 400, { error: 'Mesaj ID yok' });
      await kick('DELETE', '/chat/' + encodeURIComponent(b.message_id));
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const b = await readBody(req);
      const content = String(b.content || '').slice(0, 500);
      if (!num(b.broadcaster_user_id) || !content) return send(res, 400, { error: 'Eksik bilgi' });
      await kick('POST', '/chat', { broadcaster_user_id: num(b.broadcaster_user_id), content, type: 'user' });
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/update/check') {
      if (!cfg.updateUrl) return send(res, 200, { configured: false, current: localVersion() });
      const u = await checkUpdate();
      return send(res, 200, { configured: true, current: u.current, latest: u.latest, newer: u.newer, notes: u.notes || '' });
    }

    if (url.pathname === '/api/update/apply' && req.method === 'POST') {
      const r = await applyUpdate();
      send(res, 200, r);
      if (r.updated) { fs.writeFileSync(path.join(__dirname, '.restart'), '1'); setTimeout(() => process.exit(0), 600); }
      return;
    }

    res.writeHead(404); res.end('Bulunamadı');
  } catch (e) {
    send(res, e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n  Kick Mod Paneli çalışıyor ✔');
  console.log('  Tarayıcıda aç:  ' + BASE);
  console.log('  Kick uygulamasındaki Redirect URL şu olmalı:  ' + REDIRECT + '\n');
});
