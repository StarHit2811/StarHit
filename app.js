'use strict';
/* StarHit – Songs hören und auf dem eigenen Zeitstrahl einordnen.
   Reine Browser-App: Spotify-Login per PKCE, kein eigener Server nötig. */

const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');
const REDIRECT_URI = (location.origin + location.pathname).replace(/index\.html$/, '');
const MAX_TOKENS = 5;

/* ---------- Speicher (localStorage kann fehlen → try/catch) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const S = {
  view: 'home',
  clientId: store.get('zk_client_id', '') || (window.STARHIT_CONFIG && window.STARHIT_CONFIG.clientId) || '',
  auth: store.get('zk_auth', null),
  me: store.get('zk_me', null),
  playlist: store.get('zk_playlist', null),
  overrides: store.get('zk_overrides', {}),
  excluded: store.get('zk_excluded', {}),
  settings: Object.assign({ target: 10, randomStart: true, startTokens: 2, deviceId: null }, store.get('zk_settings', {})),
  players: store.get('zk_players', ['', '']),
  game: store.get('zk_game', null),
  myPlaylists: null,
  devices: null,
  busy: null,
  msg: null,
  songFilter: '',
  onlyWarn: false,
  paused: false,
  hint: false,
};

function save() {
  store.set('zk_auth', S.auth);
  store.set('zk_me', S.me);
  store.set('zk_playlist', S.playlist);
  store.set('zk_overrides', S.overrides);
  store.set('zk_excluded', S.excluded);
  store.set('zk_settings', S.settings);
  store.set('zk_players', S.players);
  store.set('zk_game', S.game);
}

/* ---------- Helfer ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const randStr = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join(''); };
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const yearOf = t => (S.overrides[t.id] != null ? S.overrides[t.id] : t.year);

function say(text, kind = '') { S.msg = { text, kind }; }
function sayHtml(html, kind = '') { S.msg = { html, kind }; }

function cleanTitle(t) {
  return t
    .replace(/\s+[-–]\s+(\d{4}\s+)?(digital(ly)?\s+)?remaster(ed)?(\s+\d{4})?(\s+version)?$/i, '')
    .replace(/\s+[-–]\s+(single|radio|album)\s+(version|edit)$/i, '')
    .replace(/\s+[-–]\s+(mono|stereo)(\s+version)?$/i, '')
    .replace(/\s*\((\d{4}\s+)?remaster(ed)?(\s+\d{4})?(\s+version)?\)/i, '')
    .trim();
}
const SUSPICIOUS = /remaster|live|version|deluxe|anniversary|best of|greatest|hits|collection|essential|anthology|compilation|edition/i;

function mapTrack(t) {
  const imgs = (t.album && t.album.images) || [];
  const albumName = (t.album && t.album.name) || '';
  return {
    id: t.id,
    uri: t.uri,
    title: cleanTitle(t.name || ''),
    artist: (t.artists || []).map(a => a.name).join(', '),
    year: parseInt((t.album && t.album.release_date) || '', 10) || null,
    cover: (imgs[1] || imgs[0] || {}).url || '',
    dur: t.duration_ms || 180000,
    sus: (t.album && t.album.album_type === 'compilation') || SUSPICIOUS.test(albumName) || SUSPICIOUS.test(t.name || ''),
  };
}

function playableTracks() {
  if (!S.playlist) return [];
  return S.playlist.tracks.filter(t => !S.excluded[t.id] && yearOf(t));
}

/* ---------- Spotify-Login (Authorization Code + PKCE) ---------- */
async function login() {
  if (!S.clientId) { S.view = 'settings'; say('Bitte zuerst die Client-ID eintragen.', 'err'); return render(); }
  const verifier = randStr(64);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randStr(16);
  store.set('zk_pkce', { verifier, state });
  location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: S.clientId, response_type: 'code', redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state,
  });
}

async function tokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error_description || d.error || ('Token-Fehler ' + r.status));
  S.auth = {
    access_token: d.access_token,
    refresh_token: d.refresh_token || (S.auth && S.auth.refresh_token),
    expires_at: Date.now() + ((d.expires_in || 3600) - 60) * 1000,
  };
  save();
}

async function handleRedirect() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return;
  history.replaceState(null, '', REDIRECT_URI);
  const pk = store.get('zk_pkce', null);
  store.del('zk_pkce');
  if (p.has('error')) { say('Spotify-Login abgebrochen: ' + p.get('error'), 'err'); return; }
  if (!pk || pk.state !== p.get('state')) { say('Login-Status passt nicht – bitte nochmal anmelden.', 'err'); return; }
  try {
    await tokenRequest({ grant_type: 'authorization_code', code: p.get('code'), redirect_uri: REDIRECT_URI, client_id: S.clientId, code_verifier: pk.verifier });
    S.me = await api('/me');
    save();
    say('Mit Spotify verbunden als ' + (S.me.display_name || S.me.id) + '.', 'ok');
  } catch (e) {
    say('Login fehlgeschlagen: ' + e.message + (/(user|developer)/i.test(e.message) ? '' : ' – Ist dein Spotify-Konto im Developer-Dashboard unter „User Management“ eingetragen?'), 'err');
    S.auth = null; save();
  }
}

