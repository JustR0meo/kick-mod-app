// Kick Mod Paneli - yerel sunucu (bağımlılık yok, Node 18+)
let WebSocket;
try { WebSocket = require('ws'); } catch { console.log('\n[HATA] "ws" paketi yok. Önce şunu çalıştır:  npm install\n'); process.exit(1); }
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

let cfg = {};
{
  const CFGFILE = path.join(__dirname, 'config.json');
  let raw = null;
  try { raw = fs.readFileSync(CFGFILE, 'utf8'); } catch {}
  if (raw === null) {
    if (!process.env.KICK_CLIENT_ID) {
      console.log('\n[HATA] config.json dosyası bulunamadı (' + CFGFILE + ').');
      console.log('       config.example.json dosyasını config.json olarak kopyala, içine clientId ve clientSecret yaz.\n');
      process.exit(1);
    }
  } else {
    raw = raw.replace(/^﻿/, ''); // Not Defteri'nin eklediği BOM işaretini at
    try { cfg = JSON.parse(raw); }
    catch (e) {
      // Hata konumunu satır/sütun olarak bul (içeriği yazdırma: gizli anahtar olabilir)
      let line = null, col = null;
      const lc = /line (\d+) column (\d+)/.exec(e.message);
      const pm = /position (\d+)/.exec(e.message);
      if (lc) { line = +lc[1]; col = +lc[2]; }
      else if (pm) { const before = raw.slice(0, +pm[1]).split('\n'); line = before.length; col = before[before.length - 1].length + 1; }
      console.log('\n[HATA] config.json dosyasında yazım (JSON) hatası var' + (line ? ': satır ' + line + ', sütun ' + col : '') + '.');
      console.log('       En sık sebepler:');
      console.log('        - Bir önceki satırın sonunda virgül (,) eksik.');
      console.log('        - Son satırdan sonra fazladan virgül var (son değerden sonra virgül olmaz).');
      console.log('        - Tırnak işareti eksik veya düz tırnak (") yerine akıllı tırnak kullanılmış.');
      console.log('       Doğru örnek:');
      console.log('         {');
      console.log('           "clientId": "...",');
      console.log('           "clientSecret": "...",');
      console.log('           "port": 3000,');
      console.log('           "updateUrl": "https://raw.githubusercontent.com/KULLANICI/kick-mod-app/main/"');
      console.log('         }\n');
      process.exit(1);
    }
  }
}
const CLIENT_ID = process.env.KICK_CLIENT_ID || cfg.clientId;
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || cfg.clientSecret;
const PORT = Number(cfg.port || 3000);
if (!CLIENT_ID || !CLIENT_SECRET || String(CLIENT_ID).includes('BURAYA')) {
  console.log('\n[HATA] config.json içinde clientId veya clientSecret boş ya da hâlâ örnek değerde.');
  console.log('       Kick geliştirici panelinden aldığın clientId ve clientSecret değerlerini yaz.\n');
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
// Kick, Pusher anahtarını artık sabit tutmuyor; anahtar + cluster her bağlantıda Kick'in "realtime" servisinden alınır.
// Sıra: config.json'daki elle ayar (pusherKey/pusherCluster) > son çalışan anahtar (önbellek) > Kick'ten otomatik > eski sabit anahtar.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const LEGACY_PUSHER = { appKey: '32cbd69e4b950bf97679', cluster: 'us2', source: 'eski sabit anahtar' };
const RT_BASES = ['https://web.kick.com/api', 'https://kick.com/api'];
const CLIENT_UUID = crypto.randomUUID();
let pusherCache = null;              // { appKey, cluster, source }
const channelIds = new Map();        // slug -> Kick kanal ID
const emoteCache = new Map();        // slug -> { t, data }

// Kick cevabının içinde { provider:'pusher', credentials:{ app_key, cluster } } nerede olursa bul
function findPusher(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 6) return null;
  if (o.provider === 'pusher' && o.credentials && o.credentials.app_key && o.credentials.cluster)
    return { appKey: String(o.credentials.app_key), cluster: String(o.credentials.cluster) };
  for (const v of Array.isArray(o) ? o : Object.values(o)) { const r = findPusher(v, depth + 1); if (r) return r; }
  return null;
}
async function kickChannelId(slug) {
  if (!slug) return null;
  if (channelIds.has(slug)) return channelIds.get(slug);
  try {
    const r = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(slug), { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const j = await r.json(); if (j && j.id) { channelIds.set(slug, j.id); return j.id; }
  } catch {}
  return null;
}
async function negotiatePusher(info) {
  const body = JSON.stringify({ client: { id: CLIENT_UUID, type: 'web' }, capabilities: { accepted_providers: [{ provider: 'pusher' }] } });
  const ids = [...new Set([await kickChannelId(info.slug), info.bid].filter(Boolean))];
  const paths = [...ids.map(id => `/v1/realtime/channels/${id}/chat/connection`), '/v1/realtime/connection'];
  const tried = [];
  for (const p of paths) for (const b of RT_BASES) {
    try {
      const r = await fetch(b + p, { method: 'POST', headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://kick.com', Referer: 'https://kick.com/' }, body, signal: AbortSignal.timeout(8000) });
      const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
      const found = j && findPusher(j);
      if (found) return { ...found, source: 'Kick otomatik' };
      tried.push(r.status + (j && /centrifugo/.test(txt) ? ' (sadece centrifugo)' : ''));
    } catch (e) { tried.push('hata'); }
  }
  throw new Error('Kick anahtarı vermedi [' + tried.join(', ') + ']');
}
async function getPusher(st, force) {
  if (cfg.pusherKey && cfg.pusherCluster) return { appKey: cfg.pusherKey, cluster: cfg.pusherCluster, source: 'config.json' };
  if (pusherCache && !force) return pusherCache;
  try { pusherCache = await negotiatePusher(st.info); }
  catch (e) { emit(st, { status: 'Otomatik anahtar alınamadı: ' + e.message + '. Eski anahtar deneniyor.' }); pusherCache = null; return LEGACY_PUSHER; }
  console.log('[sohbet] Pusher anahtarı alındı (' + pusherCache.cluster + ')');
  return pusherCache;
}

// ---- Sohbet + olay kaydı: logs/<chatroom>.jsonl (panel kapansa da geçmiş kalır) ----
const LOGDIR = path.join(__dirname, 'logs');
const LOG_EVENTS = /(ChatMessageEvent|MessageDeletedEvent|UserBannedEvent|UserUnbannedEvent|SubscriptionEvent|GiftedSubscriptionsEvent|RewardRedeemedEvent)$/;
const LOG_MAX = 15 * 1024 * 1024; // dosya 15 MB'ı geçince eski yarısı atılır
const logSizes = new Map();
const logFile = room => path.join(LOGDIR, String(room).replace(/\D/g, '') + '.jsonl');
function logEvent(room, m) {
  if (!LOG_EVENTS.test(m.event)) return;
  const f = logFile(room);
  const line = JSON.stringify({ t: Date.now(), e: m.event.replace(/^App\\Events\\/, ''), d: m.data }) + '\n';
  try {
    if (!logSizes.has(f)) { fs.mkdirSync(LOGDIR, { recursive: true }); logSizes.set(f, fs.existsSync(f) ? fs.statSync(f).size : 0); }
    fs.appendFileSync(f, line);
    const sz = logSizes.get(f) + Buffer.byteLength(line);
    if (sz > LOG_MAX) { const txt = fs.readFileSync(f, 'utf8'); const keep = txt.slice(txt.indexOf('\n', txt.length / 2) + 1); fs.writeFileSync(f, keep); logSizes.set(f, Buffer.byteLength(keep)); }
    else logSizes.set(f, sz);
  } catch (e) { console.log('[kayıt] yazılamadı: ' + e.message); }
}
function readLog(room) {
  try { return fs.readFileSync(logFile(room), 'utf8').split('\n').filter(Boolean).map(l => { try { const o = JSON.parse(l); o.d = typeof o.d === 'string' ? JSON.parse(o.d) : o.d; return o; } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
// Kick'in sitede gösterdiği son mesajlar (kayıt yokken de bir miktar geçmiş görünsün)
async function kickRecent(slug) {
  const id = await kickChannelId(slug); if (!id) return [];
  try {
    const r = await fetch(`https://kick.com/api/v2/channels/${id}/messages`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    const j = await r.json(); const ms = (j && j.data && j.data.messages) || [];
    return ms.filter(x => x && x.id && x.sender && (x.type || 'message') === 'message');
  } catch { return []; }
}

const streams = new Map(); // room -> { ws, clients:Set, closed, info, fails, refresh }
function emit(st, obj) { const line = 'data: ' + JSON.stringify(obj) + '\n\n'; for (const c of st.clients) c.write(line); }
async function openUpstream(room) {
  const st = streams.get(room); if (!st || st.closed) return;
  st.ws = 'bekliyor';
  const pc = await getPusher(st, st.refresh); st.refresh = false;
  if (st.closed) return;
  const ws = new WebSocket(`wss://ws-${pc.cluster}.pusher.com/app/${pc.appKey}?protocol=7&client=js&version=8.4.0&flash=false`);
  st.ws = ws;
  ws.on('open', () => emit(st, { status: 'Kick sohbet sunucusuna bağlanıldı (' + pc.source + '), kanala abone olunuyor…' }));
  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.event === 'pusher:connection_established') ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: 'chatrooms.' + room + '.v2' } }));
    else if (m.event === 'pusher:ping') ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
    else if (m.event === 'pusher_internal:subscription_succeeded') { st.fails = 0; emit(st, { ready: true, status: 'Sohbet akışı hazır ✔' }); }
    else if (m.event === 'pusher:error') {
      const d = typeof m.data === 'string' ? (() => { try { return JSON.parse(m.data); } catch { return { message: m.data }; } })() : (m.data || {});
      // 4001 = anahtar/cluster geçersiz, 4003 = uygulama kapalı → bir sonraki denemede anahtarı Kick'ten yeniden al
      if (d.code >= 4000 && d.code < 4100) { st.refresh = true; if (pc.source !== 'config.json') pusherCache = null; }
      emit(st, { status: 'Kick hata verdi: ' + (d.message || JSON.stringify(d)) });
    }
    else if (m.event && !m.event.startsWith('pusher')) { emit(st, { pusher: m }); logEvent(room, m); }
  });
  ws.on('unexpected-response', (rq, rs) => emit(st, { status: 'Kick bağlantıyı reddetti (HTTP ' + rs.statusCode + ')', down: true }));
  ws.on('error', e => emit(st, { status: 'Bağlantı hatası: ' + e.message }));
  ws.on('close', code => {
    if (st.closed) return;
    st.fails = (st.fails || 0) + 1;
    const wait = Math.min(60, 3 * 2 ** Math.min(st.fails - 1, 5)); // 3, 6, 12, 24, 48, 60 sn
    emit(st, { status: 'Bağlantı koptu (kod ' + code + '), ' + wait + ' sn sonra tekrar denenecek…', down: true });
    setTimeout(() => openUpstream(room), wait * 1000);
  });
}
function attach(room, res, info) {
  let st = streams.get(room);
  if (!st) { st = { clients: new Set(), closed: false, info, fails: 0 }; streams.set(room, st); }
  if (info.slug) st.info = info;
  st.clients.add(res);
  if (!st.ws) openUpstream(room).catch(e => emit(st, { status: 'Sohbet hatası: ' + e.message })); else emit(st, { status: 'Panel yeniden bağlandı.' });
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
      const slug = (url.searchParams.get('slug') || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      return attach(room, res, { slug, bid: num(url.searchParams.get('bid')) });
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
      if (j.id) channelIds.set(slug, j.id);
      return send(res, 200, { chatroom_id: j.chatroom.id });
    }

    // Geçmiş: kayıttaki son sohbet mesajları + Kick'in son mesajları + kayıttaki moderasyon olayları
    if (url.pathname === '/api/history') {
      const room = url.searchParams.get('room') || '';
      if (!/^\d{1,12}$/.test(room)) return send(res, 400, { error: 'room?' });
      const slug = (url.searchParams.get('slug') || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      const limit = Math.min(1000, Math.max(50, Number(url.searchParams.get('limit')) || 300));
      const log = readLog(room);
      const chat = new Map();
      for (const x of await kickRecent(slug)) chat.set(String(x.id), x);
      for (const o of log) if (o.e === 'ChatMessageEvent' && o.d && o.d.id) chat.set(String(o.d.id), o.d);
      const msgs = [...chat.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).slice(-limit);
      const events = log.filter(o => o.e !== 'ChatMessageEvent').slice(-3000);
      // silinen mesajların içeriği için: silinme olayındaki mesaj ID'lerine ait metinler
      const want = new Set(events.filter(o => o.e === 'MessageDeletedEvent').map(o => String((o.d.message && o.d.message.id) || o.d.id)));
      const texts = {};
      for (const o of log) if (o.e === 'ChatMessageEvent' && o.d && want.has(String(o.d.id))) texts[o.d.id] = { u: o.d.sender && o.d.sender.username, c: o.d.content };
      return send(res, 200, { msgs, events, texts, logged: log.length });
    }

    // Emote listesi (kanal + Kick genel + emoji setleri); 10 dk önbellek
    if (url.pathname === '/api/emotes') {
      const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,40}$/.test(slug)) return send(res, 400, { error: 'Kanal adı yok' });
      const c = emoteCache.get(slug);
      if (c && Date.now() - c.t < 600000) return send(res, 200, c.data);
      const r = await fetch('https://kick.com/emotes/' + slug, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !Array.isArray(j)) return send(res, 502, { error: 'Kick emote listesi vermedi' });
      const sets = j.map(s => ({
        title: s.user_id ? (s.slug || slug) : (s.name || s.id || 'Kick'),
        channel: !!s.user_id,
        emotes: (s.emotes || []).filter(e => e && e.id && e.name).map(e => ({ id: e.id, name: e.name, sub: !!e.subscribers_only })),
      })).filter(s => s.emotes.length);
      const data = { sets };
      emoteCache.set(slug, { t: Date.now(), data });
      return send(res, 200, data);
    }

    // Kullanıcı kartı için: takip tarihi, abonelik ayı, ban durumu (Kick'in site API'si, en iyi çaba)
    if (url.pathname === '/api/userinfo') {
      const slug = (url.searchParams.get('slug') || '').trim().toLowerCase(), u = (url.searchParams.get('u') || '').trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,40}$/.test(slug) || !/^[a-z0-9_.-]{1,40}$/.test(u)) return send(res, 400, { error: 'Eksik bilgi' });
      const r = await fetch(`https://kick.com/api/v2/channels/${slug}/users/${u}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) return send(res, 502, { error: 'Kick bilgi vermedi' });
      return send(res, 200, { following_since: j.following_since || null, subscribed_for: j.subscribed_for || 0, banned: j.banned || null, created_at: (j.user && j.user.created_at) || j.created_at || null });
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
