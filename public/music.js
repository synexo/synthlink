/**
 * music.js
 *
 * ANSI Music player — plays PC-Speaker-style notes from ANSI music strings.
 *
 * ANSI music syntax (used by BBSes, introduced by IBM BASIC PLAY command):
 *
 *   Tempo:   T<n>          beats per minute (32-255)
 *   Octave:  O<n>          octave number (0-6)
 *   Length:  L<n>          default note length (1=whole, 2=half, 4=quarter, etc.)
 *   Note:    [A-G][#/+/-][<len>][.]
 *   Rest:    P[<len>][.]   or N0
 *   Mode:    MN / ML / MS  (normal / legato / staccato — affects duration fraction)
 *   Music:   MB / MF       (background / foreground — ignored here)
 *
 * We synthesise using a square-wave oscillator (closest to PC Speaker).
 */

export class ANSIMusic {
  constructor() {
    this._ctx     = null;
    this.enabled  = true;
    this._queue   = [];    // array of { freq, dur }
    this._playing = false;
  }

  _getCtx() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Resume if suspended (browser autoplay policy)
    if (this._ctx.state === 'suspended') this._ctx.resume();
    return this._ctx;
  }

  /**
   * Parse and enqueue an ANSI music string for playback.
   * @param {string} str
   */
  play(str) {
    if (!this.enabled || !str) return;
    const notes = this._parse(str);
    if (notes.length === 0) return;
    this._queue.push(...notes);
    if (!this._playing) this._schedule();
  }

  // ── Parser ────────────────────────────────────────────────────

  _parse(str) {
    const notes = [];
    let i = 0;
    let tempo  = 120;
    let length = 4;
    let octave = 4;
    let mode   = 'N'; // N=normal, L=legato, S=staccato

    const s = str.toUpperCase();

    const readInt = () => {
      let n = '';
      while (i < s.length && s[i] >= '0' && s[i] <= '9') n += s[i++];
      return n ? parseInt(n, 10) : null;
    };

    while (i < s.length) {
      const ch = s[i++];

      if (ch === 'T') {
        const v = readInt(); if (v !== null) tempo = Math.max(32, Math.min(255, v));
      } else if (ch === 'O') {
        const v = readInt(); if (v !== null) octave = Math.max(0, Math.min(6, v));
      } else if (ch === 'L') {
        const v = readInt(); if (v !== null && v > 0) length = v;
      } else if (ch === 'M') {
        if (i < s.length) {
          const m = s[i++];
          if (m === 'N' || m === 'L' || m === 'S') mode = m;
          // MB/MF — ignore
        }
      } else if (ch === '>') {
        octave = Math.min(6, octave + 1);
      } else if (ch === '<') {
        octave = Math.max(0, octave - 1);
      } else if (ch >= 'A' && ch <= 'G') {
        // Parse optional accidental
        let sharp = 0;
        if (i < s.length && (s[i] === '#' || s[i] === '+')) { sharp = 1;  i++; }
        else if (i < s.length && s[i] === '-')               { sharp = -1; i++; }

        // Parse optional length override
        const lenOverride = readInt();
        const noteLen = lenOverride ?? length;

        // Parse optional dot (dotted note = 1.5×)
        let dotted = false;
        if (i < s.length && s[i] === '.') { dotted = true; i++; }

        const beatSec = 60 / tempo;
        let dur = beatSec * (4 / noteLen);
        if (dotted) dur *= 1.5;

        // Duration fraction by mode
        const durationFrac = mode === 'L' ? 1.0 : mode === 'S' ? 0.5 : 0.875;

        const freq = this._noteFreq(ch, sharp, octave);
        notes.push({ freq, playDur: dur * durationFrac, totalDur: dur });

      } else if (ch === 'P' || ch === 'N') {
        // Rest (P) or note number (N)
        if (ch === 'N') {
          const n = readInt();
          if (n === 0) {
            // N0 = rest
            const dur = (60 / tempo) * (4 / length);
            notes.push({ freq: 0, playDur: dur, totalDur: dur });
          }
          // N1-84 = MIDI note number — out of scope, skip
        } else {
          const lenOverride = readInt();
          const noteLen = lenOverride ?? length;
          let dotted = false;
          if (i < s.length && s[i] === '.') { dotted = true; i++; }
          let dur = (60 / tempo) * (4 / noteLen);
          if (dotted) dur *= 1.5;
          notes.push({ freq: 0, playDur: dur, totalDur: dur });
        }
      }
    }

    return notes;
  }

  /**
   * Convert note letter + sharp offset + octave to frequency (Hz).
   * C4 = middle C = 261.63 Hz.
   */
  _noteFreq(letter, sharp, octave) {
    // Semitone offsets from C for each note name
    const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const st = semitones[letter];
    if (st === undefined) return 0;
    // MIDI note number: C0 = 12, C4 = 60
    const midi = (octave + 1) * 12 + st + sharp;
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // ── Scheduler ─────────────────────────────────────────────────

  _schedule() {
    if (this._queue.length === 0) { this._playing = false; return; }
    this._playing = true;

    const ctx = this._getCtx();
    let t = ctx.currentTime + 0.02; // small lookahead

    for (const note of this._queue) {
      if (note.freq > 0) {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = note.freq;
        // Amplitude envelope: brief attack, hold, short decay
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.07, t + 0.003);
        gain.gain.setValueAtTime(0.07, t + note.playDur - 0.005);
        gain.gain.linearRampToValueAtTime(0, t + note.playDur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + note.playDur + 0.005);
      }
      t += note.totalDur;
    }

    const totalMs = (t - ctx.currentTime) * 1000 + 100;
    this._queue = [];
    setTimeout(() => { this._playing = false; }, totalMs);
  }
}