function logout() {
  S.auth = null; S.me = null; S.myPlaylists = null; S.devices = null;
  save(); say('Abgemeldet.'); render();
}

async function ensureToken() {
  if (!S.auth) { const e = new Error('Nicht mit Spotify verbunden.'); e.status = 401; throw e; }
  if (Date.now() > S.auth.expires_at) {
    try {
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: S.auth.refresh_token, client_id: S.clientId });
    } catch (e) {
      S.auth = null; save();
      throw new Error('Spotify-Sitzung abgelaufen – bitte neu verbinden.');
    }
  }
  return S.auth.access_token;
}

async function api(path, opts = {}, retry = true) {
  const tok = await ensureToken();
  const url = path.startsWith('http') ? path : API + path;
  const headers = { Authorization: 'Bearer ' + tok };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 401 && retry) { S.auth.expires_at = 0; return api(path, opts, false); }
  if (r.status === 429) { const e = new Error('Spotify bremst gerade (zu viele Anfragen). Kurz warten.'); e.status = 429; throw e; }
  const txt = await r.text();
  let d = null; try { d = txt ? JSON.parse(txt) : null; } catch {}
  if (!r.ok) {
    const e = new Error((d && d.error && d.error.message) || ('HTTP ' + r.status));
    e.status = r.status; e.reason = d && d.error && d.error.reason;
    throw e;
  }
  return d;
}

/* ---------- Playlists ---------- */
function parsePlaylistId(s) {
  s = (s || '').trim();
  const m = s.match(/playlist[/:]([A-Za-z0-9]{22})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{22}$/.test(s)) return s;
  return null;
}

async function loadMyPlaylists() {
  const out = [];
  let url = '/me/playlists?limit=50';
  while (url && out.length < 300) {
    const d = await api(url);
    out.push(...d.items.filter(Boolean));
    url = d.next;
  }
  const meId = S.me && S.me.id;
  S.myPlaylists = out.map(p => ({
    id: p.id, name: p.name,
    img: (p.images && p.images.length ? p.images[p.images.length - 1].url : ''),
    count: (p.items && p.items.total) ?? (p.tracks && p.tracks.total) ?? '',
    usable: (p.owner && p.owner.id === meId) || p.collaborative,
  }));
}

async function fetchPlaylistItems(id) {
  const tracks = [];
  // Seit 2026 heißt der Endpunkt /items (früher /tracks) – beide probieren.
  let url = `/playlists/${id}/items?limit=50&additional_types=track`;
  try { await api(url); } catch (e) {
    if (e.status === 404 || e.status === 410) url = `/playlists/${id}/tracks?limit=50`; else throw e;
  }
  while (url) {
    const d = await api(url);
    for (const it of d.items || []) {
      const t = it.item || it.track;
      if (!t || t.type !== 'track' || t.is_local || !t.id) continue;
      tracks.push(mapTrack(t));
    }
    url = d.next;
  }
  return tracks;
}

async function loadPlaylist(id) {
  let name = 'Playlist';
  try { const meta = await api(`/playlists/${id}?fields=name`); name = meta.name || name; } catch {}
  let tracks;
  try {
    tracks = await fetchPlaylistItems(id);
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      throw new Error('Diese Playlist kann nicht gelesen werden. Spotify erlaubt Apps nur noch eigene oder kollaborative Playlists. Tipp: In Spotify alle Songs markieren → „Zu Playlist hinzufügen“ → eigene neue Playlist.');
    }
    throw e;
  }
  if (!tracks.length) throw new Error('Keine abspielbaren Songs in dieser Playlist gefunden.');
  // Doppelte Songs entfernen
  const seen = new Set();
  tracks = tracks.filter(t => (seen.has(t.id) ? false : seen.add(t.id)));
  S.playlist = { id, name, tracks, demo: false, loadedAt: Date.now() };
  save();
  const sus = tracks.filter(t => t.sus && S.overrides[t.id] == null).length;
  say(`„${name}“ geladen: ${tracks.length} Songs.` + (sus ? ` ${sus} Jahreszahlen solltest du prüfen (⚠ unter „Songs“).` : ''), 'ok');
}

function loadDemo() {
  const D = [
    ['Elvis Presley', 'Jailhouse Rock', 1957], ['Chuck Berry', 'Johnny B. Goode', 1958],
    ['The Rolling Stones', "(I Can't Get No) Satisfaction", 1965], ['The Beatles', 'Hey Jude', 1968],
    ['Queen', 'Bohemian Rhapsody', 1975], ['ABBA', 'Dancing Queen', 1976], ['Bee Gees', "Stayin' Alive", 1977],
    ['Michael Jackson', 'Billie Jean', 1982], ['Survivor', 'Eye of the Tiger', 1982], ['Nena', '99 Luftballons', 1983],
    ['a-ha', 'Take On Me', 1985], ['Bon Jovi', "Livin' on a Prayer", 1986],
    ['Whitney Houston', 'I Wanna Dance with Somebody', 1987], ['Nirvana', 'Smells Like Teen Spirit', 1991],
    ['Oasis', 'Wonderwall', 1995], ['Spice Girls', 'Wannabe', 1996], ['Britney Spears', '...Baby One More Time', 1998],
    ['Eminem', 'Lose Yourself', 2002], ['Beyoncé', 'Crazy in Love', 2003], ['Shakira', "Hips Don't Lie", 2006],
    ['Rihanna', 'Umbrella', 2007], ['Lady Gaga', 'Poker Face', 2008], ['Adele', 'Rolling in the Deep', 2010],
    ['Pharrell Williams', 'Happy', 2013], ['Ed Sheeran', 'Shape of You', 2017], ['Billie Eilish', 'bad guy', 2019],
    ['The Weeknd', 'Blinding Lights', 2019], ['Harry Styles', 'As It Was', 2022], ['Miley Cyrus', 'Flowers', 2023],
  ];
  S.playlist = {
    id: 'demo', name: 'Demo-Songs (ohne Ton)', demo: true, loadedAt: Date.now(),
    tracks: D.map(([artist, title, year], i) => ({ id: 'demo' + i, uri: '', title, artist, year, cover: '', dur: 0, sus: false })),
  };
  save();
  say('Demo geladen. Ohne Spotify gibt es keinen Ton – der Titel wird stattdessen vorgelesen.', 'ok');
}

