/* ============================================================
   AudioEngine — the shared Web Audio nervous system.

   Routing overview:

     [Sample Pad] ──┐
     [Sample Pad] ──┤     ┌───────────┐          ┌────────────┐
     [Radio  Mic]   ├──> [ tapNode ] ──> [ fx  ] ──> [ master ] ──> destination
     [ ... ]      ──┘                                     └─> analyser (top scope)

   Notes:
   - Every "voice" (pad hit, radio, mic) plugs into `tapNode` — the pre-fx bus.
   - `fx` sits between the tap and master so effects apply to everything.
   - The scope's analyser is fed from either the master (default) OR from a
     specific pad's output when the user clicks a pad — that swap is done by
     `Oscilloscope.watchSource()`, not here.
   - AudioContext creation is deferred until first user gesture, per browser
     autoplay policy; call `AudioEngine.ensureStarted()` on click.
   ============================================================ */

class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.master = null;   // final gain before destination
    this.tap    = null;   // pre-fx bus — everything connects here
    this.fx     = null;   // FxBus wrapper (assigned by fx-bus.js)
    this.analyser = null; // for scope
    this._registeredPads = new Map();   // padId → GainNode (per-pad tap for scope)
    this._started = false;
    this._pendingResolvers = [];
  }

  /**
   * Create the AudioContext and wire the graph.  Must be called from a user
   * gesture (click / keydown) so browsers don't reject autoplay.
   */
  async ensureStarted() {
    if (this._started) return this.ctx;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    this.master   = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.tap      = this.ctx.createGain();
    this.tap.gain.value = 1.0;

    // Analyser sits on master by default — the Oscilloscope module can move it.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;

    // Default routing: tap → master → analyser + destination
    this.tap.connect(this.master);
    this.master.connect(this.analyser);
    this.master.connect(this.ctx.destination);

    // FX will insert themselves between tap and master when fx-bus.js loads,
    // by calling engine.insertFx(inputNode, outputNode).

    if (this.ctx.state === "suspended") {
      try { await this.ctx.resume(); } catch (e) { /* noop */ }
    }
    this._started = true;
    this._pendingResolvers.forEach(r => r(this.ctx));
    this._pendingResolvers = [];
    return this.ctx;
  }

  /** Insert a chain between tap and master.  Called by FxBus. */
  insertFx(inputNode, outputNode) {
    if (!this._started) return;
    try { this.tap.disconnect(this.master); } catch (_) {}
    this.tap.connect(inputNode);
    outputNode.connect(this.master);
    this.fx = { input: inputNode, output: outputNode };
  }

  /** Play a decoded AudioBuffer, tagged with a padId so the scope can follow. */
  playBuffer(buffer, { padId = null, when = 0, gain = 1.0 } = {}) {
    if (!this._started || !buffer) return null;
    const t = when || this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;

    const g = this.ctx.createGain();
    g.gain.value = gain;

    src.connect(g);

    // Per-pad tap so the oscilloscope can watch just this pad.
    let padTap = padId ? this._registeredPads.get(padId) : null;
    if (padId && !padTap) {
      padTap = this.ctx.createGain();
      padTap.gain.value = 1.0;
      padTap.connect(this.tap);
      this._registeredPads.set(padId, padTap);
    }
    g.connect(padTap || this.tap);

    src.start(t);
    return src;
  }

  /** Retrieve the per-pad tap node (creates on demand).  Used by Oscilloscope. */
  padTap(padId) {
    if (!this._started) return null;
    let n = this._registeredPads.get(padId);
    if (!n) {
      n = this.ctx.createGain();
      n.gain.value = 1.0;
      n.connect(this.tap);
      this._registeredPads.set(padId, n);
    }
    return n;
  }

  /** Route a MediaElement (e.g. <audio> for radio) into the master bus. */
  connectMediaElement(el, { padId = null } = {}) {
    if (!this._started) return null;
    const src = this.ctx.createMediaElementSource(el);
    src.connect(padId ? this.padTap(padId) : this.tap);
    return src;
  }

  /** Route a MediaStream (getUserMedia) into the master bus. */
  connectMediaStream(stream, { padId = null } = {}) {
    if (!this._started) return null;
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(padId ? this.padTap(padId) : this.tap);
    return src;
  }

  /** Decode an ArrayBuffer to an AudioBuffer.  Used by drop-to-load. */
  async decode(arrayBuffer) {
    await this.ensureStarted();
    return await this.ctx.decodeAudioData(arrayBuffer);
  }
}

// Singleton — everything downstream imports `audioEngine` off `window`.
window.audioEngine = new AudioEngine();
