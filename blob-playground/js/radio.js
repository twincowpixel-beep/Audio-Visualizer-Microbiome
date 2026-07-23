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
    this.playing = false;
    this.stationIdx = 0;
    this.stations = [...Radio.STATIONS];   // mutable copy (auto-purge)
    this.rootEl = null;
    this._scopeRaf = null;
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
  _purgeCurrent(reason) {
    const st = this.stations[this.stationIdx];
    if (!st) return;
    this.stations.splice(this.stationIdx, 1);
    if (this.stationIdx >= this.stations.length) this.stationIdx = 0;
    this._rebuildStationList();
    this._status(`${reason} — removed`);
  }

  // ---- lifecycle ----------------------------------------------------
  _teardown() {
    try { if (this.audioEl) { this.audioEl.pause(); this.audioEl.src = ""; } } catch (_) {}
    try { this.mediaSrc?.disconnect(); } catch (_) {}
    try { this.analyser?.disconnect(); } catch (_) {}
    this.mediaSrc = this.analyser = null;
  }

  async tune() {
    await this.engine.ensureStarted();
    const st = this.stations[this.stationIdx];
    if (!st) { this._status("no stations"); return; }
    this._teardown();
    this._status("tuning…");

    this.audioEl = new Audio();
    this.audioEl.crossOrigin = "anonymous";
    this.audioEl.preload = "auto";
    this.audioEl.src = st.url;

    let viaGraph = false;
    try {
      this.mediaSrc = this.engine.ctx.createMediaElementSource(this.audioEl);
      this.analyser = this.engine.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.mediaSrc.connect(this.analyser);
      this.analyser.connect(this.engine.tap);          // audible through master
      viaGraph = true;
    } catch (e) { viaGraph = false; }

    let corsFailed = false;
    this.audioEl.addEventListener("playing", () => {
      this.playing = true;
      this._status("ON AIR");
      this._info(st.name);
      this._setTuneLabel("■ STOP");
    });
    this.audioEl.addEventListener("error", () => {
      if (!corsFailed && viaGraph) {
        // CORS failed → retry playback-only, keep station (no analyser)
        corsFailed = true; this._teardown();
        this.audioEl = new Audio();
        this.audioEl.src = st.url;
        this.audioEl.play()
          .then(() => { this.playing = true; this._info(st.name); this._status("ON AIR (no scope)"); this._setTuneLabel("■ STOP"); })
          .catch(() => { this._purgeCurrent("STREAM ERROR"); });
      } else {
        this._purgeCurrent("STREAM ERROR");
      }
    });

    try { await this.audioEl.play(); }
    catch (_) { this._status("tap TUNE again to start"); }
  }

  stop() {
    try { this.audioEl?.pause(); } catch (_) {}
    this.playing = false;
    this._setTuneLabel("▶ TUNE");
    this._status("OFF AIR");
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

    root.querySelector(".tune-btn").addEventListener("click", () => {
      if (this.playing) this.stop(); else this.tune();
    });

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