/* ---------- Wiedergabe (steuert die Spotify-App per Spotify Connect) ---------- */
async function loadDevices() {
  const d = await api('/me/player/devices');
  S.devices = (d && d.devices) || [];
  return S.devices;
}

function deviceHelp() {
  return 'Spotify ist auf dem Handy eingeschlafen. Tippe auf „Spotify öffnen“, spiele dort kurz irgendeinen Song an, komm hierher zurück und tippe nochmal auf „▶ Song abspielen“.' +
    '<div class="row" style="margin-top:10px"><a class="btn sm" href="spotify:">Spotify öffnen</a></div>';
}

function noDevice() { const e = new Error('NO_DEVICE'); e.code = 'NO_DEVICE'; return e; }

async function playTrack(t, keepPosition) {
  let devices = [];
  try { devices = await loadDevices(); } catch (e) { if (e.status !== 404) throw e; }
  const dev = devices.find(d => d.id === S.settings.deviceId) || devices.find(d => d.is_active) || devices[0];
  // Taucht das Gerät nicht in der Liste auf, trotzdem das zuletzt benutzte versuchen –
  // Spotify nimmt Befehle für kurz inaktive Geräte oft noch an.
  const devId = dev ? dev.id : S.settings.deviceId;
  if (!devId) throw noDevice();
  let pos = 0;
  if (S.settings.randomStart && t.dur > 90000) {
    // Irgendwo zwischen 0:30 und spätestens 45 s vor Schluss einsteigen
    const max = Math.min(t.dur - 45000, 120000);
    pos = 30000 + Math.floor(Math.random() * Math.max(0, max - 30000));
  }
  if (keepPosition != null) pos = keepPosition;
  t.startAt = pos;
  try {
    await api(`/me/player/play?device_id=${encodeURIComponent(devId)}`, {
      method: 'PUT', body: JSON.stringify({ uris: [t.uri], position_ms: pos }),
    });
  } catch (e) {
    if (!dev && (e.status === 404 || e.status === 403)) throw noDevice();
    throw e;
  }
  S.settings.deviceId = devId; save();
  S.paused = false;
  // Song in Dauerschleife: Spotify spielt so nie von selbst etwas anderes
  // und bleibt im Hintergrund wach, bis der nächste Song gestartet wird.
  try { await api(`/me/player/repeat?state=track&device_id=${encodeURIComponent(devId)}`, { method: 'PUT' }); } catch {}
}

async function pausePlayback() {
  try { await api('/me/player/pause', { method: 'PUT' }); } catch {}
  S.paused = true;
}

function playError(e) {
  if (e.code === 'NO_DEVICE' || e.status === 404) return sayHtml(deviceHelp(), 'err');
  if (e.status === 403 && /premium/i.test((e.reason || '') + ' ' + e.message)) {
    return say('Spotify verweigert die Wiedergabe: Dafür braucht das angemeldete Konto Spotify Premium.', 'err');
  }
  if (e.status === 403) return sayHtml(deviceHelp(), 'err');
  say('Abspielen fehlgeschlagen: ' + e.message, 'err');
}

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
}

/* ---------- Spiel ---------- */
function newGame() {
  const names = S.players.map(s => s.trim()).filter(Boolean);
  if (!names.length) { say('Trag mindestens einen Namen ein.', 'err'); return render(); }
  const pool = playableTracks().map(t => ({ id: t.id, uri: t.uri, title: t.title, artist: t.artist, cover: t.cover, dur: t.dur, year: yearOf(t) }));
  if (pool.length < names.length + 5) { say(`Zu wenige Songs (${pool.length}). Nimm eine größere Playlist.`, 'err'); return render(); }
  shuffle(pool);
  S.game = {
    demo: !!S.playlist.demo,
    target: S.settings.target,
    players: names.map(name => ({ name, cards: [pool.pop()], tokens: S.settings.startTokens })),
    deck: pool, turn: 0, current: null, phase: 'ready', slot: null, correct: null, bonus: false, winners: null, round: 1,
  };
  S.view = 'game'; S.msg = null; S.hint = false; S.paused = false;
  save(); keepAwake(); render();
}

const cur = () => S.game.players[S.game.turn];
const sorted = cards => cards.slice().sort((a, b) => a.year - b.year);

