'use strict';
/* StarHit GoBin – Musik-Bingo.
   Die App steuert nur Glücksrad, Musik und Timer; die Bingo-Felder liegen auf Papier.
   Wird VOR app.js geladen und nutzt erst beim Aufruf deren Teile
   (S, save, render, busy, say, playTrack, pausePlayback, playError, playableTracks, yearOf, shuffle, esc, barHtml, keepAwake). */

const GB_COLORS = [
  { name: 'Lila', hex: '#9b5de5', fg: '#ffffff', cell: 'Jahr&shy;zehnt', wheel: 'Jahrzehnt', task: 'Jahrzehnt erraten', hint: 'Aus welchem Jahrzehnt stammt der Song? (z. B. 80er)' },
  { name: 'Grün', hex: '#22c55e', fg: '#052e16', cell: 'Titel', wheel: 'Titel', task: 'Titel erraten', hint: 'Wie heißt der Song?' },
  { name: 'Gelb', hex: '#facc15', fg: '#3b2f00', cell: 'Inter&shy;pret', wheel: 'Interpret', task: 'Interpret erraten', hint: 'Wer singt – oder welche Band ist das?' },
  { name: 'Blau', hex: '#3b82f6', fg: '#ffffff', cell: 'Jahr ±3', wheel: 'Jahr ±3', task: 'Jahr erraten (±3)', hint: 'Erscheinungsjahr – bis zu 3 Jahre daneben zählt noch.' },
  { name: 'Pink', hex: '#ec4899', fg: '#ffffff', cell: 'Jahr exakt', wheel: 'Jahr exakt', task: 'Jahr exakt erraten', hint: 'Erscheinungsjahr – nur das genaue Jahr zählt.' },
];
const GB_SECONDS = 10;
const GB_MIN_PLAYERS = 2, GB_MAX_PLAYERS = 10;
const GB_SPIN_MS = 4600;

let gbSpinning = false, gbSpinFrom = 0, gbTimer = null, gbBoardsOpen = false, gbHint = false;

const gbRand = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
const gbBuzz = p => { try { if (navigator.vibrate) navigator.vibrate(p); } catch {} };

/* ---------- Bingo-Felder ---------- */
// Anzahl gleichfarbiger Nachbarn (waagrecht + senkrecht)
function gbConflicts(b) {
  let n = 0;
  for (let i = 0; i < 25; i++) {
    if (i % 5 < 4 && b[i] === b[i + 1]) n++;
    if (i < 20 && b[i] === b[i + 5]) n++;
  }
  return n;
}

// 5×5, jede Farbe genau 5-mal, zufällig – und möglichst keine gleichen Farben nebeneinander.
function gbMakeBoard() {
  let best = null, bestCost = Infinity;
  for (let attempt = 0; attempt < 30 && bestCost > 0; attempt++) {
    const b = shuffle(Array.from({ length: 25 }, (_, i) => i % 5));
    let cost = gbConflicts(b);
    for (let it = 0; it < 6000 && cost > 0; it++) {
      const i = gbRand(25), j = gbRand(25);
      if (b[i] === b[j]) continue;
      [b[i], b[j]] = [b[j], b[i]];
      const c = gbConflicts(b);
      if (c <= cost) cost = c; else [b[i], b[j]] = [b[j], b[i]];
    }
    if (cost < bestCost) { best = b.slice(); bestCost = cost; }
  }
  return best;
}

// Alle Felder einer Partie sind verschieden.
function gbMakeBoards(n) {
  const seen = new Set(), boards = [];
  while (boards.length < n) {
    const b = gbMakeBoard(), key = b.join('');
    if (seen.has(key)) continue;
    seen.add(key); boards.push(b);
  }
  return boards;
}

/* ---------- Ablauf ---------- */
function gbCreateBoards() {
  const n = S.settings.bingoPlayers || 4;
  S.bingo = { phase: 'boards', players: n, boards: gbMakeBoards(n), deck: null, round: 0, color: null, rot: 0, current: null, cdEnds: null, demo: false };
  gbBoardsOpen = false; S.msg = null;
  save(); render(); window.scrollTo({ top: 0 });
}

