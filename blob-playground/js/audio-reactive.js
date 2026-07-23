/* ============================================================
   AudioReactive — turns the radio's live analyser into a few simple
   numbers the blob world can dance to.

   Exposes, updated once per frame:
     level      0..1  overall loudness (smoothed)
     bass       0..1  low-band energy   (kick / bass)
     mid        0..1  mid-band energy   (vocals / body)
     treble     0..1  high-band energy  (hats / air)
     pitch      0..1  normalized dominant frequency bin
     beat       bool  true on the single frame a beat is detected
     beatPulse  1..0  decays after each beat (for flashes / glows)

   Beat detection is a classic adaptive-threshold onset on the bass band:
   compare instantaneous bass against a rolling local average; a spike well
   above average (and above a noise floor, throttled by a refractory period)
   counts as a beat.  When no analyser is present everything decays to 0, so
   the world falls back to its calm idle behavior with zero coupling.

   The analyser is pulled lazily from `window.radio.analyser` each frame, so
   this module doesn't care when the radio is created or retuned.
   ============================================================ */

class AudioReactive {
  constructor() {
    this.analyser = null;
    this.freq = null;      // Uint8Array frequency data

    this.level = 0;
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;
    this.pitch = 0;

    this.beat = false;
    this.beatPulse = 0;

    // Tempo tracking — interval between beats and a 0..1 phase that ramps
    // between them, so choreography can lock to the song's pulse.
    this.beatInterval = 0.5;   // seconds/beat (~120 BPM default)
    this.beatPhase = 0;        // 0 at a beat → 1 just before the next

    this._bassHistory = [];
    this._lastBeatMs = 0;
  }

  _setAnalyser(a) {
    this.analyser = a;
    this.freq = a ? new Uint8Array(a.frequencyBinCount) : null;
    this._bassHistory.length = 0;
  }

  get active() { return !!this.analyser; }

  update(dt) {
    this.beat = false;
    this.beatPulse = Math.max(0, this.beatPulse - dt * 3.5);

    const a = (window.radio && window.radio.analyser) || null;
    if (a !== this.analyser) this._setAnalyser(a);

    if (!this.analyser) {
      // No signal — bleed all metrics back to rest.
      this.level  *= 0.9;
      this.bass   *= 0.9;
      this.mid    *= 0.9;
      this.treble *= 0.9;
      return;
    }

    this.analyser.getByteFrequencyData(this.freq);
    const bins = this.freq.length;
    const bassEnd = Math.max(1, Math.floor(bins * 0.08));
    const midEnd  = Math.max(bassEnd + 1, Math.floor(bins * 0.40));

    let bassSum = 0, midSum = 0, trebleSum = 0, total = 0;
    let maxV = 0, maxI = 0;
    for (let i = 0; i < bins; i++) {
      const raw = this.freq[i];
      const v = raw / 255;
      total += v;
      if (i < bassEnd) bassSum += v;
      else if (i < midEnd) midSum += v;
      else trebleSum += v;
      if (raw > maxV) { maxV = raw; maxI = i; }
    }

    const bass   = bassSum   / bassEnd;
    const mid    = midSum    / (midEnd - bassEnd);
    const treble = trebleSum / (bins - midEnd);
    const level  = total / bins;
    const pitch  = maxI / bins;

    // Smooth the continuous metrics (level snappier than the bands).
    this.bass   += (bass   - this.bass)   * 0.35;
    this.mid    += (mid    - this.mid)    * 0.35;
    this.treble += (treble - this.treble) * 0.35;
    this.level  += (level  - this.level)  * 0.5;
    this.pitch  += (pitch  - this.pitch)  * 0.2;

    // --- adaptive beat detection on the instantaneous bass energy ---
    const hist = this._bassHistory;
    hist.push(bass);
    if (hist.length > 43) hist.shift();          // ~0.7s of history at 60fps
    let avg = 0;
    for (let i = 0; i < hist.length; i++) avg += hist[i];
    avg /= hist.length;

    const now = performance.now();
    const threshold = avg * 1.35 + 0.02;
    if (bass > threshold && bass > 0.10 && (now - this._lastBeatMs) > 120) {
      this.beat = true;
      this.beatPulse = 1.0;
      // Learn the tempo from the gap since the last beat (clamped to a
      // musically-plausible 0.28–1.1s → ~55–215 BPM).
      if (this._lastBeatMs > 0) {
        const iv = (now - this._lastBeatMs) / 1000;
        if (iv > 0.28 && iv < 1.1) this.beatInterval += (iv - this.beatInterval) * 0.25;
      }
      this._lastBeatMs = now;
    }

    // Phase ramps 0→1 across one beat interval (holds at 1 if a beat is late).
    this.beatPhase = this._lastBeatMs > 0
      ? Math.min(1, ((now - this._lastBeatMs) / 1000) / Math.max(0.1, this.beatInterval))
      : 0;
  }
}

window.AudioReactive = AudioReactive;