function finishByDeck() {
  const g = S.game;
  const max = Math.max(...g.players.map(p => p.cards.length));
  g.winners = g.players.filter(p => p.cards.length === max).map(p => p.name);
  g.phase = 'over'; g.reason = 'deck';
}

async function drawAndPlay() {
  const g = S.game;
  if (!g.current) {
    if (!g.deck.length) { finishByDeck(); save(); return render(); }
    g.current = g.deck.pop();
    save();
  }
  S.hint = false; S.msg = null;
  if (g.demo) { g.phase = 'listening'; g.slot = null; save(); return render(); }
  // Erst in die Rate-Ansicht wechseln, wenn der Song wirklich läuft –
  // sonst bleibt der „Song abspielen“-Knopf für einen neuen Versuch stehen.
  await busy('Song startet …', async () => {
    try { await playTrack(g.current); g.phase = 'listening'; g.slot = null; save(); }
    catch (e) { playError(e); }
  });
}

async function replay() {
  const g = S.game;
  if (g.demo) return;
  await busy('', () => playTrack(g.current, g.current.startAt ?? 0).catch(playError));
}

async function togglePause() {
  const g = S.game;
  if (g.demo) return;
  if (S.paused) {
    await busy('', async () => {
      try { await api('/me/player/play', { method: 'PUT' }); S.paused = false; }
      catch { await playTrack(g.current, g.current.startAt ?? 0).catch(playError); }
    });
  } else {
    await busy('', pausePlayback);
  }
}

async function skipWithToken() {
  const g = S.game, p = cur();
  if (p.tokens < 1) return;
  if (!g.deck.length) { say('Keine Songs mehr im Stapel.', 'err'); return render(); }
  p.tokens -= 1;
  g.current = g.deck.pop();
  say(`${p.name} setzt einen Token ein – neuer Song!`);
  g.phase = 'listening'; g.slot = null; S.hint = false;
  save(); render();
  if (!g.demo) await busy('Song startet …', () => playTrack(g.current).catch(playError));
}

