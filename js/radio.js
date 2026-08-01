/* ============================================================
   Radio — imported from sampler-web's RadioSampler (js/radio-mic.js).

     ▶ TUNE   → play the selected station through the master bus.
     ◀ / ▶    → previous / next station (retunes live if playing).

   Kept from sampler-web:
     - Full station list (KVCU pinned first, SomaFM reliable tail).
     - Stations auto-purge on error (CORS or network) so the list self-cleans.
     - If MediaElementSource works the stream runs through the Web Audio
       graph (analyser exposed for visuals); if the station blocks CORS we
       fall back to plain <audio> playback.
     - Live oscilloscope of what's on air.

   Dropped: REC / CHOP → pads and mic capture — they target Sample Tab pads
   that don't exist in this app.  `this.analyser` is the hook for driving
   the blob world from the music.
   ============================================================ */

class Radio {
  static STATIONS = [
    // KVCU pinned first — user's local
    { name: "KVCU · Radio 1190 (Boulder)",  url: "https://kvcu.streamguys1.com/live" },
    // College / community, then SomaFM as a reliable fallback tail
    { name: "KEXP 90.3 · U. of Washington",  url: "https://kexp-mp3-128.streamguys1.com/kexp128.mp3" },
    { name: "KCRW 89.9 · Santa Monica",      url: "https://kcrw.streamguys1.com/kcrw_192k_mp3_e24_internet_radio" },
    { name: "WFMU 91.1 · Freeform NJ",        url: "https://stream0.wfmu.org/freeform-128k" },
    { name: "WFMU · Give the Drummer",       url: "https://stream0.wfmu.org/drummer-128k" },
    { name: "KALX 90.7 · UC Berkeley",       url: "https://stream.kalx.berkeley.edu:8443/kalx-128.mp3" },
    { name: "KCSB 91.9 · UC Santa Barbara",  url: "https://streaming.kcsb.org/kcsb-hi" },
    { name: "WKCR 89.9 · Columbia",          url: "https://cpa.streamguys1.com/wkcr-free" },
    { name: "WNYU 89.1 · NYU",               url: "https://streams.wnyu.org/wnyu-hi.mp3" },
    { name: "KDVS 90.3 · UC Davis",          url: "https://archives.kdvs.org/stream" },
    { name: "KSPC 88.7 · Pomona College",    url: "https://kspc.streamguys1.com/live" },
    { name: "KUCI 88.9 · UC Irvine",         url: "https://icecast1.kuci.org/kuci-hi.mp3" },
    { name: "KZSU 90.1 · Stanford",          url: "https://kzsulive.stanford.edu/" },
    { name: "WPRB 103.3 · Princeton",        url: "https://stream.wprb.com/stream/1/" },
    { name: "WMBR 88.1 · MIT",               url: "https://sp.wmbr.org:8002/hi" },
    { name: "KBOO 90.7 · Portland",          url: "https://live.kboo.fm:8443/high" },
    { name: "KPFA 94.1 · Berkeley",          url: "https://streams.kpfa.org/kpfa-96k.mp3" },
    { name: "KGNU 88.5 · Boulder",           url: "https://kgnu-ice.streamguys1.com/kgnu-hi" },
    { name: "WWOZ 90.7 · New Orleans",       url: "https://wwoz-sc.streamguys1.com/wwoz-hi.mp3" },
    // More college / campus stations (dead links self-purge on error).
    { name: "WREK 91.1 · Georgia Tech",      url: "https://streaming.wrek.org/main" },
    { name: "KXLU 88.9 · Loyola Marymount",  url: "https://kxlu.streamguys1.com/kxlu" },
    { name: "WHRB 95.3 · Harvard",           url: "https://stream.whrb.org/whrb-hi.mp3" },
    { name: "CKUT 90.3 · McGill (Montréal)", url: "https://sc0.ckut.ca:8000/CKUT_128k.mp3" },
    { name: "KTRU · Rice University",        url: "https://streaming.ktru.org/ktru" },
    { name: "WVUM 90.5 · U. of Miami",       url: "https://wvum.streamon.fm/WVUM" },
    { name: "WNUR 89.3 · Northwestern",      url: "https://stream.wnur.org/wnur-hi.mp3" },
    { name: "KUOM · Radio K (Minnesota)",    url: "https://streams.kuom.org/kuom_128" },
    { name: "WUSB 90.1 · Stony Brook",       url: "https://sirius.wusb.fm:8000/wusb" },
    // SomaFM tail (always works)
    { name: "SomaFM · Groove Salad",         url: "https://ice1.somafm.com/groovesalad-128-mp3" },
    { name: "SomaFM · Drone Zone",           url: "https://ice1.somafm.com/dronezone-128-mp3" },
    { name: "SomaFM · Indie Pop Rocks",      url: "https://ice1.somafm.com/indiepop-128-mp3" },
    { name: "SomaFM · DEF CON Radio",        url: "https://ice1.somafm.com/defcon-128-mp3" },
    { name: "SomaFM · Lush",                 url: "https://ice1.somafm.com/lush-128-mp3" },
    { name: "SomaFM · Beat Blender",         url: "https://ice1.somafm.com/beatblender-128-mp3" },
    { name: "SomaFM · Secret Agent",         url: "https://ice1.somafm.com/secretagent-128-mp3" },
    { name: "SomaFM · Space Station",        url: "https://ice1.somafm.com/spacestation-128-mp3" },
    { name: "SomaFM · Underground 80s",      url: "https://ice1.somafm.com/u80s-128-mp3" },
  ];

