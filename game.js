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
  feedbackMs: 1600,       // so lange bleibt "richtig/falsch" sichtbar, bevor die nächste Frage kommt
};

/** Spielvarianten */
const MODES = {
  classic: 'Klassisch',
  mc: 'Multiple Choice',
};
let gameMode = null; // 'classic' | 'mc'
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
  const digits = (str) => str.replace(/\D/g, '');

  /**
   * Passt eine gesprochene/getippte Antwort zu einer Zielantwort?
   * Zahlen müssen immer exakt stimmen ("500 Jahre" ≠ "900 Jahre").
   * strict: keine Tippfehler-Toleranz (für sehr ähnliche Antworten wie AT-AT / AT-ST).
   */
  function similar(spoken, target, strict = false) {
    const s = tokens(spoken);
    const t = tokens(target);
    if (!s.length || !t.length) return false;
    const tc = t.join('');
    const tol = strict ? 0 : tolerance(tc);
    const close = (candidate) => digits(candidate) === digits(tc) && levenshtein(candidate, tc) <= tol;
    if (close(s.join(''))) return true;
    // Zielantwort irgendwo im Satz? ("ich glaube es war Yoda, oder?")
    for (let w = Math.max(1, t.length - 1); w <= t.length + 1; w++) {
      for (let i = 0; i + w <= s.length; i++) {
        if (close(s.slice(i, i + w).join(''))) return true;
      }
    }
    return false;
  }

  /** Irgendeine Erkennungsalternative passt zu irgendeiner Zielantwort */
  function matchesAny(alts, targets, strict = false) {
    return alts.some((a) => targets.some((t) => similar(a, t, strict)));
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
    const byOptionText = (strict) => {
      for (const alt of alts) {
        const hits = LETTERS.filter((L) => Text.similar(alt, options[L], strict));
        if (hits.length === 1) return hits[0];
      }
      return null;
    };
    // 1) Optionstext exakt genannt ("C-3PO" ist Option B, nicht Buchstabe C)
    const exact = byOptionText(true);
    if (exact) return exact;
    // 2) Buchstabe genannt ("B", "Antwort be", "die zweite")
    for (const alt of alts) {
      const words = Text.basic(alt).split(' ').filter(Boolean)
        .map((w) => ({ eins: '1', zwei: '2', drei: '3' }[w] ?? w));
      const found = new Set();
      for (const L of LETTERS) if (words.some((w) => WORDS[L].includes(w))) found.add(L);
      if (found.size === 1) return [...found][0];
    }
    // 3) Optionstext mit kleinen Tipp-/Erkennungsfehlern ("Hot" → "Hoth")
    return byOptionText(false);
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

  /*
   * Vorlesen läuft über eine Warteschlange und blockiert das Spiel nicht:
   * Man kann jederzeit antworten. Eine Antwort bricht das Vorlesen ab (cancelSpeech).
   */
  _gen: 0,                      // erhöht sich bei jedem Abbruch; ältere Texte werden verworfen
  _chain: Promise.resolve(),
  _pending: 0,

  /** spricht gerade oder hat noch Texte in der Warteschlange */
  get busy() {
    return this._pending > 0 || (this.synthesisSupported && speechSynthesis.speaking);
  },

  /** Text in die Warteschlange stellen; das Promise erfüllt sich, wenn er gesprochen oder abgebrochen wurde */
  speak(text) {
    const gen = this._gen;
    this._pending++;
    const run = this._chain
      .then(() => this._speakNow(text, gen))
      .finally(() => { this._pending--; });
    this._chain = run.catch(() => {});
    return run;
  },

  async _speakNow(text, gen) {
    if (gen !== this._gen) return; // inzwischen abgebrochen
    UI.caption(text);
    UI.setMic('speaking');
    if (TEST_MODE || !this.synthesisSupported) {
      await sleep(TEST_MODE ? 120 : 600);
    } else {
      // In Sätze zerlegen: Chrome bricht sehr lange Utterances sonst nach ~15 s ab
      const parts = text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) || [text];
      for (const p of parts) {
        if (gen !== this._gen) break;
        await this._sentence(p);
      }
    }
    if (gen === this._gen && this._pending <= 1) UI.setMic('idle');
  },

  /** Vorlesen sofort beenden und die Warteschlange leeren */
  cancelSpeech() {
    this._gen++;
    if (this.synthesisSupported) speechSynthesis.cancel();
    UI.setMic('idle');
  },

  /** warten, bis nichts mehr vorgelesen wird (z. B. vor automatischem Zuhören) */
  async _waitIdle() {
    const t0 = Date.now();
    while (this.busy && Date.now() - t0 < 60000) await sleep(100);
  },

  /** Startet die Erkennung sofort (synchron) und liefert {alts, error, quick}. */
  _recognize() {
    return new Promise((resolve) => {
      const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new Rec();
      this._rec = rec;
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
        if (this._rec === rec) this._rec = null;
        UI.setMic('idle');
        if (rec._aborted) { resolve({ alts: null, error: 'aborted' }); return; }
        let alts = finalAlts;
        if (!alts?.length && interim.trim()) alts = [interim.trim()];
        if (alts?.length) UI.heard(alts[0], false);
        else UI.heard('', false);
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
      rec.onerror = (e) => {
        error = e.error;
        diag(`Fehler: ${e.error}`);
        setTimeout(() => { try { rec.abort(); } catch { /* egal */ } finish(); }, 700);
      };
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

  /** laufende Erkennung abbrechen (z. B. weil getippt wurde) */
  abortRecognition() {
    const rec = this._rec;
    if (!rec) return;
    rec._aborted = true;
    try { rec.abort(); } catch { /* egal */ }
  },
  /** laufende Erkennung beenden und Ergebnis übernehmen */
  stopRecognition() { try { this._rec?.stop(); } catch { /* egal */ } },
  get listening() { return !!this._rec; },
};

/* ==========================================================
   Eingabe: Tastatur, Tasten (Weiß nicht / A / B / C) oder Mikrofon
   ========================================================== */
const Input = {
  handsFree: false,   // automatisch nach jeder Frage zuhören
  micBlocked: false,  // Spracherkennung auf diesem Gerät nicht erlaubt
  _wait: null,

  get micAvailable() {
    return !TEST_MODE && Speech.recognitionSupported && !this.micBlocked;
  },

  /** Wartet auf die nächste Antwort. @returns {Promise<{alts: string[]|null, error?: string}>} */
  wait({ choice = false } = {}) {
    return new Promise((resolve) => {
      const w = { choice, done: false };
      w.finish = (res) => {
        if (w.done) return;
        w.done = true;
        this._wait = null;
        Speech.abortRecognition();
        UI.answerBar(false);
        resolve(res);
      };
      this._wait = w;
      UI.note('');
      UI.answerBar(true, { choice });
      if (this.handsFree && this.micAvailable) this._autoListen(w);
    });
  },

  /** Antwort per Tastatur oder Taste */
  text(value) {
    const v = String(value || '').trim();
    if (!this._wait || !v) return false;
    UI.heard(v, false);
    this._wait.finish({ alts: [v] });
    return true;
  },

  /** Mikrofon angetippt: startet die Erkennung direkt im Tipp-Ereignis (nötig für Safari) */
  micTap() {
    const w = this._wait;
    if (!w || !this.micAvailable) return;
    if (Speech.listening) { Speech.stopRecognition(); return; }
    Speech.cancelSpeech();
    this._listen(w, false);
  },

  async _autoListen(w) {
    await Speech._waitIdle();
    await sleep(200);
    Sound.listen();
    await sleep(260); // Signalton nicht mit aufnehmen
    if (w.done || Speech.listening) return;
    this._listen(w, true);
  },

  async _listen(w, auto) {
    UI.note('');
    const res = await Speech._recognize();
    if (w.done) return;
    if (res.alts?.length) { w.finish(res); return; }

    const e = res.error;
    if (auto && e === 'not-allowed') {
      // automatisches Zuhören braucht in manchen Browsern ein Antippen
      this.handsFree = false;
      UI.note('Automatisches Zuhören klappt hier nicht – tippe aufs Mikrofon oder gib die Antwort ein.');
      return;
    }
    if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e)) {
      this.micBlocked = true;
      this.handsFree = false;
      UI.updateMicButton();
      UI.note('Spracheingabe ist auf diesem Gerät nicht freigegeben – bitte tippe deine Antwort ein.');
      return;
    }
    if (e === 'network') {
      this.handsFree = false;
      UI.note('Die Spracherkennung ist gerade nicht erreichbar – bitte tippe deine Antwort ein.');
      return;
    }
    if (auto) { w.finish({ alts: null, error: e }); return; } // Frage wird freundlich wiederholt
    UI.note('Nichts verstanden – tippe noch einmal aufs Mikrofon oder gib die Antwort ein.');
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
 * Liest einen Text vor und wartet auf eine Antwort (Tastatur, Taste oder Mikrofon).
 * Nur beim freihändigen Zuhören kann "nichts verstanden" vorkommen; dann wird freundlich wiederholt.
 * @returns {Promise<string[]|null>} Antwort(en) oder null nach maxTries Fehlversuchen
 */
async function ask(prompt, { retryPrompt = prompt, maxTries = Infinity, choice = false } = {}) {
  Speech.speak(prompt); // nicht abwarten: Antworten sind sofort möglich
  for (let tries = 1; ; tries++) {
    const { alts } = await Input.wait({ choice });
    Speech.cancelSpeech(); // Antwort da → Vorlesen abbrechen, weiter geht's
    if (alts?.length) return alts;
    if (tries >= maxTries) return null;
    Speech.speak(`${pick(SORRY)} ${retryPrompt}`);
  }
}

/** Rückmeldung vorlesen, kurz sichtbar lassen und weitermachen (Vorlesen läuft im Hintergrund weiter) */
async function announce(text) {
  Speech.speak(text);
  await sleep(TEST_MODE ? 40 : CONFIG.feedbackMs);
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
    const labels = { idle: 'Bereit', speaking: 'Spricht …', listening: 'Hört zu …' };
    $('#mic').dataset.state = mode;
    $('#btn-mic').classList.toggle('listening', mode === 'listening');
    $('#mic-label').textContent = labels[mode] || '';
  },
  caption(text) { $('#caption').textContent = text; },
  /** Antwortleiste aktivieren/deaktivieren */
  answerBar(active, { choice = false } = {}) {
    const form = $('#answer-form');
    form.classList.toggle('waiting', !active);
    form.querySelectorAll('button').forEach((b) => { b.disabled = !active; });
    $('#btn-dontknow').hidden = choice;
    const input = $('#answer-text');
    input.placeholder = choice ? 'A, B oder C …' : 'Deine Antwort …';
    $('#options').classList.toggle('pickable', active && choice);
    this.updateMicButton();
    if (active && !IS_IOS) input.focus({ preventScroll: true });
  },
  updateMicButton() { $('#btn-mic').hidden = !Input.micAvailable; },
  note(text) { $('#answer-note').textContent = text; },
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
/** Namen aus dem Startformular: getrimmt, ohne Leerfelder, doppelte Namen nummeriert */
let playerCount = 0; // auf dem Startbildschirm gewählte Anzahl (1–4)

/** sichtbare Namensfelder für die gewählte Spielerzahl */
function activeNameInputs() {
  return [...document.querySelectorAll('.name-input')].slice(0, playerCount);
}

/** Spielerzahl wählen: passende Anzahl Namensfelder einblenden */
function setPlayerCount(n) {
  playerCount = n;
  document.querySelectorAll('.count-btn').forEach((b) => {
    const on = Number(b.dataset.count) === n;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-checked', String(on));
  });
  const inputs = [...document.querySelectorAll('.name-input')];
  inputs.forEach((input, i) => {
    input.hidden = i >= n;
    input.enterKeyHint = i === n - 1 ? 'go' : 'next';
  });
  $('#names-block').hidden = false;
  document.querySelector('.name-grid').classList.toggle('single', n === 1);
  const status = $('#start-status');
  status.classList.remove('error');
  const firstEmpty = inputs.slice(0, n).find((i) => !i.value.trim()) || inputs[0];
  if (!IS_IOS) firstEmpty.focus();
}

/** Namen der gewählten Spieler: leere Felder heißen "Spieler n", doppelte Namen werden nummeriert */
function readNames() {
  const names = [];
  activeNameInputs().forEach((input, idx) => {
    let name = input.value.trim().replace(/\s+/g, ' ').slice(0, 24) || `Spieler ${idx + 1}`;
    const base = name;
    for (let i = 2; names.some((n) => n.toLowerCase() === name.toLowerCase()); i++) name = `${base} ${i}`;
    names.push(name);
  });
  return names;
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
  while (alts && Intent.repeat(alts) && !Text.matchesAny(alts, accepted, !!q.strict)) {
    alts = await ask(`Gerne. ${q.question}`, { retryPrompt: repeatPrompt, maxTries: CONFIG.maxListenTries });
  }

  if (!alts) {
    Speech.speak('Ich konnte leider keine Antwort verstehen. Ich gebe dir drei Möglichkeiten.');
    return choiceRound(player, q, bucket);
  }

  if (Text.matchesAny(alts, accepted, !!q.strict)) {
    award(player, bucket, CONFIG.pointsFree);
    state.feedback = { text: `Richtig! ${q.answer} · +${CONFIG.pointsFree} Punkte`, type: 'ok' };
    render();
    Sound.correct();
    await announce(`${pick(PRAISE)} ${q.answer} ist richtig. Fünf Punkte für ${player.name}.`);
    return;
  }

  if (Intent.dontKnow(alts)) {
    return choiceRound(player, q, bucket);
  }

  state.feedback = { text: `„${alts[0]}“ ist falsch. Richtig wäre: ${q.answer}`, type: 'bad' };
  render();
  Sound.wrong();
  await announce(`${pick(COMFORT)} Die richtige Antwort ist: ${q.answer}. Keine Punkte.`);
}

/**
 * A/B/C-Runde (2 Punkte).
 * Klassisch: nach „weiß nicht“. Multiple Choice: direkt als Frage – dann mit `intro` (Spieler + Frage).
 */
async function choiceRound(player, q, bucket, { intro = '' } = {}) {
  state.current = player;
  state.questionText = q.question;
  state.options = q.options;
  state.reveal = null;
  state.feedback = { text: 'Wähle A, B oder C – richtig gibt 2 Punkte.', type: 'info' };
  render();

  const optText = LETTERS.map((L) => `${L}: ${q.options[L]}.`).join(' ');
  const prompt = intro
    ? `${intro} ${optText}`
    : `Hier sind drei Möglichkeiten. ${optText} Welche nimmst du: A, B oder C?`;
  let alts = await ask(prompt, {
    retryPrompt: `Bitte wähle A, B oder C. ${optText}`,
    choice: true,
  });

  let letter = Intent.letter(alts, q.options);
  while (!letter) {
    const prompt = Intent.repeat(alts)
      ? `Gerne noch einmal. ${optText} A, B oder C?`
      : 'Das habe ich nicht als A, B oder C erkannt. Bitte wähle A, B oder C.';
    alts = await ask(prompt, { retryPrompt: `Bitte wähle A, B oder C. ${optText}`, choice: true });
    letter = Intent.letter(alts, q.options);
  }

  state.reveal = { chosen: letter, correct: q.correct };
  const correctText = q.options[q.correct];

  if (letter === q.correct) {
    award(player, bucket, CONFIG.pointsChoice);
    state.feedback = { text: `${letter} ist richtig! +${CONFIG.pointsChoice} Punkte`, type: 'ok' };
    render();
    Sound.correct();
    await announce(`${letter} ist richtig! ${correctText}. Zwei Punkte für ${player.name}.`);
  } else {
    state.feedback = { text: `${letter} ist falsch. Richtig: ${q.correct} – ${correctText}`, type: 'bad' };
    render();
    Sound.wrong();
    await announce(`${letter} ist leider falsch. Richtig wäre ${q.correct} gewesen: ${correctText}.`);
  }
}

/** eine Frage je nach Spielvariante stellen */
function playQuestion(player, q, { label, bucket }) {
  if (gameMode === 'mc') {
    const intro = `${player.name}, du bist dran. ${label} ${q.question}`.replace(/\s+/g, ' ');
    return choiceRound(player, q, bucket, { intro });
  }
  return askQuestion(player, q, { label, bucket });
}

async function questionRounds() {
  state.phase = gameMode === 'mc' ? 'Multiple Choice' : 'Fragerunde';
  const total = CONFIG.questionsPerPlayer;
  let how;
  if (gameMode === 'mc') {
    how = Input.micAvailable
      ? 'Tippe auf A, B oder C, oder sag den Buchstaben.'
      : 'Tippe auf A, B oder C.';
    Speech.speak(`Die Fragerunde beginnt! Jeder bekommt ${total} Fragen mit je drei Antworten. ${how} Du kannst jederzeit antworten, auch während ich noch spreche.`);
  } else {
    how = Input.handsFree
      ? 'Sprich deine Antwort nach dem Signalton, oder tippe sie ein.'
      : Input.micAvailable
        ? 'Tippe deine Antwort ein, oder tippe auf das Mikrofon und sprich.'
        : 'Tippe deine Antwort ein.';
    Speech.speak(`Die Fragerunde beginnt! Jeder bekommt ${total} Fragen. ${how} Wenn du es nicht weißt, wähle: weiß nicht. Du kannst jederzeit antworten, auch während ich noch spreche.`);
  }

  for (let round = 1; round <= total; round++) {
    for (const p of state.players) {
      state.progress = `Frage ${round} von ${total}`;
      await playQuestion(p, drawQuestion(), { label: `Frage ${round}.`, bucket: 'score' });
    }
    if (round === Math.floor(total / 2) && state.players.length > 1) {
      const standings = sortedPlayers().map((p) => `${p.name} hat ${punkteGesprochen(p.score)}`).join(', ');
      Speech.speak(`Halbzeit! Zwischenstand: ${standings}.`);
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
      await playQuestion(p, drawTiebreak(), { label: '', bucket: 'tie' });
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
      await announce(`Immer noch Gleichstand zwischen ${joinNames(next.map((p) => p.name))}. Es folgt die nächste Stichfrage!`);
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
  UI.caption('Tippe auf „Neues Spiel“, um noch einmal zu spielen.');
}

let running = false;

async function runGame(names) {
  if (running) return;
  running = true;
  try {
    resetState();
    state.players = names.map((name) => ({ name, score: 0, tie: 0, bump: false }));
    state.phase = gameMode === 'mc' ? 'Multiple Choice' : 'Fragerunde';
    UI.show('game');
    UI.heard('', false);
    UI.note('');
    UI.diag('');
    UI.answerBar(false);
    render();
    Speech.speak(names.length === 1
      ? `Willkommen beim Star-Wars-Quiz, ${names[0]}! Viel Erfolg!`
      : `Willkommen beim Star-Wars-Quiz! Es spielen ${joinNames(names)}. Möge der Bessere gewinnen!`);
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

/** Schritt 1 → 2: Spielvariante gewählt */
function setMode(mode) {
  gameMode = mode;
  $('#mode-label').textContent = MODES[mode];
  $('#mode-step').hidden = true;
  $('#start-form').hidden = false;
  $('#start-status').classList.remove('error');
  const handsfreeAllowed = Input.micAvailable && !IS_IOS && mode === 'classic';
  $('#handsfree-row').hidden = !handsfreeAllowed;
  if (!handsfreeAllowed) $('#handsfree').checked = false;
}

/** zurück zu Schritt 1 */
function showModeStep() {
  $('#start-form').hidden = true;
  $('#mode-step').hidden = false;
}

function startGame() {
  const status = $('#start-status');
  if (!gameMode) { showModeStep(); return; }
  if (!playerCount) {
    status.textContent = 'Bitte wähle zuerst, wie viele Spieler mitspielen.';
    status.classList.add('error');
    return;
  }
  const names = readNames();
  status.classList.remove('error');

  // Alles, was eine Nutzergeste braucht, synchron im Klick-Handler:
  Sound.init();
  Sound.ctx?.resume?.();
  Speech.prime();
  Sound.ignite();
  Starfield.jump();

  Input.handsFree = $('#handsfree').checked && Input.micAvailable;
  runGame(names);
}

async function init() {
  const btn = $('#btn-start');
  const status = $('#start-status');
  Speech.init();

  if (location.protocol === 'file:') {
    status.textContent = 'Bitte öffne das Spiel über GitHub Pages oder einen lokalen Server (siehe README), nicht direkt als Datei.';
    status.classList.add('error');
    return;
  }

  // Freihändig wird erst nach der Moduswahl angeboten (nur Klassisch, nicht iPad/iPhone)
  $('#handsfree-row').hidden = true;
  document.querySelectorAll('.mode-card').forEach((b) =>
    b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#btn-mode-change').addEventListener('click', showModeStep);

  try {
    DATA = await loadQuestions();
    const how = Input.micAvailable ? 'Antworten per Tastatur oder Mikrofon' : 'Antworten per Tastatur';
    status.textContent = `${DATA.questions.length} Fragen + ${DATA.tiebreakers.length} Stichfragen bereit · ${how}`;
    btn.disabled = false;
  } catch (err) {
    status.textContent = `Die Fragen konnten nicht geladen werden (${err.message}). Ist die Seite über GitHub Pages oder einen lokalen Server geöffnet?`;
    status.classList.add('error');
    return;
  }

  // Startformular: erst Spielerzahl wählen, dann Namen; Enter springt zum nächsten Feld
  document.querySelectorAll('.count-btn').forEach((b) =>
    b.addEventListener('click', () => setPlayerCount(Number(b.dataset.count))));
  document.querySelectorAll('.name-input').forEach((input, i) => input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || i >= playerCount - 1) return;
    e.preventDefault();
    document.querySelectorAll('.name-input')[i + 1].focus();
  }));
  $('#start-form').addEventListener('submit', (e) => { e.preventDefault(); startGame(); });

  // Antworten
  $('#answer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#answer-text');
    if (Input.text(input.value)) input.value = '';
  });
  $('#btn-mic').addEventListener('click', () => Input.micTap());
  $('#mic').addEventListener('click', () => Input.micTap());
  document.querySelectorAll('.chip[data-cmd]').forEach((b) =>
    b.addEventListener('click', () => Input.text(b.dataset.cmd)));
  document.querySelectorAll('#options li').forEach((li) => {
    const choose = () => { if (Input._wait?.choice) Input.text(li.dataset.letter); };
    li.addEventListener('click', choose);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
    });
  });

  $('#btn-again').addEventListener('click', () => { Speech.cancelSpeech(); UI.show('start'); });
  $('#btn-retry').addEventListener('click', () => {
    $('#fatal').hidden = true;
    Speech.cancelSpeech();
    UI.show('start');
  });
}

init();