function gbStart() {
  const b = S.bingo;
  const deck = playableTracks().map(t => ({ id: t.id, uri: t.uri, title: t.title, artist: t.artist, cover: t.cover, dur: t.dur, year: yearOf(t) }));
  if (!deck.length) { say('Keine spielbaren Songs – wähle zuerst eine Playlist.', 'err'); return render(); }
  Object.assign(b, { phase: 'wheel', deck: shuffle(deck), round: 1, color: null, current: null, demo: !!(S.playlist && S.playlist.demo) });
  S.msg = null; save(); keepAwake(); render(); window.scrollTo({ top: 0 });
}

function gbSpin() {
  const b = S.bingo;
  if (!b || b.phase !== 'wheel' || gbSpinning) return;
  const idx = gbRand(5); // alle Farben gleich wahrscheinlich
  const target = idx * 72 + 36 + (Math.random() - 0.5) * 52; // irgendwo im Segment, nicht auf der Kante
  const from = b.rot || 0;
  const delta = (((-target - from) % 360) + 360) % 360;
  const to = from + 360 * (5 + gbRand(2)) + delta;
  gbSpinning = true; gbSpinFrom = from;
  b.color = idx; b.phase = 'category'; b.rot = to % 360; b.current = null;
  save(); render();
  const el = document.getElementById('gbrot');
  if (el) {
    el.style.transition = 'none';
    el.style.transform = `rotate(${from}deg)`;
    void el.getBoundingClientRect();
    el.style.transition = `transform ${GB_SPIN_MS}ms cubic-bezier(.15,.75,.15,1)`;
    el.style.transform = `rotate(${to}deg)`;
  }
  gbBuzz(25);
  setTimeout(() => { gbSpinning = false; gbBuzz([40, 30, 40]); render(); window.scrollTo({ top: 0 }); }, GB_SPIN_MS + 700);
}

async function gbPlay() {
  const b = S.bingo;
  if (!b.current) {
    if (!b.deck.length) { say('Alle Songs der Playlist sind gespielt. Beendet das Spiel oder ladet eine größere Playlist.', 'err'); return render(); }
    b.current = b.deck.pop(); // keine Wiederholungen innerhalb einer Partie
    save();
  }
  S.msg = null; gbHint = false;
  if (b.demo) { b.phase = 'playing'; save(); return render(); }
  await busy('Song startet …', async () => {
    try { await playTrack(b.current); b.phase = 'playing'; save(); }
    catch (e) { playError(e); }
  });
}

function gbReplay() {
  const b = S.bingo;
  if (b.demo || !b.current) return;
  busy('Song startet …', () => playTrack(b.current).catch(playError));
}

function gbKnow() {
  const b = S.bingo;
  if (b.phase !== 'playing') return;
  b.phase = 'countdown'; b.cdEnds = Date.now() + GB_SECONDS * 1000;
  gbBuzz(60); save(); render(); gbStartTimer();
}

function gbStopTimer() { if (gbTimer) { clearInterval(gbTimer); gbTimer = null; } }
function gbStartTimer() { gbStopTimer(); gbTimer = setInterval(gbTick, 100); gbTick(); }
function gbTick() {
  const b = S.bingo;
  if (!b || b.phase !== 'countdown') return gbStopTimer();
  const ms = b.cdEnds - Date.now();
  const num = document.getElementById('gbcd'); if (num) num.textContent = Math.max(0, Math.ceil(ms / 1000));
  const ring = document.getElementById('gbring'); if (ring) ring.style.setProperty('--p', Math.max(0, ms / (GB_SECONDS * 1000)));
  if (ms <= 0) {
    // Zeit vorbei: rotes Signal, die Musik läuft weiter.
    gbStopTimer(); b.phase = 'stop'; save(); render(); gbBuzz([300, 120, 300]);
  }
}

function gbSolve() {
  const b = S.bingo;
  if (!['playing', 'countdown', 'stop'].includes(b.phase)) return;
  gbStopTimer(); b.phase = 'solution'; S.msg = null; save(); render(); window.scrollTo({ top: 0 });
}

function gbNext() {
  const b = S.bingo;
  if (!b.demo) pausePlayback(); // Musik stoppen
  Object.assign(b, { phase: 'wheel', color: null, current: null, cdEnds: null, round: b.round + 1 });
  S.msg = null; gbHint = false; save(); render(); window.scrollTo({ top: 0 });
}