  constructor(engine) {
    this.engine = engine;
    this.audioEl = null;
    this.mediaSrc = null;             // MediaElementAudioSourceNode
    this.analyser = null;             // live FFT/waveform of what's on air
    this.playing = false;             // audio is actually flowing
    this.paused = false;              // user paused; the stream is still tuned
    this.stationIdx = 0;
    // The station list is NEVER spliced. Dead stations are FLAGGED instead, so
    // every index the host app is holding (dropdown rows, the TUNE knob's
    // position, saved selections) stays valid for the life of the page. The old
    // splice-on-error behaviour is what could silently empty the list and leave
    // Play doing nothing at all.
    this.stations = Radio.STATIONS.map(s => ({ ...s, bad: false }));
    this.rootEl = null;
    this._scopeRaf = null;
    this._tuning = false;             // re-entrancy guard for tune()
    this._retries = 0;                // consecutive recovery attempts
    this._watchdog = null;
    this._lastTime = 0;               // audioEl.currentTime at the last check
    this._stallMs = 0;
    this.onState = null;              // host UI hook: fired on every state change
  }

  _emit() { try { this.onState && this.onState(this); } catch (_) {} }

  /** Human-readable state for the host UI. */
  get statusText() {
    if (this.paused)  return "PAUSED";
    if (this.playing) return "ON AIR";
    return "OFF AIR";
  }

  // ---- helpers ------------------------------------------------------
  _status(t)  { const el = this.rootEl?.querySelector(".status"); if (el) el.textContent = t; }
  _info(t)    { const el = this.rootEl?.querySelector(".info");   if (el) el.textContent = t; }
  _setTuneLabel(t) {
    const btn = this.rootEl?.querySelector(".tune-btn");
    if (!btn) return;
    const lbl = btn.querySelector(".pf-label");
    if (lbl) lbl.textContent = t; else btn.textContent = t;
  }
  /** Flag the current station as unreachable WITHOUT changing the list length. */
  _markBad(reason) {
    const st = this.stations[this.stationIdx];
    if (st) st.bad = true;
    this._status(`${reason}`);
    this._emit();
  }

