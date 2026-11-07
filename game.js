/* ==========================================================
   Star-Wars-Quiz – Spiellogik
   Sprachsteuerung über die Web Speech API (Chrome):
   - SpeechSynthesis  → Vorlesen
   - SpeechRecognition → Zuhören
   Testmodus: index.html?test  (Antworten tippen statt sprechen)
   ========================================================== */
'use strict';

/* ---------------- Konfiguration ---------------- */
const CONFIG = {
  lang: 'de-DE',
  maxPlayers: 4,
  questionsPerPlayer: 6,
  pointsFree: 5,
  pointsChoice: 2,
  maxListenTries: 3,      // Fehlversuche bei freier Antwort, danach A/B/C
  listenTimeoutMs: 12000, // maximale Zuhördauer pro Versuch
};
const TEST_MODE = new URLSearchParams(location.search).has('test');
// iPad meldet sich mit "Desktop-Website anfordern" als Mac → zusätzlich Touch prüfen
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/* ---------------- Hilfsfunktionen ---------------- */
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const LETTERS = ['A', 'B', 'C'];

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function punkte(n) { return `${n} ${n === 1 ? 'Punkt' : 'Punkte'}`; }
function punkteGesprochen(n) {
  const words = { 0: 'null', 1: 'einen', 2: 'zwei', 5: 'fünf' };
  return n === 1 ? 'einen Punkt' : `${words[n] ?? n} Punkte`;
}
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

class FatalError extends Error {}

/* ==========================================================
   Textauswertung (tolerant)
   ========================================================== */
const Text = (() => {
  const NUMBERS = {
    null: '0', eins: '1', zwei: '2', zwo: '2', drei: '3', vier: '4',
    fuenf: '5', funf: '5', sechs: '6', sieben: '7', acht: '8', neun: '9',
    zehn: '10', elf: '11', zwoelf: '12', zwolf: '12',
  };
  // Füllwörter und Artikel, die bei freien Antworten ignoriert werden
  const FILLER = new Set([
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
    'ich', 'glaube', 'glaub', 'denke', 'meine', 'vermute', 'schaetze', 'tippe', 'sage',
    'es', 'ist', 'sind', 'war', 'waren', 'heisst', 'hiess', 'antwort', 'lautet',
    'also', 'aeh', 'aehm', 'oehm', 'hm', 'hmm', 'aeh', 'na', 'wohl', 'vielleicht', 'doch', 'mal',
    'auf', 'im', 'in', 'mit', 'von', 'nach', 'zu', 'am', 'er', 'sie', 'natuerlich', 'klar', 'bestimmt',
  ]);

  /** Kleinschreibung, Umlaute → ae/oe/ue, Satzzeichen → Leerzeichen */
  function basic(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** Wörter einer Antwort ohne Füllwörter, Zahlwörter als Ziffern */
  function tokens(s) {
    return basic(s)
      .split(' ')
      .filter(Boolean)
      .map((t) => NUMBERS[t] ?? t)
      .filter((t) => !FILLER.has(t));
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /** erlaubte Tippfehler / Erkennungsfehler je nach Wortlänge */
  function tolerance(target) {
    if (/^\d+$/.test(target)) return 0;
    const n = target.length;
    if (n <= 3) return 0;
    if (n <= 5) return 1;
    if (n <= 8) return 2;
    return 3;
  }

  /** Passt eine gesprochene Antwort zu einer Zielantwort? */
  function similar(spoken, target) {
    const s = tokens(spoken);
    const t = tokens(target);
    if (!s.length || !t.length) return false;
    const tc = t.join('');
    const tol = tolerance(tc);
    if (levenshtein(s.join(''), tc) <= tol) return true;
    // Zielantwort irgendwo im Satz? ("ich glaube es war Yoda, oder?")
    for (let w = Math.max(1, t.length - 1); w <= t.length + 1; w++) {
      for (let i = 0; i + w <= s.length; i++) {
        if (levenshtein(s.slice(i, i + w).join(''), tc) <= tol) return true;
      }
    }
    return false;
  }

  /** Irgendeine Erkennungsalternative passt zu irgendeiner Zielantwort */
  function matchesAny(alts, targets) {
    return alts.some((a) => targets.some((t) => similar(a, t)));
  }

  return { basic, tokens, similar, matchesAny };
})();

/* ==========================================================
   Absichten erkennen (weiß nicht, wiederholen, fertig, ja/nein)
   ========================================================== */
const Intent = {
  _top(alts, n = 2) { return alts.slice(0, n).map(Text.basic); },

  dontKnow(alts) {
    const re = /\b(weiss|weis|weiß)\b.*\b(nicht|nich|net|nix)\b|keine ahnung|kein plan|keinen plan|\bpasse\b|\bpass\b|\bhilfe\b|moeglichkeiten|optionen|auswahl|\bjoker\b|\bk a\b/;
    return this._top(alts).some((a) => re.test(a));
  },

  repeat(alts) {
    const re = /wiederhol|noch ?mal|noch einmal|wie bitte|nicht verstanden|bitte was/;
    return this._top(alts).some((a) => re.test(a));
  },

  done(alts) {
    return this._top(alts).some((a) => a.split(' ').includes('fertig'));
  },

  no(alts) {
    const NO = ['nein', 'ne', 'nee', 'noe', 'no', 'nope', 'falsch', 'nicht', 'stimmt nicht'];
    return this._top(alts).some((a) => a.split(' ').some((w) => NO.includes(w)));
  },

  /** A, B oder C aus der Antwort lesen (auch "Antwort B", "zeh", "die zweite", Optionstext) */
  letter(alts, options) {
    const WORDS = {
      A: ['a', 'ah', 'aa', 'ahh', 'aah', '1', 'erste', 'ersten', 'erstens'],
      B: ['b', 'be', 'bee', 'beh', 'bh', '2', 'zweite', 'zweiten', 'zweitens'],
      C: ['c', 'ce', 'cee', 'ceh', 'zeh', 'ze', 'tse', 'tze', 'see', 'zee', 'cool', '3', 'dritte', 'dritten', 'drittens'],
    };
    for (const alt of alts) {
      const words = Text.basic(alt).split(' ').filter(Boolean)
        .map((w) => ({ eins: '1', zwei: '2', drei: '3' }[w] ?? w));
      const found = new Set();
      for (const L of LETTERS) if (words.some((w) => WORDS[L].includes(w))) found.add(L);
      if (found.size === 1) return [...found][0];
    }
    // Optionstext genannt? ("Hoth")
    for (const alt of alts) {
      const hits = LETTERS.filter((L) => Text.similar(alt, options[L]));
      if (hits.length === 1) return hits[0];
    }
    return null;
  },
};

/* ==========================================================
   Soundeffekte (WebAudio, ganz dezent)
   ========================================================== */
const Sound = {
  ctx: null,
  init() {
    if (this.ctx) return;
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { this.ctx = null; }
  },
  tone(freq, dur, { type = 'sine', vol = 0.06, delay = 0, slideTo = null } = {}) {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume?.();
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  },
  listen()  { this.tone(660, 0.08); this.tone(990, 0.11, { delay: 0.09 }); },
  correct() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.18, { delay: i * 0.08, vol: 0.05 })); },
  wrong()   { this.tone(220, 0.35, { type: 'sawtooth', vol: 0.035, slideTo: 110 }); },
  ignite()  {
    this.tone(90, 0.6, { type: 'sawtooth', vol: 0.04, slideTo: 160 });
    this.tone(180, 0.6, { type: 'triangle', vol: 0.03, slideTo: 320 });
  },
  fanfare() {
    [392, 523, 659, 784, 659, 784, 1047].forEach((f, i) =>
      this.tone(f, i === 6 ? 0.8 : 0.22, { delay: i * 0.16, type: 'triangle', vol: 0.06 }));
  },
};