function gbEnd() {
  const b = S.bingo;
  const started = b && b.phase !== 'boards';
  if (started && !confirm('Spiel wirklich beenden?\nDie Bingo-Felder in der App werden dabei gelöscht.')) return;
  gbStopTimer();
  if (b && !b.demo && b.current && ['playing', 'countdown', 'stop', 'solution'].includes(b.phase)) pausePlayback();
  S.bingo = null; gbBoardsOpen = false; S.msg = null;
  S.view = started ? 'lobby' : 'bingo';
  save(); render(); window.scrollTo({ top: 0 });
}

// Beim Laden der Seite (z. B. nach dem Wechsel zur Spotify-App) laufende Zustände wiederherstellen.
function gbResume() {
  const b = S.bingo;
  if (!b) return;
  if (b.phase === 'countdown') {
    if (b.cdEnds - Date.now() <= 0) b.phase = 'stop';
    else gbStartTimer();
  }
}

/* ---------- Ansichten ---------- */
function gbLegendHtml() {
  return `<div class="gb-legend">${GB_COLORS.map(c =>
    `<div class="gb-leg"><span class="gb-dot" style="background:${c.hex}"></span><b>${c.name}</b><span class="small">${c.task}</span></div>`).join('')}</div>`;
}

function gbBoardHtml(board) {
  return `<div class="gb-board">${board.map(i => {
    const c = GB_COLORS[i];
    return `<div class="gb-cell" style="background:${c.hex};color:${c.fg}">${c.cell}</div>`;
  }).join('')}</div>`;
}

function gbWheelHtml() {
  const b = S.bingo;
  const pt = a => `${(100 * Math.cos(a)).toFixed(2)} ${(100 * Math.sin(a)).toFixed(2)}`;
  let segs = '';
  GB_COLORS.forEach((c, i) => {
    const a0 = (i * 72 - 90) * Math.PI / 180, a1 = ((i + 1) * 72 - 90) * Math.PI / 180;
    segs += `<path d="M0 0 L${pt(a0)} A100 100 0 0 1 ${pt(a1)}Z" fill="${c.hex}" stroke="#14121c" stroke-width="1.5"/>
      <g transform="rotate(${i * 72 + 36})"><text y="-68" class="w1" fill="${c.fg}">${c.name}</text><text y="-53" class="w2" fill="${c.fg}">${c.wheel}</text></g>`;
  });
  const rot = gbSpinning ? gbSpinFrom : (b.rot || 0);
  return `<div class="gb-wheel ${gbSpinning ? 'spinning' : ''}" data-action="gbSpin" role="button" aria-label="Glücksrad drehen">
    <div class="gb-pointer"></div>
    <svg viewBox="-106 -106 212 212" id="gbrot" style="transform:rotate(${rot}deg)">
      <circle r="104" fill="#f3f0fa"/>${segs}
      <circle r="17" fill="#14121c" stroke="#f3f0fa" stroke-width="4"/>
    </svg></div>`;
}

function gbCatHtml(c, big) {
  return `<div class="gb-cat ${big ? 'big' : ''}" style="--c:${c.hex};--fg:${c.fg}">
    <div class="gb-cname">${c.name}</div><div class="gb-ctask">${c.task}</div>
    ${big ? `<div class="gb-chint">${c.hint}</div>` : ''}</div>`;
}