  /** Next station that hasn't failed yet; falls back to plain next if all have. */
  _nextGoodIdx(from) {
    const n = this.stations.length;
    if (!n) return 0;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (!this.stations[i].bad) return i;
    }
    // Everything is flagged — clear the flags and try again from the top rather
    // than dead-ending. A station that failed once may just have been a blip.
    this.stations.forEach(s => (s.bad = false));
    return (from + 1) % n;
  }

  // ---- lifecycle ----------------------------------------------------
  _teardown() {
    this._stopWatchdog();
    try {
      if (this.audioEl) {
        this.audioEl.oncanplay = this.audioEl.onerror = null;
        this.audioEl.pause();
        this.audioEl.removeAttribute("src");
        this.audioEl.load();                 // release the network connection
      }
    } catch (_) {}
    try { this.mediaSrc?.disconnect(); } catch (_) {}
    try { this.analyser?.disconnect(); } catch (_) {}
    this.mediaSrc = this.analyser = null;
    this.audioEl = null;
  }

  // ---- WATCHDOG ------------------------------------------------------
  // A live stream can die without ever firing `error`: the socket goes quiet,
  // currentTime stops advancing, and the element just sits there looking
  // "playing". That silent death is what made the radio need a page reload.
  // This polls for actual PROGRESS and re-tunes when there isn't any.
  _startWatchdog() {
    this._stopWatchdog();
    this._lastTime = -1;
    this._stallMs = 0;
    this._watchdog = setInterval(() => {
      if (!this.playing || this.paused || !this.audioEl) return;
      const t = this.audioEl.currentTime;
      if (t > this._lastTime + 0.01) { this._lastTime = t; this._stallMs = 0; this._retries = 0; return; }
      this._stallMs += 1000;
      if (this._stallMs >= 3000) this._status("reconnecting…");
      if (this._stallMs >= 7000) {
        this._stallMs = 0;
        this._recover("stream stalled");
      }
    }, 1000);
  }
  _stopWatchdog() { if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; } }

  /** Try the same station a couple of times, then move on to the next good one. */
  _recover(reason) {
    this._retries++;
    if (this._retries > 2) {
      this._retries = 0;
      this._markBad(reason);
      this.stationIdx = this._nextGoodIdx(this.stationIdx);
    }
    this.tune();
  }

  async tune() {
    // Re-entrancy guard: two overlapping tunes leave an orphaned <audio> playing
    // under the new one, and the second createMediaElementSource can throw.
    if (this._tuning) return;
    this._tuning = true;
    try {
      await this.engine.ensureStarted();
      const st = this.stations[this.stationIdx];
      if (!st) { this._status("no stations"); this._emit(); return; }
      this._teardown();
      this.paused = false;
      this.playing = false;
      this._status("tuning…");
      this._emit();

      const el = new Audio();
      this.audioEl = el;
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      el.autoplay = true;

      // Listeners go on BEFORE src, so a synchronous failure can't slip past.
      let viaGraph = false;
      let corsRetried = false;

      el.addEventListener("playing", () => {
        if (el !== this.audioEl) return;             // a newer tune superseded us
        this.playing = true; this.paused = false; this._retries = 0;
        this._status(viaGraph ? "ON AIR" : "ON AIR (no scope)");
        this._info(st.name);
        this._setTuneLabel("■ STOP");
        this._startWatchdog();
        this._emit();
      });
      el.addEventListener("pause", () => {
        if (el !== this.audioEl) return;
        // Only the user's pause counts; a pause during teardown does not.
        if (!this.paused) { this.playing = false; this._emit(); }
      });
      el.addEventListener("ended", () => {
        if (el !== this.audioEl) return;
        this._recover("stream ended");
      });
      el.addEventListener("error", () => {
        if (el !== this.audioEl) return;
        if (!corsRetried && viaGraph) {
          // CORS blocked the Web Audio route → replay as plain audio (no scope).
          corsRetried = true;
          try { this.mediaSrc?.disconnect(); this.analyser?.disconnect(); } catch (_) {}
          this.mediaSrc = this.analyser = null;
          viaGraph = false;
          el.crossOrigin = null;
          el.src = st.url;
          el.play().catch(() => this._recover("stream error"));
        } else {
          this._recover("stream error");
        }
      });

      try {
        this.mediaSrc = this.engine.ctx.createMediaElementSource(el);
        this.analyser = this.engine.ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.mediaSrc.connect(this.analyser);
        this.analyser.connect(this.engine.tap);          // audible through master
        viaGraph = true;
      } catch (e) { viaGraph = false; }

      el.src = st.url;
      try { await el.play(); }
      catch (_) {
        // Autoplay policy, or the stream refused. Not fatal: the element stays
        // tuned and the next click on Play resumes it.
        if (el === this.audioEl) { this._status("press play"); this._emit(); }
      }
    } finally {
      this._tuning = false;
    }
  }

  /** True pause: the stream stays tuned and resumes where the live edge is. */
  pause() {
    if (!this.audioEl) return;
    this.paused = true;
    this.playing = false;
    try { this.audioEl.pause(); } catch (_) {}
    this._setTuneLabel("▶ TUNE");
    this._status("PAUSED");
    this._emit();
  }

  /** Resume after pause. If the element died while paused, re-tune instead. */
  resume() {
    if (!this.audioEl || this.audioEl.error || !this.audioEl.src) { this.tune(); return; }
    this.paused = false;
    this.audioEl.play()
      .then(() => { this.playing = true; this._setTuneLabel("■ STOP"); this._status("ON AIR"); this._startWatchdog(); this._emit(); })
      .catch(() => this.tune());          // whatever went wrong, a fresh tune fixes it
  }

  /** The one entry point the UI should call. It ALWAYS does something sensible. */
  togglePlay() {
    if (this.playing) this.pause();
    else if (this.paused || (this.audioEl && !this.audioEl.error)) this.resume();
    else this.tune();
  }

  stop() {
    this._teardown();
    this.playing = false;
    this.paused = false;
    this._setTuneLabel("▶ TUNE");
    this._status("OFF AIR");
    this._emit();
  }

  // ---- UI -----------------------------------------------------------
  _rebuildStationList() {
    const sel = this.rootEl?.querySelector(".station");
    if (!sel) return;
    sel.innerHTML = "";
    this.stations.forEach((s, i) => {
      const o = document.createElement("option");
      o.value = String(i); o.textContent = s.name;
      sel.appendChild(o);
    });
    sel.selectedIndex = Math.min(this.stationIdx, this.stations.length - 1);
  }

  mount(container) {
    const root = document.createElement("div");
    root.className = "radio";
    root.innerHTML = `
      <div class="radio-title">RADIO</div>
      <div class="row">
        <button class="prev-btn" title="Previous station">◀</button>
        <select class="station" title="Pick a station. Stations that fail to load are auto-removed."></select>
        <button class="next-btn" title="Next station">▶</button>
      </div>

      <div class="row">
        <button class="tune-btn" title="Start / stop playback">▶ TUNE</button>
        <span class="status">OFF AIR</span>
      </div>

      <canvas class="scope"></canvas>

      <div class="row">
        <span class="info"></span>
      </div>
    `;
    container.appendChild(root);
    this.rootEl = root;

    this._rebuildStationList();

    // Station navigation
    root.querySelector(".station").addEventListener("change", (e) => {
      this.stationIdx = parseInt(e.target.value, 10);
      if (this.playing) this.tune();
    });
    root.querySelector(".prev-btn").addEventListener("click", () => {
      if (!this.stations.length) return;
      this.stationIdx = (this.stationIdx - 1 + this.stations.length) % this.stations.length;
      root.querySelector(".station").selectedIndex = this.stationIdx;
      if (this.playing) this.tune();
    });
    root.querySelector(".next-btn").addEventListener("click", () => {
      if (!this.stations.length) return;
      this.stationIdx = (this.stationIdx + 1) % this.stations.length;
      root.querySelector(".station").selectedIndex = this.stationIdx;
      if (this.playing) this.tune();
    });

    root.querySelector(".tune-btn").addEventListener("click", () => this.togglePlay());

    // Live oscilloscope of what's on air
    this._startScope();
  }

  _startScope() {
    if (this._scopeRaf) cancelAnimationFrame(this._scopeRaf);
    const cv = this.rootEl?.querySelector(".scope"); if (!cv) return;
    const ctx = cv.getContext("2d");
    let last = 0;
    const draw = (ts) => {
      this._scopeRaf = requestAnimationFrame(draw);
      if (cv.offsetParent === null) return;
      if (ts - last < 40) return; last = ts;
      const w = cv.width = cv.clientWidth || 300;
      const h = cv.height = cv.clientHeight || 60;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(51,255,102,0.22)";   // faint phosphor zero line
      ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
      if (this.analyser) {
        const buf = new Uint8Array(this.analyser.fftSize);
        this.analyser.getByteTimeDomainData(buf);
        ctx.strokeStyle = "#33ff66"; ctx.lineWidth = 1.4;   // green CRT trace
        ctx.beginPath();
        const step = w / buf.length;
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i] / 128 - 1;
          const y = h / 2 + v * (h / 2) * 0.9;
          if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i * step, y);
        }
        ctx.stroke();
      }
    };
    draw();
  }
}

window.Radio = Radio;