/* ==========================================================
   Sprachausgabe & Spracherkennung
   ========================================================== */
const Speech = {
  voice: null,
  _keep: new Set(), // Chrome-Bug: Utterances sonst evtl. vom GC entfernt → onend feuert nie

  get recognitionSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  },
  get synthesisSupported() { return 'speechSynthesis' in window; },

  init() {
    if (!this.synthesisSupported) return;
    const choose = () => {
      const voices = speechSynthesis.getVoices();
      const de = voices.filter((v) => /^de(-|_|$)/i.test(v.lang));
      this.voice = de.find((v) => /google/i.test(v.name))
        || de.find((v) => /de-DE/i.test(v.lang) && /(anna|helena|markus|siri|premium|enhanced)/i.test(v.name))
        || de.find((v) => v.localService) || de[0] || null;
    };
    choose();
    speechSynthesis.addEventListener?.('voiceschanged', choose);
  },

  /** Muss innerhalb eines Klick-Handlers aufgerufen werden (Autoplay-Regeln). */
  prime() {
    if (!this.synthesisSupported) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  },

  _sentence(text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = CONFIG.lang;
      if (this.voice) u.voice = this.voice;
      u.rate = 1.0;
      u.pitch = 1.0;
      this._keep.add(u);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this._keep.delete(u);
        resolve();
      };
      u.onend = finish;
      u.onerror = finish;
      // Sicherheitsnetz, falls Chrome onend verschluckt
      const timer = setTimeout(finish, 5000 + text.length * 110);
      speechSynthesis.resume();
      speechSynthesis.speak(u);
    });
  },

  async speak(text) {
    UI.caption(text);
    UI.setMic('speaking');
    if (TEST_MODE || !this.synthesisSupported) {
      await sleep(TEST_MODE ? 120 : 600);
    } else {
      // In Sätze zerlegen: Chrome bricht sehr lange Utterances sonst nach ~15 s ab
      const parts = text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) || [text];
      for (const p of parts) await this._sentence(p);
    }
    UI.setMic('idle');
  },

  async _waitIdle() {
    if (!this.synthesisSupported) return;
    const t0 = Date.now();
    while (speechSynthesis.speaking && Date.now() - t0 < 15000) await sleep(100);
  },

  /**
   * Hört einmal zu.
   * @returns {Promise<{alts: string[]|null, error?: string}>}
   */
  async listen() {
    if (TEST_MODE) return this._listenText();
    await this._waitIdle();
    if (IS_IOS) {
      // iPad/iPhone: Audio-Sitzung freigeben, kein Signalton (blockiert sonst das Mikrofon)
      try { speechSynthesis.cancel(); } catch { /* egal */ }
      try { await Sound.ctx?.suspend?.(); } catch { /* egal */ }
      await sleep(350);
    } else {
      await sleep(200);
      Sound.listen();
      await sleep(260); // Signalton nicht mit aufnehmen
    }

    if (!this.tapMode) return this._recognize();

    // Tippen & Sprechen: Erkennung startet direkt im Tipp-Ereignis (nötig in Safari auf iOS)
    UI.setMic('tap');
    UI.heard('', false);
    return new Promise((resolve) => {
      const mic = $('#mic');
      const go = (e) => {
        e.preventDefault();
        mic.removeEventListener('click', go);
        resolve(this._recognize());
      };
      mic.addEventListener('click', go);
    });
  },

  /** Startet die Erkennung sofort (synchron) und liefert {alts, error, quick}. */
  _recognize() {
    return new Promise((resolve) => {
      const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new Rec();
      rec.lang = CONFIG.lang;
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 5;

      const t0 = Date.now();
      const log = ['Start'];
      const diag = (step) => { log.push(step); UI.diag(`Spracherkennung: ${log.join(' → ')}`); };

      let finalAlts = null;
      let interim = '';
      let error = null;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        UI.setMic('idle');
        let alts = finalAlts;
        if (!alts?.length && interim.trim()) alts = [interim.trim()];
        if (alts?.length) UI.heard(alts[0], false);
        else UI.heard(error ? `Nichts verstanden (${error})` : 'Nichts verstanden', false);
        diag(`Ende (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
        resolve(alts?.length
          ? { alts }
          : { alts: null, error, quick: Date.now() - t0 < 1500 });
      };

      rec.onaudiostart = () => diag('Mikro an');
      rec.onspeechstart = () => diag('Sprache');
      rec.onresult = (e) => {
        let live = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) {
            finalAlts = Array.from(r).map((a) => a.transcript.trim()).filter(Boolean);
          } else {
            live += r[0].transcript;
          }
        }
        if (live) { interim = live; UI.heard(live, true); }
        if (finalAlts) {
          diag('Ergebnis');
          try { rec.stop(); } catch { /* bereits beendet */ }
        } else if (IS_IOS && live) {
          // Safari markiert Ergebnisse oft nie als final → nach kurzer Pause selbst beenden
          clearTimeout(rec._pause);
          rec._pause = setTimeout(() => { try { rec.stop(); } catch { /* egal */ } }, 1400);
        }
      };
      rec.onerror = (e) => { error = e.error; diag(`Fehler: ${e.error}`); };
      rec.onend = finish;

      const timer = setTimeout(() => {
        try { rec.stop(); } catch { /* egal */ }
        setTimeout(finish, 1500);
      }, CONFIG.listenTimeoutMs);

      UI.setMic('listening');
      UI.heard('', false);
      UI.diag('Spracherkennung: Start');
      try {
        rec.start();
      } catch (err) {
        error = 'start-failed';
        diag(`Startfehler: ${err.name || err.message}`);
        finish();
      }
    });
  },

  /** Testmodus: Antwort per Texteingabe */
  _listenText() {
    UI.setMic('listening');
    UI.heard('', false);
    const form = $('#test-input');
    const input = $('#test-text');
    input.value = '';
    input.focus();
    return new Promise((resolve) => {
      form.onsubmit = (e) => {
        e.preventDefault();
        form.onsubmit = null;
        const v = input.value.trim();
        UI.setMic('idle');
        if (v) UI.heard(v, false);
        resolve(v ? { alts: [v] } : { alts: null, error: 'no-speech' });
      };
    });
  },
};

const SORRY = [
  'Entschuldigung, das habe ich nicht verstanden.',
  'Hm, da war Rauschen in der Leitung.',
  'Ich habe leider nichts verstanden.',
  'Die Verbindung war gestört.',
];
const PRAISE = ['Richtig!', 'Ausgezeichnet!', 'Stark!', 'Volltreffer!', 'Genau!', 'Die Macht ist mit dir!'];
const COMFORT = ['Leider falsch.', 'Das war leider nicht richtig.', 'Knapp daneben ist auch vorbei.'];

/**
 * Spricht einen Text und hört danach zu. Wiederholt freundlich, wenn nichts verstanden wurde.
 * @returns {Promise<string[]|null>} Erkennungsalternativen oder null nach maxTries Fehlversuchen
 */
async function ask(prompt, { retryPrompt = prompt, maxTries = Infinity } = {}) {
  await Speech.speak(prompt);
  let networkErrors = 0;
  for (let tries = 1; ; tries++) {
    const { alts, error } = await Speech.listen();

    if (alts?.length) { Speech.fails = 0; return alts; }

    // iPad/iPhone: klappt das automatische Zuhören nicht, auf "Tippen & Sprechen" umschalten
    if (IS_IOS && !Speech.tapMode && !TEST_MODE) {
      Speech.fails = (Speech.fails || 0) + 1;
      if (Speech.fails >= 1 || ['not-allowed', 'service-not-allowed', 'start-failed'].includes(error)) {
        Speech.tapMode = true;
        tries--; // zählt nicht als Fehlversuch
        await Speech.speak(`Auf diesem Gerät musst du kurz auf das Mikrofon tippen, bevor du sprichst. ${retryPrompt}`);
        continue;
      }
    }

    if (['not-allowed', 'service-not-allowed'].includes(error)) {
      throw new FatalError('Der Zugriff auf Mikrofon oder Spracherkennung wurde verweigert. Chrome: Schloss-Symbol in der Adressleiste. iPad: Einstellungen → Safari → Mikrofon erlauben und unter Allgemein → Tastatur die Diktierfunktion einschalten. Danach neu starten.');
    }
    if (error === 'audio-capture') {
      throw new FatalError('Es wurde kein Mikrofon gefunden. Bitte schließe ein Mikrofon an und starte neu.');
    }
    if (error === 'network') {
      networkErrors++;
      if (networkErrors >= 3) {
        throw new FatalError('Die Spracherkennung ist nicht erreichbar. Sie benötigt eine Internetverbindung.');
      }
      await Speech.speak('Die Spracherkennung ist gerade nicht erreichbar. Ich versuche es noch einmal.');
      continue;
    }

    if (tries >= maxTries) return null;
    await Speech.speak(`${pick(SORRY)} ${retryPrompt}`);
  }
}

/* ==========================================================
   Spielzustand
   ========================================================== */
let DATA = null; // { questions: [...], tiebreakers: [...] }

const state = {
  players: [],        // { name, score, tie, bump }
  current: null,
  phase: 'Anmeldung',
  progress: '',
  questionText: '',
  options: null,
  reveal: null,       // { chosen, correct }
  feedback: null,     // { text, type }
  pool: [],
  tiePool: [],
};

function resetState() {
  Object.assign(state, {
    players: [], current: null, phase: 'Anmeldung', progress: '', questionText: '',
    options: null, reveal: null, feedback: null,
    pool: shuffle(DATA.questions), tiePool: shuffle(DATA.tiebreakers),
  });
}

function drawQuestion() {
  if (!state.pool.length) state.pool = shuffle(DATA.questions); // nur als Notfall
  return state.pool.pop();
}
function drawTiebreak() {
  if (state.tiePool.length) return state.tiePool.pop();
  if (state.pool.length) return state.pool.pop(); // übrige, noch nicht gestellte Fragen
  state.tiePool = shuffle(DATA.tiebreakers);
  return state.tiePool.pop();
}

/* ==========================================================
   Darstellung
   ========================================================== */
const UI = {
  show(name) {
    document.querySelectorAll('.screen').forEach((s) =>
      s.classList.toggle('active', s.id === `screen-${name}`));
  },
  setMic(mode) {
    const labels = { idle: 'Bereit', speaking: 'Spricht …', listening: 'Hört zu …', tap: 'Tippen & sprechen' };
    $('#mic').dataset.state = mode;
    $('#mic-label').textContent = labels[mode] || '';
  },
  caption(text) { $('#caption').textContent = text; },
  diag(text) { const el = $('#diag'); if (el) el.textContent = text; },
  heard(text, interim) {
    const el = $('#heard');
    el.textContent = text ? `Verstanden: „${text}“` : '';
    el.classList.toggle('interim', !!interim);
  },
};

function render() {
  const cp = $('#current-player');
  if (state.current) cp.textContent = state.current.name;
  else if (state.phase === 'Anmeldung') cp.textContent = `Spieler ${Math.min(state.players.length + 1, CONFIG.maxPlayers)}`;
  else cp.textContent = '–';

  $('#progress').textContent = state.progress;
  $('#phase-label').textContent = state.phase;
  $('#question-text').textContent = state.questionText;

  // Antwortmöglichkeiten
  const ol = $('#options');
  if (state.options) {
    ol.hidden = false;
    for (const L of LETTERS) {
      const li = ol.querySelector(`[data-letter="${L}"]`);
      li.querySelector('.opt-text').textContent = state.options[L];
      li.className = '';
      if (state.reveal) {
        if (L === state.reveal.correct) li.classList.add('correct');
        else if (L === state.reveal.chosen) li.classList.add('wrong');
        else li.classList.add('dim');
      }
    }
  } else {
    ol.hidden = true;
  }

  // Feedback
  const fb = $('#feedback');
  fb.textContent = state.feedback?.text || '';
  fb.className = `feedback ${state.feedback?.type || ''}`;

  // Punktestand
  const ul = $('#scores');
  ul.replaceChildren();
  if (!state.players.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Noch keine Spieler';
    ul.append(li);
  }
  for (const p of state.players) {
    const li = document.createElement('li');
    if (p === state.current) li.classList.add('current');
    if (p.bump) { li.classList.add('bump'); p.bump = false; }
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.name;
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = punkte(p.score);
    if (p.tie) {
      const tie = document.createElement('span');
      tie.className = 'tie';
      tie.textContent = `+${p.tie} Stich`;
      pts.append(tie);
    }
    li.append(name, pts);
    ul.append(li);
  }
}

function sortedPlayers() {
  return [...state.players].sort((a, b) => (b.score - a.score) || (b.tie - a.tie));
}

function renderResults(leaders = []) {
  const ol = $('#results-list');
  ol.replaceChildren();
  let rank = 0;
  let last = null;
  sortedPlayers().forEach((p, i) => {
    if (p.score !== last) { rank = i + 1; last = p.score; }
    const li = document.createElement('li');
    li.style.animationDelay = `${i * 0.15}s`;
    if (leaders.includes(p)) li.classList.add('leader');
    const r = document.createElement('span'); r.className = 'rank'; r.textContent = `${rank}.`;
    const n = document.createElement('span'); n.className = 'name'; n.textContent = p.name;
    const s = document.createElement('span'); s.className = 'pts'; s.textContent = punkte(p.score);
    li.append(r, n, s);
    ol.append(li);
  });
  $('#results-note').textContent = leaders.length > 1
    ? `Gleichstand an der Spitze – Stichfrage für ${joinNames(leaders.map((p) => p.name))}!`
    : '';
}

function renderVictory(winner) {
  $('#winner-name').textContent = winner.name;
  $('#winner-score').textContent = winner.tie
    ? `${punkte(winner.score)} · Stichfrage gewonnen`
    : punkte(winner.score);
  const ol = $('#victory-scores');
  ol.replaceChildren();
  sortedPlayers().forEach((p) => {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = p.score;
    li.append(`${p.name}: `, b);
    ol.append(li);
  });
  // Animation neu starten
  for (const el of [$('#winner-name'), $('.flight')]) {
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }
}

function award(player, bucket, points) {
  player[bucket] += points;
  player.bump = points > 0;
  render();
}

/* ==========================================================
   Spielablauf
   ========================================================== */
function extractName(raw) {
  let t = String(raw || '').trim()
    .replace(/^(also|äh|ähm|hallo|hi)[ ,]+/i, '')
    .replace(/^(ich bin der|ich bin die|ich hei(ß|ss)e|ich bin|mein name ist|man nennt mich|hier ist|das ist)\s+/i, '')
    .replace(/[.,!?;:"„“]/g, '')
    .trim();
  t = t.split(/\s+/).slice(0, 3).join(' ').slice(0, 24);
  return t.replace(/(^|[\s-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
}

async function registerPlayers() {
  state.phase = 'Anmeldung';
  state.current = null;

  while (state.players.length < CONFIG.maxPlayers) {
    const n = state.players.length + 1;
    state.questionText = n === 1
      ? 'Spieler 1, wie heißt du?'
      : `Spieler ${n}, wie heißt du? – oder sage „fertig“.`;
    state.feedback = { text: 'Sag deinen Namen nach dem Signalton.', type: 'info' };
    state.progress = `${state.players.length} von ${CONFIG.maxPlayers} angemeldet`;
    render();

    const prompt = n === 1
      ? 'Spieler eins, wie heißt du? Sag deinen Namen nach dem Signalton.'
      : `Spieler ${n}, wie heißt du? Wenn alle angemeldet sind, sage: fertig.`;
    const alts = await ask(prompt, {
      retryPrompt: n === 1 ? 'Spieler eins, wie heißt du?' : `Spieler ${n}, wie heißt du? Oder sage: fertig.`,
    });

    if (Intent.done(alts)) {
      if (n === 1) {
        await Speech.speak('Mindestens ein Spieler muss mitspielen. Versuchen wir es noch einmal.');
        continue;
      }
      break;
    }

    let name = extractName(alts[0]);
    if (!name) {
      await Speech.speak('Den Namen habe ich leider nicht verstanden.');
      continue;
    }
    if (state.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      name = `${name} ${n}`;
    }

    state.questionText = `Heißt du ${name}?`;
    state.feedback = { text: 'Sag „ja“ oder „nein“.', type: 'info' };
    render();
    const confirm = await ask(`Ich habe ${name} verstanden. Stimmt das?`, {
      retryPrompt: `Ist ${name} richtig? Sage ja oder nein.`,
      maxTries: 2,
    });
    if (confirm && Intent.no(confirm)) {
      await Speech.speak('Kein Problem, dann noch einmal.');
      continue;
    }

    state.players.push({ name, score: 0, tie: 0, bump: false });
    state.feedback = { text: `${name} ist an Bord!`, type: 'ok' };
    render();
    await Speech.speak(`Willkommen an Bord, ${name}!`);
  }

  const names = state.players.map((p) => p.name);
  if (state.players.length === CONFIG.maxPlayers) {
    await Speech.speak('Das Schiff ist voll besetzt.');
  }
  await Speech.speak(names.length === 1
    ? `Es spielt ${names[0]}. Viel Erfolg!`
    : `Es spielen ${joinNames(names)}. Möge der Bessere gewinnen!`);
}

/**
 * Stellt eine Frage nach den Regeln: frei = 5 Punkte, nach „weiß nicht“ A/B/C = 2 Punkte.
 * @param bucket 'score' (normale Runde) oder 'tie' (Stichfrage)
 */
async function askQuestion(player, q, { label, bucket }) {
  state.current = player;
  state.questionText = q.question;
  state.options = null;
  state.reveal = null;
  state.feedback = { text: 'Freie Antwort: 5 Punkte · „weiß nicht“ → A/B/C für 2 Punkte', type: 'info' };
  render();

  const accepted = [q.answer, ...(q.alternatives || [])];
  const repeatPrompt = `Ich wiederhole die Frage: ${q.question}`;

  let alts = await ask(`${player.name}, du bist dran. ${label} ${q.question}`, {
    retryPrompt: repeatPrompt,
    maxTries: CONFIG.maxListenTries,
  });

  // "wiederholen" → Frage nochmal (zählt nicht als Antwort)
  while (alts && Intent.repeat(alts) && !Text.matchesAny(alts, accepted)) {
    alts = await ask(`Gerne. ${q.question}`, { retryPrompt: repeatPrompt, maxTries: CONFIG.maxListenTries });
  }

  if (!alts) {
    await Speech.speak('Ich konnte leider keine Antwort verstehen. Ich gebe dir drei Möglichkeiten.');
    return choiceRound(player, q, bucket);
  }

  if (Text.matchesAny(alts, accepted)) {
    award(player, bucket, CONFIG.pointsFree);
    state.feedback = { text: `Richtig! ${q.answer} · +${CONFIG.pointsFree} Punkte`, type: 'ok' };
    render();
    Sound.correct();
    await Speech.speak(`${pick(PRAISE)} ${q.answer} ist richtig. Fünf Punkte für ${player.name}.`);
    return;
  }

  if (Intent.dontKnow(alts)) {
    return choiceRound(player, q, bucket);
  }

  state.feedback = { text: `Falsch. Richtig wäre: ${q.answer}`, type: 'bad' };
  render();
  Sound.wrong();
  await Speech.speak(`${pick(COMFORT)} Die richtige Antwort ist: ${q.answer}. Keine Punkte.`);
}

async function choiceRound(player, q, bucket) {
  state.options = q.options;
  state.reveal = null;
  state.feedback = { text: 'Sag A, B oder C – richtig gibt 2 Punkte.', type: 'info' };
  render();

  const optText = LETTERS.map((L) => `${L}: ${q.options[L]}.`).join(' ');
  let alts = await ask(`Hier sind drei Möglichkeiten. ${optText} Was sagst du, A, B oder C?`, {
    retryPrompt: `Bitte sage A, B oder C. ${optText}`,
  });

  let letter = Intent.letter(alts, q.options);
  while (!letter) {
    const prompt = Intent.repeat(alts)
      ? `Gerne noch einmal. ${optText} A, B oder C?`
      : 'Das habe ich nicht als A, B oder C verstanden. Bitte sage nur den Buchstaben: A, B oder C.';
    alts = await ask(prompt, { retryPrompt: `Bitte sage A, B oder C. ${optText}` });
    letter = Intent.letter(alts, q.options);
  }

  state.reveal = { chosen: letter, correct: q.correct };
  const correctText = q.options[q.correct];

  if (letter === q.correct) {
    award(player, bucket, CONFIG.pointsChoice);
    state.feedback = { text: `${letter} ist richtig! +${CONFIG.pointsChoice} Punkte`, type: 'ok' };
    render();
    Sound.correct();
    await Speech.speak(`${letter} ist richtig! ${correctText}. Zwei Punkte für ${player.name}.`);
  } else {
    state.feedback = { text: `${letter} ist falsch. Richtig: ${q.correct} – ${correctText}`, type: 'bad' };
    render();
    Sound.wrong();
    await Speech.speak(`${letter} ist leider falsch. Richtig wäre ${q.correct} gewesen: ${correctText}.`);
  }
}

async function questionRounds() {
  state.phase = 'Fragerunde';
  const total = CONFIG.questionsPerPlayer;
  await Speech.speak(`Die Fragerunde beginnt! Jeder bekommt ${total} Fragen. Wenn du eine Antwort nicht weißt, sage: weiß nicht. Wenn du die Frage noch einmal hören willst, sage: wiederholen.`);

  for (let round = 1; round <= total; round++) {
    for (const p of state.players) {
      state.progress = `Frage ${round} von ${total}`;
      await askQuestion(p, drawQuestion(), { label: `Frage ${round}.`, bucket: 'score' });
    }
    if (round === Math.floor(total / 2) && state.players.length > 1) {
      state.current = null;
      render();
      const standings = sortedPlayers().map((p) => `${p.name} hat ${punkteGesprochen(p.score)}`).join(', ');
      await Speech.speak(`Halbzeit! Zwischenstand: ${standings}.`);
    }
  }
}

async function finale() {
  state.current = null;
  render();

  const top = Math.max(...state.players.map((p) => p.score));
  let leaders = state.players.filter((p) => p.score === top);

  UI.show('results');
  renderResults(leaders);
  const standings = sortedPlayers().map((p) => `${p.name}: ${punkte(p.score)}.`).join(' ');
  await Speech.speak(`Alle Fragen sind gespielt! Hier ist der Endstand. ${standings}`);

  if (leaders.length === 1) return leaders[0];

  await Speech.speak(`Gleichstand an der Spitze zwischen ${joinNames(leaders.map((p) => p.name))} mit je ${punkte(top)}! Jetzt entscheidet die Stichfrage.`);

  UI.show('game');
  state.phase = 'Stichfrage';
  let round = 1;
  while (leaders.length > 1) {
    const gained = new Map();
    for (const p of leaders) {
      const before = p.tie;
      state.progress = `Stichfrage ${round}`;
      await askQuestion(p, drawTiebreak(), { label: '', bucket: 'tie' });
      gained.set(p, p.tie - before);
    }
    const best = Math.max(...leaders.map((p) => gained.get(p)));
    const next = leaders.filter((p) => gained.get(p) === best);
    if (next.length > 1) {
      state.current = null;
      state.questionText = 'Immer noch Gleichstand!';
      state.options = null;
      state.feedback = { text: `Weiter geht's: ${joinNames(next.map((p) => p.name))}`, type: 'info' };
      render();
      await Speech.speak(`Immer noch Gleichstand zwischen ${joinNames(next.map((p) => p.name))}. Es folgt die nächste Stichfrage!`);
    }
    leaders = next;
    round++;
  }
  return leaders[0];
}

async function victory(winner) {
  UI.show('victory');
  renderVictory(winner);
  Sound.fanfare();
  await sleep(900);
  const extra = winner.tie ? ' und der gewonnenen Stichfrage' : '';
  await Speech.speak(state.players.length === 1
    ? `Geschafft! ${winner.name}, du hast ${punkte(winner.score)} erreicht. Möge die Macht mit dir sein!`
    : `Der Sieger ist ${winner.name} mit ${punkte(winner.score)}${extra}! Herzlichen Glückwunsch. Möge die Macht mit dir sein!`);
  UI.caption('Klicke auf „Neues Spiel“, um noch einmal zu spielen.');
}

let running = false;

async function runGame() {
  if (running) return;
  running = true;
  try {
    resetState();
    UI.show('game');
    UI.heard('', false);
    render();
    await Speech.speak('Willkommen beim Star-Wars-Quiz! Bis zu vier Spieler können mitmachen.');
    await registerPlayers();
    await questionRounds();
    const winner = await finale();
    await victory(winner);
  } catch (err) {
    console.error(err);
    showFatal(err instanceof FatalError ? err.message : `Unerwarteter Fehler: ${err.message}`);
  } finally {
    running = false;
  }
}

function showFatal(message) {
  if (Speech.synthesisSupported) speechSynthesis.cancel();
  UI.setMic('idle');
  $('#fatal-text').textContent = message;
  $('#fatal').hidden = false;
}

/* ==========================================================
   Sternenhimmel (Canvas)
   ========================================================== */
const Starfield = (() => {
  const canvas = $('#stars');
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COUNT = 650;
  let w = 0, h = 0, dpr = 1;
  let stars = [];
  let speed = 0.6, target = 0.6;

  function makeStar(randomDepth = true) {
    return {
      x: (Math.random() - 0.5) * w * 2,
      y: (Math.random() - 0.5) * h * 2,
      z: randomDepth ? Math.random() * w : w,
      tw: Math.random() * Math.PI * 2,
      hue: Math.random() < 0.12 ? (Math.random() < 0.5 ? 210 : 50) : 0,
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.width = Math.floor(innerWidth * dpr);
    h = canvas.height = Math.floor(innerHeight * dpr);
    stars = Array.from({ length: COUNT }, () => makeStar(true));
  }

  function frame() {
    speed += (target - speed) * 0.035;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, f = w * 0.5;
    ctx.lineCap = 'round';

    for (const s of stars) {
      const pz = s.z;
      s.z -= speed * dpr * (reduced ? 0.3 : 1);
      if (s.z < 1) { Object.assign(s, makeStar(false)); continue; }
      const sx = cx + (s.x / s.z) * f;
      const sy = cy + (s.y / s.z) * f;
      if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) { Object.assign(s, makeStar(false)); continue; }
      const px = cx + (s.x / pz) * f;
      const py = cy + (s.y / pz) * f;
      const depth = 1 - s.z / w;
      s.tw += 0.04;
      const alpha = Math.min(1, (0.35 + 0.65 * depth) * (0.75 + 0.25 * Math.sin(s.tw)));
      ctx.strokeStyle = s.hue
        ? `hsla(${s.hue}, 90%, 80%, ${alpha})`
        : `rgba(255, 255, 255, ${alpha})`;
      ctx.lineWidth = Math.max(0.6, depth * 2.4 * dpr);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(sx, sy);
      ctx.stroke();
    }
    requestAnimationFrame(frame);
  }

  resize();
  addEventListener('resize', resize);
  requestAnimationFrame(frame);

  return {
    /** kurzer Sprung in den Hyperraum */
    jump() {
      if (reduced) return;
      target = 60;
      setTimeout(() => { target = 0.6; }, 900);
    },
  };
})();

/* ==========================================================
   Start
   ========================================================== */
async function loadQuestions() {
  const res = await fetch('questions.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const valid = (q) => q && q.question && q.answer && q.options && LETTERS.every((L) => q.options[L]) && LETTERS.includes(q.correct);
  if (!Array.isArray(data.questions) || !Array.isArray(data.tiebreakers)) throw new Error('Ungültiges Format');
  data.questions = data.questions.filter(valid);
  data.tiebreakers = data.tiebreakers.filter(valid);
  const needed = CONFIG.maxPlayers * CONFIG.questionsPerPlayer;
  if (data.questions.length < needed) throw new Error(`Zu wenige Fragen (${data.questions.length}, benötigt ${needed})`);
  return data;
}

async function startGame() {
  // Alles, was eine Nutzergeste braucht, synchron im Klick-Handler:
  Sound.init();
  Sound.ctx?.resume?.();
  Speech.prime();
  Sound.ignite();
  Starfield.jump();

  if (!TEST_MODE) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      showFatal('Ohne Mikrofon geht es leider nicht. Bitte erlaube den Mikrofonzugriff (Chrome: Schloss-Symbol in der Adressleiste · iPad: Einstellungen → Safari → Mikrofon) und lade die Seite neu. Das Spiel muss über https:// oder http://localhost geöffnet werden.');
      return;
    }
  }
  runGame();
}