function gbSetupHtml() {
  const n = S.settings.bingoPlayers || 4;
  const songs = S.playlist ? playableTracks().length : 0;
  let h = `<div class="gb-hero"><span class="mini-wheel big"></span><div><div class="gb-title">StarHit GoBin</div>
    <div class="small">Musik-Bingo: Rad drehen, Song hören, Feld abhaken.</div></div></div>`;
  h += `<div class="card"><h2>Playlist</h2>${S.playlist
    ? `<div class="row"><div class="grow"><b>${esc(S.playlist.name)}</b><div class="small">${songs} spielbare Songs</div></div>
       <button class="btn sm" data-action="nav" data-view="lobby">Ändern</button></div>`
    : `<p>Noch keine Playlist gewählt.</p><button class="btn primary" data-action="nav" data-view="lobby">Playlist wählen</button>`}</div>`;
  h += `<div class="card"><h2>Wie viele spielen mit?</h2>
    <div class="gb-stepper">
      <button class="btn" data-action="gbPlayers" data-d="-1" ${n <= GB_MIN_PLAYERS ? 'disabled' : ''} aria-label="Weniger">−</button>
      <div class="gb-num">${n}<span class="small">Spieler</span></div>
      <button class="btn" data-action="gbPlayers" data-d="1" ${n >= GB_MAX_PLAYERS ? 'disabled' : ''} aria-label="Mehr">+</button>
    </div>
    <p class="small" style="margin-top:10px">Jede Person bekommt ein eigenes 5×5-Feld und zeichnet es auf Papier ab.</p></div>`;
  h += `<div class="card"><h2>Die fünf Farben</h2>${gbLegendHtml()}</div>`;
  h += barHtml('Bingo-Felder erzeugen', 'gbCreate', songs > 0);
  return h;
}

function gbBoardsHtml(beforeStart) {
  const b = S.bingo;
  let h = `<div class="turn"><div class="who" style="font-size:24px">${beforeStart ? 'Eure Bingo-Felder' : 'Bingo-Felder'}</div>
    <div class="small">${beforeStart ? 'Jede Person zeichnet ihr Feld auf Papier ab – Farbstifte oder die Kürzel genügen.' : 'Zum Nachschauen – das Spiel läuft weiter.'}</div></div>`;
  b.boards.forEach((bd, i) => { h += `<div class="card gb-boardcard"><h3>Spieler ${i + 1}</h3>${gbBoardHtml(bd)}</div>`; });
  if (beforeStart) {
    h += `<div class="card"><h2>Legende</h2>${gbLegendHtml()}</div>
      <div class="stack"><button class="btn block" data-action="gbCreate">Felder neu würfeln</button>
      <button class="btn ghost block" data-action="gbEnd">Spielerzahl ändern</button></div>`;
    h += barHtml('Alle abgezeichnet – Spiel starten', 'gbStart');
  } else {
    h += barHtml('Zurück zum Spiel', 'gbBoards');
  }
  return h;
}

function gbSolutionHtml(b, c) {
  const t = b.current, y = t.year;
  const detail = [
    `Jahrzehnt: <b>${Math.floor(y / 10) * 10}er</b>`,
    `Titel: <b>${esc(t.title)}</b>`,
    `Interpret: <b>${esc(t.artist)}</b>`,
    `Richtig ist alles von <b>${y - 3} bis ${y + 3}</b>`,
    `Richtig ist nur <b>${y}</b>`,
  ][b.color];
  return `<div class="mystery revealed gb-sol">
    ${t.cover ? `<img src="${esc(t.cover)}" alt="">` : ''}
    <div class="bigyr">${esc(y)}</div>
    <div style="font-weight:700;font-size:20px">${esc(t.title)}</div><div class="small" style="font-size:15px">${esc(t.artist)}</div>
    <div class="gb-check" style="--c:${c.hex}">${detail}</div>
    <p class="small" style="margin-top:10px">Wer richtig lag, hakt ein Feld in <b style="color:${c.hex}">${c.name}</b> ab.</p></div>`;
}