function reveal() {
  const g = S.game, p = cur();
  if (g.slot == null) return;
  const cards = sorted(p.cards);
  const y = g.current.year, i = g.slot;
  const leftOk = i === 0 || cards[i - 1].year <= y;
  const rightOk = i === cards.length || y <= cards[i].year;
  g.correct = leftOk && rightOk;
  if (g.correct) p.cards.push(g.current);
  g.phase = 'revealed'; g.bonus = false; S.msg = null;
  save(); render();
  // Bewusst NICHT pausieren: Ein pausiertes Spotify schläft im Hintergrund ein
  // und ist dann für den nächsten Song nicht mehr erreichbar.
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function nextTurn() {
  const g = S.game, p = cur();
  if (g.bonus) p.tokens = Math.min(MAX_TOKENS, p.tokens + 1);
  if (p.cards.length >= g.target) {
    g.winners = [p.name]; g.phase = 'over'; g.reason = 'target';
    save(); return render();
  }
  g.turn = (g.turn + 1) % g.players.length;
  if (g.turn === 0) g.round += 1;
  g.current = null; g.phase = 'ready'; g.slot = null; g.correct = null; g.bonus = false; S.hint = false; S.paused = false; S.msg = null;
  save(); render();
  window.scrollTo({ top: 0 });
}

/* ---------- Ansichten ---------- */
function header() {
  const tab = (v, label) => `<button data-action="nav" data-view="${v}" class="${S.view === v ? 'on' : ''}">${label}</button>`;
  return `<header class="top">
    <div class="logo"><img src="icon.svg" alt="">StarHit</div>
    <nav class="tabs">
      ${S.game && S.game.phase !== 'over' ? tab('game', 'Spiel') : ''}
      ${tab('home', 'Start')}${tab('songs', 'Songs')}${tab('settings', '⚙︎')}${tab('help', '?')}
    </nav>
  </header>`;
}

function viewHome() {
  let h = '';
  // 1 · Spotify
  h += `<div class="card"><h2>1 · Spotify</h2>`;
  if (!S.clientId) {
    h += `<p>Noch keine Spotify-Client-ID hinterlegt.</p><button class="btn primary" data-action="nav" data-view="settings">Einrichten</button>
          <p class="small" style="margin-top:10px">Nur ausprobieren? Unten bei „Playlist“ gibt es Demo-Songs ohne Spotify.</p>`;
  } else if (!S.auth) {
    h += `<p>Melde dich an, damit die App deine Playlists lesen und Songs abspielen kann (Spotify Premium nötig).</p>
          <button class="btn primary block" data-action="login">Mit Spotify verbinden</button>`;
  } else {
    h += `<div class="row"><div class="grow">Verbunden als <b>${esc(S.me ? (S.me.display_name || S.me.id) : '…')}</b></div>
          <button class="btn sm ghost" data-action="logout">Abmelden</button></div>`;
  }
  h += `</div>`;

  // 2 · Playlist
  h += `<div class="card"><h2>2 · Playlist</h2>`;
  if (S.playlist) {
    const n = playableTracks().length;
    h += `<div class="row" style="margin-bottom:10px"><div class="grow"><b>${esc(S.playlist.name)}</b><div class="small">${n} spielbare Songs</div></div>
          <button class="btn sm" data-action="nav" data-view="songs">Songs</button>
          ${S.playlist.demo ? '' : '<button class="btn sm" data-action="reloadPlaylist" title="Neu laden">↻</button>'}</div>`;
  }
  if (S.auth) {
    h += `<div class="row"><input type="text" id="plLink" placeholder="Playlist-Link einfügen" autocomplete="off">
          <button class="btn" data-action="loadLink">Laden</button></div>
          <button class="btn block" style="margin-top:8px" data-action="myPlaylists">Aus meinen Playlists wählen</button>`;
    if (S.myPlaylists) {
      const usable = S.myPlaylists.filter(p => p.usable);
      h += `<div class="pl-list">` + (usable.length ? usable.map(p => `
        <button class="pl-item" data-action="pickPlaylist" data-id="${esc(p.id)}">
          ${p.img ? `<img src="${esc(p.img)}" alt="">` : '<span class="thumb"></span>'}
          <span class="grow">${esc(p.name)}<br><span class="small">${esc(p.count)} Songs</span></span>
        </button>`).join('') : '<p class="small" style="padding-top:8px">Keine eigenen Playlists gefunden.</p>') + `</div>`;
      const hidden = S.myPlaylists.length - usable.length;
      if (hidden) h += `<p class="small" style="margin-top:8px">${hidden} gefolgte Playlists ausgeblendet – Spotify gibt Apps nur Zugriff auf eigene oder kollaborative Playlists.</p>`;
    }
  }
  h += `<button class="btn ghost sm" style="margin-top:8px" data-action="demo">Demo-Songs (ohne Spotify) laden</button></div>`;

  // 3 · Mitspieler
  h += `<div class="card"><h2>3 · Mitspieler</h2><div class="stack">`;
  S.players.forEach((n, i) => {
    h += `<div class="row"><input type="text" data-bind="player" data-i="${i}" value="${esc(n)}" placeholder="Name ${i + 1}" autocomplete="off" maxlength="20">
          ${S.players.length > 1 ? `<button class="btn ghost sm" data-action="delPlayer" data-i="${i}" aria-label="Entfernen">✕</button>` : ''}</div>`;
  });
  h += `</div>${S.players.length < 10 ? '<button class="btn ghost sm" style="margin-top:8px" data-action="addPlayer">+ Mitspieler</button>' : ''}
        <div class="row" style="margin-top:12px"><span class="grow">Karten zum Sieg</span>
        <select data-bind="target" style="width:96px">${[5, 6, 7, 8, 10, 12, 15].map(v => `<option ${v === S.settings.target ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        </div>`;

  const canStart = S.playlist && playableTracks().length >= 6;
  h += `<div class="stack">`;
  if (S.game && S.game.phase !== 'over') h += `<button class="btn block big" data-action="nav" data-view="game">Spiel fortsetzen</button>`;
  h += `<button class="btn primary block big" data-action="newGame" ${canStart ? '' : 'disabled'}>Neues Spiel starten</button></div>`;
  return h;
}

function cardHtml(c, cls = '') {
  return `<div class="tcard ${cls}"><div class="yr">${esc(c.year)}</div><div class="grow"><div class="ti">${esc(c.title)}</div><div class="ar">${esc(c.artist)}</div></div></div>`;
}

function viewGame() {
  const g = S.game;
  if (!g) { S.view = 'home'; return viewHome(); }
  const p = cur();
  let h = `<div class="score">` + g.players.map((pl, i) =>
    `<span class="chip ${i === g.turn && g.phase !== 'over' ? 'on' : ''}">${esc(pl.name)} <b>${pl.cards.length}</b>/${g.target} · 🪙${pl.tokens}</span>`).join('') + `</div>`;

  if (g.phase === 'over') {
    h += `<div class="mystery revealed"><div class="q">🏆</div>
      <div class="verdict good">${g.winners.map(esc).join(' & ')} ${g.winners.length > 1 ? 'gewinnen' : 'gewinnt'}!</div>
      <p class="small">${g.reason === 'deck' ? 'Der Stapel ist leer – die meisten Karten zählen.' : `${g.target} Karten richtig eingeordnet.`}</p></div>
      <div class="stack"><button class="btn primary block big" data-action="newGame">Nochmal mit denselben Leuten</button>
      <button class="btn block" data-action="nav" data-view="home">Zum Start</button></div>`;
    return h;
  }

  h += `<div class="turn"><div class="small">Runde ${g.round} · ${g.deck.length} Songs im Stapel</div><div class="who">${esc(p.name)}</div></div>`;
  const cards = sorted(p.cards);

  if (g.phase === 'ready') {
    h += `<div class="mystery"><div class="q">🎧</div><p style="margin-top:10px">${esc(p.name)} ist dran. Handy so hinlegen, dass niemand das Display sieht – dann abspielen.</p></div>`;
    h += `<h2>Dein Zeitstrahl</h2><div class="timeline">${cards.map(c => cardHtml(c)).join('<div class="gap"></div>')}</div>`;
    h += `<div class="bar"><div class="inner"><button class="btn primary big" data-action="play">${g.demo ? '🃏 Song ziehen' : '▶ Song abspielen'}</button></div></div>`;
    return h;
  }

  if (g.phase === 'listening') {
    h += `<div class="mystery"><div class="q">❓</div>`;
    if (g.demo) {
      h += S.hint
        ? `<p style="margin-top:10px"><b>${esc(g.current.title)}</b><br><span class="small">${esc(g.current.artist)}</span></p>`
        : `<p class="small" style="margin-top:10px">Demo ohne Ton: Jemand anderes tippt hier und liest Titel &amp; Interpret vor.</p><button class="btn sm" data-action="hint">Titel anzeigen</button>`;
    } else {
      h += `<div class="row" style="justify-content:center;margin-top:12px">
        <button class="btn sm" data-action="pause">${S.paused ? '▶ Fortsetzen' : '⏸ Pause'}</button>
        <button class="btn sm" data-action="replay">↺ Nochmal</button></div>`;
    }
    h += `<div class="row" style="justify-content:center;margin-top:10px">
      <button class="btn sm ghost" data-action="skip" ${p.tokens > 0 ? '' : 'disabled'}>🪙 Token: Song überspringen</button></div></div>`;
    h += `<h2>Wo gehört der Song hin?</h2><div class="timeline">`;
    for (let i = 0; i <= cards.length; i++) {
      const label = i === 0 ? (cards.length ? `vor ${cards[0].year}` : 'hier')
        : i === cards.length ? `nach ${cards[i - 1].year}` : `zwischen ${cards[i - 1].year} und ${cards[i].year}`;
      h += `<button class="slot ${g.slot === i ? 'sel' : ''}" data-action="slot" data-i="${i}">${g.slot === i ? '★ hier einordnen' : label}</button>`;
      if (i < cards.length) h += cardHtml(cards[i]);
    }
    h += `</div><div class="bar"><div class="inner"><button class="btn primary big" data-action="reveal" ${g.slot == null ? 'disabled' : ''}>Aufdecken</button></div></div>`;
    return h;
  }

  // revealed
  const c = g.current;
  h += `<div class="mystery revealed">
    <div class="verdict ${g.correct ? 'good' : 'bad'}">${g.correct ? '✓ Richtig eingeordnet!' : '✗ Leider falsch'}</div>
    ${c.cover ? `<img src="${esc(c.cover)}" alt="">` : ''}
    <div class="bigyr">${esc(c.year)}</div>
    <div style="font-weight:700;font-size:18px">${esc(c.title)}</div><div class="small">${esc(c.artist)}</div>
    <label class="check" style="justify-content:center;margin-top:14px">
      <input type="checkbox" data-bind="bonus" ${g.bonus ? 'checked' : ''} ${p.tokens >= MAX_TOKENS ? 'disabled' : ''}>
      <span>Titel &amp; Interpret gewusst → +1 🪙</span></label>
    ${g.demo ? '' : `<div class="row" style="justify-content:center;margin-top:12px">
      <button class="btn sm ghost" data-action="pause">${S.paused ? '▶ Fortsetzen' : '⏸ Pause'}</button></div>
      <p class="small" style="margin-top:6px">Der Song läuft in Schleife weiter, damit Spotify wach bleibt – der nächste Song ersetzt ihn.</p>`}
  </div>`;
  h += `<h2>Zeitstrahl von ${esc(p.name)}</h2><div class="timeline">`;
  const shown = g.correct ? sorted(p.cards) : sorted(p.cards.concat([Object.assign({}, c, { _wrong: true })]));
  h += shown.map(x => cardHtml(x, x.id === c.id ? (g.correct ? 'new' : 'wrong') : '')).join('<div class="gap"></div>');
  h += `</div>`;
  if (!g.correct) h += `<p class="small" style="margin-top:8px">Die rot markierte Karte zeigt, wo der Song hingehört hätte. Sie fliegt raus.</p>`;
  const willWin = p.cards.length >= g.target;
  h += `<div class="bar"><div class="inner"><button class="btn primary big" data-action="next">${willWin ? '🏆 Sieg!' : 'Weiter →'}</button></div></div>`;
  return h;
}

function viewSongs() {
  if (!S.playlist) return `<div class="card"><p>Noch keine Playlist geladen.</p><button class="btn" data-action="nav" data-view="home">Zur Auswahl</button></div>`;
  const total = S.playlist.tracks.length, n = playableTracks().length;
  const warn = S.playlist.tracks.filter(t => t.sus && S.overrides[t.id] == null).length;
  return `<div class="card"><h3>${esc(S.playlist.name)}</h3>
    <p class="small">${n} von ${total} Songs im Spiel. Spotify liefert das Jahr des <i>Albums</i> – bei Best-ofs und Remasters ist das oft zu spät. Tipp auf die Jahreszahl, um sie zu korrigieren; mit dem Häkchen nimmst du Songs raus. Songs hinzufügen oder löschen geht direkt in der Spotify-App, danach hier auf ↻ tippen.</p>
    <div class="row wrap">
      <input type="search" data-bind="filter" placeholder="Suchen …" value="${esc(S.songFilter)}" class="grow" style="flex:1 1 180px">
      <label class="check small"><input type="checkbox" data-bind="onlyWarn" ${S.onlyWarn ? 'checked' : ''}> nur ⚠ (${warn})</label>
    </div></div>
    <div id="songlist">${songListHtml()}</div>`;
}

function songListHtml() {
  const q = S.songFilter.trim().toLowerCase();
  let list = S.playlist.tracks;
  if (q) list = list.filter(t => (t.title + ' ' + t.artist).toLowerCase().includes(q));
  if (S.onlyWarn) list = list.filter(t => t.sus && S.overrides[t.id] == null);
  if (!list.length) return '<p class="small">Keine Treffer.</p>';
  return list.map(t => {
    const ov = S.overrides[t.id] != null;
    return `<div class="song ${S.excluded[t.id] ? 'off' : ''}">
      <input type="checkbox" data-bind="include" data-id="${esc(t.id)}" ${S.excluded[t.id] ? '' : 'checked'} aria-label="Im Spiel">
      ${t.cover ? `<img class="thumb" src="${esc(t.cover)}" alt="" loading="lazy">` : '<span class="thumb"></span>'}
      <div class="meta"><div><b>${esc(t.title)}</b></div><div class="small">${esc(t.artist)}</div>
        ${t.sus && !ov ? '<div class="warn">⚠ Jahr evtl. vom Best-of/Remaster</div>' : ''}${ov ? `<div class="small">Spotify: ${esc(t.year)} · <a href="#" data-action="resetYear" data-id="${esc(t.id)}">zurücksetzen</a></div>` : ''}</div>
      <input type="number" inputmode="numeric" min="1900" max="2100" data-bind="year" data-id="${esc(t.id)}" value="${esc(yearOf(t) || '')}">
    </div>`;
  }).join('');
}

function viewSettings() {
  let h = `<div class="card"><h2>Spotify-App</h2>
    <p class="small">Client-ID aus <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a>.</p>
    <div class="row"><input type="text" id="clientId" value="${esc(S.clientId)}" placeholder="Client-ID" autocomplete="off" spellcheck="false">
    <button class="btn" data-action="saveClientId">Speichern</button></div>
    <p class="small" style="margin-top:12px">Diese Redirect-URI muss im Dashboard exakt so eingetragen sein:</p>
    <code class="copy">${esc(REDIRECT_URI)}</code>
    <button class="btn sm" style="margin-top:8px" data-action="copyRedirect">Kopieren</button>
    ${S.auth ? '<button class="btn sm ghost danger" style="margin-top:8px" data-action="logout">Abmelden</button>' : ''}
  </div>`;

  h += `<div class="card"><h2>Wiedergabe</h2>
    <label class="check"><input type="checkbox" data-bind="randomStart" ${S.settings.randomStart ? 'checked' : ''}><span>Songs mittendrin starten (Intro verrät oft zu viel)</span></label>
    <div class="row" style="margin-top:12px"><span class="grow">Start-Token pro Person</span>
    <select data-bind="startTokens" style="width:96px">${[0, 1, 2, 3, 5].map(v => `<option ${v === S.settings.startTokens ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`;
  if (S.auth) {
    h += `<p class="small" style="margin-top:12px">Gerät, auf dem gespielt wird:</p>`;
    if (S.devices) {
      h += S.devices.length ? S.devices.map(d => `<button class="pl-item" data-action="pickDevice" data-id="${esc(d.id)}">
        <span class="grow">${S.settings.deviceId === d.id ? '● ' : '○ '}${esc(d.name)} <span class="small">${esc(d.type)}${d.is_active ? ' · aktiv' : ''}</span></span></button>`).join('')
        : `<div class="msg err">${deviceHelp()}</div>`;
    }
    h += `<button class="btn sm" style="margin-top:8px" data-action="devices">Geräte suchen</button>`;
  }
  h += `</div>`;

  h += `<div class="card"><h2>Daten</h2><p class="small">Alles (Playlist, Jahres-Korrekturen, Spielstand) liegt nur in diesem Browser.</p>
    <button class="btn sm danger" data-action="resetAll">Alles zurücksetzen</button></div>`;
  return h;
}

function viewHelp() {
  return `<div class="card"><h2>So wird gespielt</h2><ol class="rules">
    <li>Alle bekommen eine aufgedeckte Startkarte mit Jahreszahl – das ist ihr Zeitstrahl.</li>
    <li>Wer dran ist, hört einen Song und tippt die Lücke an, wo er zeitlich hingehört (davor, dazwischen, danach).</li>
    <li><b>Aufdecken:</b> Passt das Erscheinungsjahr, bleibt die Karte. Sonst fliegt sie raus. Gleiches Jahr wie ein Nachbar zählt als richtig.</li>
    <li>Wer Titel <i>und</i> Interpret nennt, bekommt einen Token 🪙 (max. ${MAX_TOKENS}). Mit einem Token darf man einen Song überspringen.</li>
    <li>Wer zuerst die eingestellte Anzahl Karten hat, gewinnt. Ist der Stapel leer, gewinnt, wer die meisten hat.</li>
  </ol></div>
  <div class="card"><h2>Technik</h2><p class="small">Die App steuert die Spotify-App auf diesem Handy (oder einem Lautsprecher) fern. Dafür braucht die Person, die sich anmeldet, Spotify Premium. Alle anderen spielen einfach am selben Handy mit – sie brauchen kein Spotify.</p></div>`;
}

let busyLabel = null;
async function busy(label, fn) {
  busyLabel = label || '…'; render();
  try { await fn(); } catch (e) { say(e.message || String(e), 'err'); }
  finally { busyLabel = null; render(); }
}

function render() {
  const views = { home: viewHome, game: viewGame, songs: viewSongs, settings: viewSettings, help: viewHelp };
  let h = header();
  if (S.msg) h += `<div class="msg ${S.msg.kind}">${S.msg.html || esc(S.msg.text)}</div>`;
  h += (views[S.view] || viewHome)();
  if (busyLabel) h += `<div class="busy"><span class="spinner"></span>${esc(busyLabel)}</div>`;
  const app = document.getElementById('app');
  const plLink = document.getElementById('plLink');
  const keepLink = plLink ? plLink.value : '';
  app.innerHTML = h;
  const nl = document.getElementById('plLink');
  if (nl && keepLink) nl.value = keepLink;
}

/* ---------- Aktionen ---------- */
const actions = {
  nav: el => { S.view = el.dataset.view; S.msg = null; render(); window.scrollTo({ top: 0 }); },
  login: () => login(),
  logout: () => logout(),
  demo: () => { loadDemo(); render(); },
  myPlaylists: () => busy('Lade Playlists …', loadMyPlaylists),
  pickPlaylist: el => busy('Lade Songs …', async () => { await loadPlaylist(el.dataset.id); S.myPlaylists = null; }),
  loadLink: () => {
    const id = parsePlaylistId((document.getElementById('plLink') || {}).value);
    if (!id) { say('Das sieht nicht nach einem Spotify-Playlist-Link aus.', 'err'); return render(); }
    busy('Lade Songs …', () => loadPlaylist(id));
  },
  reloadPlaylist: () => busy('Lade Songs …', () => loadPlaylist(S.playlist.id)),
  addPlayer: () => { S.players.push(''); save(); render(); },
  delPlayer: el => { S.players.splice(+el.dataset.i, 1); save(); render(); },
  newGame: () => newGame(),
  play: () => drawAndPlay(),
  replay: () => replay(),
  pause: () => togglePause(),
  skip: () => skipWithToken(),
  hint: () => { S.hint = true; render(); },
  slot: el => { S.game.slot = +el.dataset.i; save(); render(); },
  reveal: () => reveal(),
  next: () => nextTurn(),
  saveClientId: () => {
    S.clientId = ((document.getElementById('clientId') || {}).value || '').trim();
    store.set('zk_client_id', S.clientId);
    S.auth = null; S.me = null; save();
    say(S.clientId ? 'Client-ID gespeichert. Jetzt unter „Start“ mit Spotify verbinden.' : 'Client-ID entfernt.', 'ok');
    render();
  },
  copyRedirect: async () => {
    try { await navigator.clipboard.writeText(REDIRECT_URI); say('Redirect-URI kopiert.', 'ok'); } catch { say('Kopieren ging nicht – bitte manuell markieren.', 'err'); }
    render();
  },
  devices: () => busy('Suche Geräte …', loadDevices),
  pickDevice: el => { S.settings.deviceId = el.dataset.id; save(); render(); },
  resetYear: el => { delete S.overrides[el.dataset.id]; save(); render(); },
  resetAll: () => {
    if (!confirm('Wirklich alles löschen (Login, Playlist, Korrekturen, Spielstand)?')) return;
    ['zk_auth', 'zk_me', 'zk_playlist', 'zk_overrides', 'zk_excluded', 'zk_settings', 'zk_players', 'zk_game', 'zk_client_id'].forEach(store.del);
    location.reload();
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el); }
});

document.addEventListener('input', e => {
  const el = e.target, b = el.dataset && el.dataset.bind;
  if (b === 'player') { S.players[+el.dataset.i] = el.value; save(); }
  if (b === 'filter') { S.songFilter = el.value; const box = document.getElementById('songlist'); if (box) box.innerHTML = songListHtml(); }
});

document.addEventListener('change', e => {
  const el = e.target, b = el.dataset && el.dataset.bind;
  if (!b) return;
  if (b === 'target') { S.settings.target = +el.value; save(); }
  if (b === 'startTokens') { S.settings.startTokens = +el.value; save(); }
  if (b === 'randomStart') { S.settings.randomStart = el.checked; save(); }
  if (b === 'bonus') { S.game.bonus = el.checked; save(); }
  if (b === 'onlyWarn') { S.onlyWarn = el.checked; const box = document.getElementById('songlist'); if (box) box.innerHTML = songListHtml(); render(); }
  if (b === 'include') { if (el.checked) delete S.excluded[el.dataset.id]; else S.excluded[el.dataset.id] = true; save(); el.closest('.song').classList.toggle('off', !el.checked); }
  if (b === 'year') {
    const t = S.playlist.tracks.find(x => x.id === el.dataset.id);
    const y = parseInt(el.value, 10);
    if (!t) return;
    if (!y || y === t.year) delete S.overrides[t.id]; else S.overrides[t.id] = y;
    save();
    const box = document.getElementById('songlist'); if (box) box.innerHTML = songListHtml();
  }
});

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.view === 'game') keepAwake(); });

(async function init() {
  if (S.game && S.game.phase !== 'over') S.view = 'game';
  await handleRedirect();
  if (S.msg && S.msg.kind === 'ok' && S.auth) S.view = 'home';
  render();
})();