async function init() {
  const btn = $('#btn-start');
  const status = $('#start-status');
  Speech.init();

  if (TEST_MODE) $('#test-input').hidden = false;

  if (!TEST_MODE && !Speech.recognitionSupported) {
    status.textContent = 'Dein Browser unterstützt keine Spracherkennung. Bitte nutze Chrome am Computer oder Safari auf iPad/iPhone (Diktierfunktion einschalten).';
    status.classList.add('error');
    return;
  }
  if (location.protocol === 'file:') {
    status.textContent = 'Bitte öffne das Spiel über GitHub Pages oder einen lokalen Server (siehe README), nicht direkt als Datei.';
    status.classList.add('error');
    return;
  }

  try {
    DATA = await loadQuestions();
    status.textContent = TEST_MODE
      ? `Testmodus · ${DATA.questions.length} Fragen geladen`
      : `${DATA.questions.length} Fragen + ${DATA.tiebreakers.length} Stichfragen bereit · Mikrofon wird benötigt`;
    btn.disabled = false;
  } catch (err) {
    status.textContent = `Die Fragen konnten nicht geladen werden (${err.message}). Ist die Seite über GitHub Pages oder einen lokalen Server geöffnet?`;
    status.classList.add('error');
    return;
  }

  btn.addEventListener('click', startGame);
  $('#btn-again').addEventListener('click', startGame);
  $('#btn-retry').addEventListener('click', () => {
    $('#fatal').hidden = true;
    if (Speech.synthesisSupported) speechSynthesis.cancel();
    UI.show('start');
  });
}

init();