function gbGameHtml() {
  const b = S.bingo, c = b.color != null ? GB_COLORS[b.color] : null;
  let h = `<div class="gb-top"><div class="small">Runde ${b.round} · ${b.deck.length} Songs übrig</div>
    <div class="row"><button class="btn sm ghost" data-action="gbBoards">▦ Felder</button>
    <button class="btn sm danger" data-action="gbEnd">Spiel beenden</button></div></div>`;

  if (b.phase === 'wheel' || gbSpinning) {
    h += gbWheelHtml();
    h += `<p class="small" style="text-align:center;margin-top:6px">${gbSpinning ? 'Das Rad dreht …' : 'Aufs Rad tippen oder „Drehen“.'}</p>`;
    h += barHtml(gbSpinning ? 'Dreht …' : 'Drehen', 'gbSpin', !gbSpinning);
    return h;
  }

  if (b.phase === 'category') {
    h += gbCatHtml(c, true);
    h += barHtml(b.demo ? '🃏 Song ziehen' : '▶ Song abspielen', 'gbPlay');
    return h;
  }

  h += gbCatHtml(c, false);

  if (b.phase === 'playing') {
    if (b.demo) {
      h += gbHint
        ? `<p style="text-align:center"><b>${esc(b.current.title)}</b><br><span class="small">${esc(b.current.artist)} · ${esc(b.current.year)}</span></p>`
        : `<p class="small" style="text-align:center">Demo ohne Ton: Eine Person liest Titel &amp; Interpret vor. <button class="btn sm" data-action="gbHint">Titel anzeigen</button></p>`;
    } else {
      h += `<div class="row" style="justify-content:center"><button class="btn sm" data-action="gbReplay">↺ Song nochmal starten</button></div>`;
    }
    h += `<button class="gb-know" data-action="gbKnow" style="--c:${c.hex}">Ich weiß es!<span>Startet ${GB_SECONDS} Sekunden für alle anderen</span></button>`;
    h += barHtml('Lösung anzeigen', 'gbSolve', true, '');
    return h;
  }

  if (b.phase === 'countdown') {
    const ms = Math.max(0, b.cdEnds - Date.now());
    h += `<div class="gb-cd" id="gbring" style="--c:${c.hex};--p:${ms / (GB_SECONDS * 1000)}"><span id="gbcd">${Math.ceil(ms / 1000)}</span></div>
      <p class="gb-cdtext">Die anderen dürfen noch raten!</p>`;
    h += barHtml('Lösung anzeigen', 'gbSolve', true, '');
    return h;
  }

  if (b.phase === 'stop') {
    h += `<div class="gb-stop"><div class="gb-light"></div><div class="gb-stoptext">STOPP!</div><div>Nicht mehr raten – die Musik läuft weiter.</div></div>`;
    h += barHtml('Lösung anzeigen', 'gbSolve');
    return h;
  }

  // solution
  h += gbSolutionHtml(b, c);
  h += barHtml('Nächste Runde', 'gbNext');
  return h;
}

function viewBingo() {
  const b = S.bingo;
  if (!b) return gbSetupHtml();
  if (b.phase === 'boards') return gbBoardsHtml(true);
  if (gbBoardsOpen) return gbBoardsHtml(false);
  return gbGameHtml();
}

function gbHelpHtml() {
  return `<div class="card"><h2>So geht StarHit GoBin</h2><ol class="rules">
    <li>Spielerzahl wählen. Jede Person zeichnet ihr 5×5-Bingo-Feld auf Papier ab.</li>
    <li>Glücksrad drehen – die Farbe bestimmt, was diese Runde geraten wird.</li>
    <li>Song abspielen. Wer die Lösung zu kennen glaubt, tippt „Ich weiß es!“ – dann haben die anderen noch ${GB_SECONDS} Sekunden.</li>
    <li>Rotes Licht: nicht mehr raten. „Lösung anzeigen“ – wer richtig lag, hakt ein Feld in der gedrehten Farbe ab.</li>
    <li>Wer zuerst eine volle Reihe, Spalte oder Diagonale hat, ruft „Bingo!“. Dann „Spiel beenden“.</li>
  </ol>${gbLegendHtml()}</div>`;
}

/* ---------- Aktionen (werden in app.js eingebunden) ---------- */
const GOBIN_ACTIONS = {
  gbPlayers: el => {
    const n = (S.settings.bingoPlayers || 4) + (+el.dataset.d);
    S.settings.bingoPlayers = Math.min(GB_MAX_PLAYERS, Math.max(GB_MIN_PLAYERS, n));
    save(); render();
  },
  gbCreate: () => gbCreateBoards(),
  gbStart: () => gbStart(),
  gbSpin: () => gbSpin(),
  gbPlay: () => gbPlay(),
  gbReplay: () => gbReplay(),
  gbHint: () => { gbHint = true; render(); },
  gbKnow: () => gbKnow(),
  gbSolve: () => gbSolve(),
  gbNext: () => gbNext(),
  gbEnd: () => gbEnd(),
  gbBoards: () => { gbBoardsOpen = !gbBoardsOpen; render(); window.scrollTo({ top: 0 }); },
};
