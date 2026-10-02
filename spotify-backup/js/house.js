/* ============================================================
   House — the AudioBiome / Radio Jungle chrome in one place.

   Every pixel button and panel is registered here with its own base hue,
   so a background change can rotate the whole set toward that palette —
   the same trick Radio Jungle's applyButtonPalette() plays when you pick
   a world palette. Also owns the shared dark tooltip slab.

     House.button(el, hue)        glossy PixelButton in the muted-pill recipe
     House.toggle(el, hue)        same, sunk + dark when aria-pressed/selected
     House.knob(el, opts)         pixel rotary dial (role=slider)
     House.setLabel(el, text)     relabel a house button safely
     House.plate(el, hue)         button-shaped plate behind non-button text
     House.autoPlate(sel, hueFn)  plate matching elements, including later ones
     House.frame(el, hue, opts)   PixelFrame panel (window, notice, card)
     House.crt(el)                near-black phosphor screen
     House.retint(el, hue)        change one element's base hue
     House.setTheme(id)           background + hue shift, remembered
   ============================================================ */
(function () {
  function hslHex(h, s, l) {
    h = ((h % 1) + 1) % 1;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
      const k = (n + h * 12) % 12;
      const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(c * 255).toString(16).padStart(2, "0");
    };
    return "#" + f(0) + f(8) + f(4);
  }

  // Radio Jungle's muted pill: soft face, coloured rim, dark label.
  function mutedStyle(h) {
    const c = (s, l) => hslHex(h, s, l);
    return {
      frame:   c(0.30, 0.50),
      fill:    c(0.22, 0.80),
      fillHi:  c(0.18, 0.88),
      fillLo:  c(0.32, 0.64),
      outline: c(0.45, 0.16),
      shine:   "#ffffff",
      ink:     c(0.55, 0.13),
      fillOn:  c(0.40, 0.30),   // a selected tab/pill: sunk in, dark face…
      inkOn:   "#ffffff",       // …with white type
    };
  }

  // Backgrounds, named after Radio Jungle's world palettes. `hue` is the
  // palette's base hue; buttons rotate by half of it, as in the house code.
  // The pictures themselves live in index.html as body.bg-<id> rules.
  const THEMES = [
    { id: "dots",      name: "Paper",     hue: null, swatch: ["#ffffff", "#d6d6d6"] },
    { id: "sunset",    name: "Sunset",    hue: 0.02, swatch: ["#ffb38a", "#ff7aa8"] },
    { id: "ocean",     name: "Ocean",     hue: 0.50, swatch: ["#7fd6e8", "#5a86e0"] },
    { id: "candy",     name: "Candy",     hue: 0.90, swatch: ["#ffc2e2", "#b8d8ff"] },
    { id: "forest",    name: "Forest",    hue: 0.28, swatch: ["#a8d98a", "#4f9a5c"] },
    { id: "vaporwave", name: "Vaporwave", hue: 0.83, swatch: ["#ff9de6", "#7ee0ff"] },
    { id: "mint",      name: "Mint",      hue: 0.42, swatch: ["#c9f7e3", "#7fd9b8"] },
    { id: "night",     name: "Night CRT", hue: 0.38, swatch: ["#0a0f0a", "#33ff66"] },
  ];
  const THEME_KEY = "spotify-backup.theme";

  // ---- dithering ----------------------------------------------------------
  // 4x4 Bayer matrix: the ordered-dither pattern used for every gradient
  // here, so blends read as 1-bit pixel art rather than smooth CSS.
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
  // Halftone: a 6×6 clustered-dot screen. Cells are ranked by distance from
  // the centre, so as a value rises a round dot grows outward from the
  // middle of each cell — the printed-comic look — instead of Bayer's
  // even scatter.
  const HALFTONE = (() => {
    const N = 6, c = (N - 1) / 2, cells = [];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) cells.push([Math.hypot(x - c, y - c) + (x + y * N) * 1e-4, x, y]);
    cells.sort((a, b) => a[0] - b[0]);
    const m = new Float32Array(N * N);
    cells.forEach(([, x, y], i) => { m[y * N + x] = (i + 0.5) / (N * N); });
    return m;
  })();
  const DITHER_KEY = "spotify-backup.dither";
  let ditherMode = "bayer";
  try { ditherMode = localStorage.getItem(DITHER_KEY) === "halftone" ? "halftone" : "bayer"; } catch (e) { /* storage blocked */ }
  /** The threshold table in use: { table, n } (an n×n matrix of 0..1). */
  const ditherTable = () => ditherMode === "halftone" ? { table: HALFTONE, n: 6 } : { table: BAYER, n: 4 };
  /** Threshold (0..1) at pixel x,y for the chosen dither — every dithered
      thing in the house style (backdrop, progress bar, swatches, dial) asks here. */
  function bayer(x, y) {
    const { table, n } = ditherTable();
    return table[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
  }
  function setDither(mode) {
    ditherMode = mode === "halftone" ? "halftone" : "bayer";
    try { localStorage.setItem(DITHER_KEY, ditherMode); } catch (e) { /* storage blocked */ }
    registry.forEach(r => r.pb.draw && r.pb.draw());
    document.dispatchEvent(new CustomEvent("house:dither", { detail: ditherMode }));
  }
  const rgb = hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

  /** A pattern that fills `w`×`h` with a diagonal dithered blend a → b,
      drawn in chunky `px`-sized pixels. */
  function ditherPattern(ctx, w, h, a, b, px = 2) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    const A = rgb(a), B = rgb(b);
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const cx = (x / px) | 0, cy = (y / px) | 0;
      const t = (x / w + y / h) / 2;
      const col = t > bayer(cx, cy) ? B : A;
      const i = (y * w + x) * 4;
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return ctx.createPattern(c, "no-repeat");
  }

  // ---- buttons ---------------------------------------------------------------
  /** The AudioBiome button: PixelButton's rounded pixel bevel and drop
      shadow, plus a dithered gloss along the top edge, and an optional
      "selected" state that stays sunk in with a dark face (tabs, pills). */
  class HouseButton extends PixelButton {
    constructor(el, opts) {
      super(el, opts);
      this.selected = false;
      this.ready = true;
      this.draw();
    }
    setSelected(on) {
      if (this.selected === on) return;
      this.selected = on;
      this.draw();
    }
    faceFill() { return this.selected && this.opts.fillOn ? this.opts.fillOn : this.opts.fill; }
    draw() {
      if (!this.ready) return;          // PixelButton's constructor draws before we're set up
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (w < 6 || h < 6) return;
      const wasPressed = this._pressed, fill = this.opts.fill;
      this._pressed = wasPressed || this.selected;
      this.opts.fill = this.faceFill(w, h);
      super.draw();
      this.opts.fill = fill;
      // Dithered gloss: a run of shine pixels along the top-left bevel.
      const o = this._pressed ? 2 : 0, r = this.opts.r, ctx = this.ctx;
      const run = Math.max(0, Math.min(26, Math.floor((w - 2 * r) * 0.45)));
      ctx.fillStyle = this.selected ? "rgba(255,255,255,0.45)" : this.opts.shine;
      for (let x = 0; x < run; x += 2) {
        ctx.fillRect(o + r + x, o + 2, 1, 1);
        if (x < run * 0.6) ctx.fillRect(o + r + x + 1, o + 3, 1, 1);
      }
      for (let y = 0; y < Math.min(6, h - 2 * r); y += 2) ctx.fillRect(o + 2, o + r + y, 1, 1);
      this._pressed = wasPressed;
    }
  }

  const registry = [];      // { el, pb, hue }
  let shift = 0;

  function paint(entry) {
    const s = mutedStyle(entry.hue + shift);
    entry.pb.restyle({ frame: s.frame, fill: s.fill, fillHi: s.fillHi, fillLo: s.fillLo, outline: s.outline,
                       shine: s.shine, fillOn: s.fillOn });
    if (!entry.keepInk) entry.el.style.color = entry.pb.selected ? s.inkOn : s.ink;
  }
  function register(entry) {
    // Forget elements that have left the page (re-rendered lists, cards) —
    // only now and then, because a panel being built isn't attached yet.
    if (registry.length > 400) {
      for (let i = registry.length - 1; i >= 0; i--) if (!registry[i].el.isConnected) registry.splice(i, 1);
    }
    registry.push(entry);
    paint(entry);
    return entry.pb;
  }

  function button(el, hue = 0.5, opts = {}) {
    const big = el.classList.contains("big");
    return register({ el, hue, pb: new HouseButton(el, { r: big ? 12 : 10, border: 4, ...opts }) });
  }

  /** A button with an on/off look (tabs, pills, step markers). It follows
      the element's own aria-pressed / aria-selected / aria-current / .active,
      so code that flips those never has to know about the drawing. */
  function toggle(el, hue = 0.5, opts = {}) {
    const entry = { el, hue, pb: new HouseButton(el, { r: 8, border: 3, ...opts }) };
    const isOn = () => el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-selected") === "true" ||
      el.hasAttribute("aria-current") || el.classList.contains("active");
    entry.pb.selected = isOn();
    register(entry);
    new MutationObserver(() => { entry.pb.setSelected(isOn()); paint(entry); })
      .observe(el, { attributes: true, attributeFilter: ["aria-pressed", "aria-selected", "aria-current", "class"] });
    return entry.pb;
  }

  /** A label plate: the button's bevelled shape behind text that isn't a
      button (titles, headings), so no pixel text floats loose on a panel.
      Never reacts to hover or press. */
  class PlateLabel extends HouseButton {
    draw() {
      this._hover = false;
      this._pressed = false;
      super.draw();
    }
  }
  function plate(el, hue = 0.11, opts = {}) {
    if (el.dataset.plated || !el.textContent.trim()) return null;
    el.dataset.plated = "1";
    el.classList.add("plate");
    return register({ el, hue, pb: new PlateLabel(el, { r: 7, border: 3, ...opts }) });
  }
  /** Plate every element matching a selector, now and whenever one is
      added later (lists and cards are re-rendered). hueFor(el) → hue. */
  function autoPlate(selector, hueFor) {
    const run = root => {
      if (root.matches && root.matches(selector)) plate(root, hueFor(root));
      if (root.querySelectorAll) root.querySelectorAll(selector).forEach(e => plate(e, hueFor(e)));
    };
    run(document.body);
    new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && run(n))))
      .observe(document.body, { childList: true, subtree: true });
  }
  /** A paper panel: a soft bevelled frame behind a block of ordinary text
      (paragraphs, lists), so text never sits bare on a window. */
  function paper(el, hue = 0.13) {
    if (el.dataset.plated || !el.textContent.trim()) return null;
    el.dataset.plated = "1";
    el.classList.add("paper");
    return frame(el, hue, { r: 6, border: 3 });
  }
  /** Paper every element matching a selector, now and when added later. */
  function autoPaper(selector, hue = 0.13) {
    const run = root => {
      if (root.matches && root.matches(selector)) paper(root, hue);
      if (root.querySelectorAll) root.querySelectorAll(selector).forEach(e => paper(e, hue));
    };
    run(document.body);
    new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && run(n))))
      .observe(document.body, { childList: true, subtree: true });
  }

  /** The hue of the nearest framed panel around `el` (so a card's title
      plate matches its card). */
  function hueOf(el, fallback = 0.11) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const e = registry.find(r => r.el === p);
      if (e) return e.hue;
    }
    return fallback;
  }

  /** Change a house button's text without wiping its canvas. */
  function setLabel(el, text) {
    const label = el.querySelector(":scope > .pf-label");
    (label || el).textContent = text;
  }

  /** PixelFrame's look without a full-size canvas. A tall panel's canvas
      was megapixels big and was reallocated and repainted on every resize
      (switching tabs widens the window), which made the Stats tab stutter.
      Instead the frame is drawn once into a small (2S+1)² tile and cut
      into nine pieces: corners stay put, the 1-pixel edge strips and the
      centre stretch (crisply) — the frame only repeats along its edges, so
      it looks the same. Pieces are cached per colour and size. */
  const skinCache = new Map();
  class SkinFrame {
    constructor(el, opts) {
      this.el = el;
      this.opts = Object.assign({
        r: 10, border: 5, outline: "#7a2c50", frame: "#f0a0c8", frameHi: null, frameLo: null,
        fill: "#2a1228", fillHi: "#3c1c3a", fillLo: "#170810", shine: "#ffffff", shineWidth: 44,
      }, opts);
      this.S = 0;
      if (getComputedStyle(el).position === "static") el.style.position = "relative";
      el.style.imageRendering = "pixelated";
      this._ro = new ResizeObserver(() => this.draw());
      this._ro.observe(el);
      this.draw();
    }
    restyle(opts) { Object.assign(this.opts, opts); this.S = 0; this.draw(); }
    pieces(S) {
      const o = this.opts;
      const key = [S, o.r, o.border, o.outline, o.frame, o.fill, o.fillHi, o.fillLo, o.shine, o.noGloss, o.noSmudge].join("|");
      if (skinCache.has(key)) return skinCache.get(key);
      const N = 2 * S + 1;
      const canvas = document.createElement("canvas");
      // Borrow PixelFrame's own drawing code on an off-screen tile.
      const painter = Object.create(PixelFrame.prototype);
      Object.assign(painter, { el: { clientWidth: N, clientHeight: N }, canvas, ctx: canvas.getContext("2d"),
        opts: Object.assign({}, o, {
          frameHi: o.frameHi || PixelFrame.prototype._mix(o.frame, "#ffffff", 0.45),
          frameLo: o.frameLo || PixelFrame.prototype._mix(o.frame, "#000000", 0.45),
        }) });
      painter.draw();
      const cut = (x, y, w, h) => {
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, w, h);
        return "url(" + c.toDataURL() + ")";
      };
      const p = {
        tl: cut(0, 0, S, S), tr: cut(S + 1, 0, S, S), bl: cut(0, S + 1, S, S), br: cut(S + 1, S + 1, S, S),
        t: cut(S, 0, 1, S), b: cut(S, S + 1, 1, S), l: cut(0, S, S, 1), r: cut(S + 1, S, S, 1), c: cut(S, S, 1, 1),
      };
      skinCache.set(key, p);
      return p;
    }
    draw() {
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (w < 8 || h < 8) return;
      const S = Math.max(this.opts.r + 2, Math.min(56, Math.floor(Math.min(w, h) / 2) - 1));
      if (S === this.S) return;          // same size class: the pieces already fit
      this.S = S;
      const p = this.pieces(S), st = this.el.style, s = S + "px", mid = "calc(100% - " + 2 * S + "px)";
      st.backgroundImage = [p.tl, p.tr, p.bl, p.br, p.t, p.b, p.l, p.r, p.c].join(",");
      st.backgroundPosition = "left top,right top,left bottom,right bottom," + s + " top," + s + " bottom,left " + s + ",right " + s + "," + s + " " + s;
      st.backgroundSize = [s + " " + s, s + " " + s, s + " " + s, s + " " + s, mid + " " + s, mid + " " + s, s + " " + mid, s + " " + mid, mid + " " + mid].join(",");
      st.backgroundRepeat = "no-repeat";
      st.backgroundColor = "transparent";
    }
  }

  function frame(el, hue = 0.5, opts = {}) {
    return register({ el, hue, pb: new SkinFrame(el, { r: 10, border: 5, ...opts }) });
  }

  // Not registered: the CRT stays a CRT whatever the background.
  function crt(el) {
    return new PixelFrame(el, {
      r: 6, border: 3, outline: "#111111", frame: "#111111", frameHi: "#111111", frameLo: "#111111",
      fill: "#0a0f0a", fillHi: "#0a0f0a", fillLo: "#0a0f0a", noGloss: true, noSmudge: true,
    });
  }

  function retint(el, hue) {
    const entry = registry.find(r => r.el === el);
    if (entry) { entry.hue = hue; paint(entry); }
  }

  function currentTheme() {
    let id = "dots";
    try { id = localStorage.getItem(THEME_KEY) || "dots"; } catch (e) { /* storage blocked */ }
    return THEMES.find(t => t.id === id) || THEMES[0];
  }

  function setTheme(id) {
    const theme = THEMES.find(t => t.id === id) || THEMES[0];
    THEMES.forEach(t => document.body.classList.toggle("bg-" + t.id, t === theme));
    shift = theme.hue == null ? 0 : theme.hue * 0.5;
    for (let i = registry.length - 1; i >= 0; i--) if (!registry[i].el.isConnected) registry.splice(i, 1);
    registry.forEach(paint);
    try { localStorage.setItem(THEME_KEY, theme.id); } catch (e) { /* storage blocked */ }
    document.dispatchEvent(new CustomEvent("house:theme", { detail: theme }));
  }

  /** Background picker tile: a HouseButton with the background's two
      colours dithered into its face, and a ✓ when chosen. */
  class SwatchButton extends HouseButton {
    constructor(el, colors, hue) {
      super(el, { r: 9, border: 4, ...mutedStyle(hue) });
      this.colors = colors;
      this.draw();
    }
    setSelected(on) {
      if (this.labelEl) this.labelEl.textContent = on ? "✓" : "";
      this.selected = !on;            // force a redraw even if unchanged
      super.setSelected(on);
    }
    faceFill(w, h) { return this.colors ? ditherPattern(this.ctx, w, h, this.colors[0], this.colors[1]) : this.opts.fill; }
  }

  function swatch(el, theme) {
    const pb = new SwatchButton(el, theme.swatch, theme.hue == null ? 0.5 : theme.hue);
    el.style.color = theme.id === "night" ? "#33ff66" : "#111111";
    return pb;
  }

  // ---- dial ------------------------------------------------------------------
  /** A chunky pixel rotary knob, like the radio's volume/tune knobs in Radio
      Jungle. Drag up/down (or sideways), scroll, or use the arrow keys.
      opts: { min, max, step, value, hue, label, format(v), onChange(v) } */
  function knob(el, opts) {
    const o = Object.assign({ min: 0, max: 1, step: 0.05, value: 0.5, hue: 0.11, label: "", format: v => String(v) }, opts);
    const G = 22, SCALE = 2;                  // a 22×22 pixel sprite drawn at 2×
    el.classList.add("knob");
    el.tabIndex = 0;
    el.setAttribute("role", "slider");
    el.setAttribute("aria-label", o.label);
    el.setAttribute("aria-valuemin", String(o.min));
    el.setAttribute("aria-valuemax", String(o.max));
    const cv = document.createElement("canvas");
    cv.width = G; cv.height = G;
    cv.style.width = G * SCALE + "px"; cv.style.height = G * SCALE + "px";
    cv.className = "knob-face";
    const out = document.createElement("span");
    out.className = "knob-value";
    el.append(cv, out);
    const ctx = cv.getContext("2d");
    let value = o.value;

    function draw() {
      const s = mutedStyle(o.hue + shift);
      const [fr, fg, fb] = rgb(s.fill), [lr, lg, lb] = rgb(s.fillLo), [hr, hg, hb] = rgb(s.fillHi);
      const [or, og, ob] = rgb(s.outline), [kr, kg, kb] = rgb(s.frame);
      const img = ctx.createImageData(G, G), d = img.data, c = (G - 1) / 2;
      const t = (value - o.min) / (o.max - o.min);
      const ang = (-135 + t * 270) * Math.PI / 180;
      for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
        const dx = x - c, dy = y - c, r = Math.sqrt(dx * dx + dy * dy);
        let col = null;
        if (r <= c + 0.2) col = [or, og, ob];                                     // rim
        if (r <= c - 1) col = [kr, kg, kb];                                       // coloured ring
        if (r <= c - 3) {
          // Face lit from the top-left, shading resolved by dither.
          const lit = 0.5 - (dx + dy) / (2 * c) * 0.6;
          col = lit > bayer(x, y) + 0.2 ? [hr, hg, hb] : lit < bayer(x, y) - 0.25 ? [lr, lg, lb] : [fr, fg, fb];
        }
        // Tick marks around the ring every 45° of the 270° sweep.
        if (r > c - 3 && r <= c - 1) {
          const a = Math.atan2(dx, -dy) * 180 / Math.PI;
          for (let k = 0; k <= 6; k++) { const ta = -135 + k * 45; if (Math.abs(a - ta) < 7) col = [or, og, ob]; }
        }
        if (col) { const i = (y * G + x) * 4; d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255; }
      }
      // Pointer: a 2-pixel line from the centre toward the value.
      for (let k = 1; k <= c - 4; k += 0.5) {
        const px = Math.round(c + Math.sin(ang) * k), py = Math.round(c - Math.cos(ang) * k);
        for (const [ax, ay] of [[px, py], [px + 1, py]]) {
          if (ax < 0 || ax >= G) continue;
          const i = (py * G + ax) * 4; d[i] = or; d[i + 1] = og; d[i + 2] = ob; d[i + 3] = 255;
        }
      }
      // Gloss pixels, top-left of the face.
      [[6, 5], [8, 4], [10, 4], [5, 7]].forEach(([x, y]) => { const i = (y * G + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = 255; });
      ctx.putImageData(img, 0, 0);
      setLabel(out, o.format(value));     // keeps the readout's plate if it has one
      el.setAttribute("aria-valuenow", String(value));
      el.setAttribute("aria-valuetext", o.format(value));
    }
    function set(v, fire = true) {
      const n = Math.round(Math.min(o.max, Math.max(o.min, v)) / o.step) * o.step;
      value = +n.toFixed(4);
      draw();
      if (fire) o.onChange(value);
    }
    let drag = null;
    cv.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, v: value }; cv.setPointerCapture(e.pointerId); e.preventDefault(); });
    cv.addEventListener("pointermove", e => {
      if (!drag) return;
      const moved = (drag.y - e.clientY) + (e.clientX - drag.x);
      set(drag.v + moved / 120 * (o.max - o.min));
    });
    cv.addEventListener("pointerup", () => { drag = null; });
    cv.addEventListener("wheel", e => { e.preventDefault(); set(value + (e.deltaY < 0 ? o.step : -o.step)); }, { passive: false });
    el.addEventListener("keydown", e => {
      const k = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (k) { e.preventDefault(); set(value + k * o.step); }
      if (e.key === "Home") set(o.min);
      if (e.key === "End") set(o.max);
    });
    document.addEventListener("house:theme", draw);
    draw();
    return { set: v => set(v, false), get: () => value };
  }


  // ---- shared tooltip: one dark pixel slab under whatever has data-tip ----
  let tipEl = null;
  function initTooltip() {
    tipEl = document.createElement("div");
    tipEl.className = "house-tip";
    tipEl.setAttribute("role", "tooltip");
    tipEl.hidden = true;
    const text = document.createElement("span");
    text.className = "house-tip-text";
    tipEl.appendChild(text);
    document.body.appendChild(tipEl);
    const pf = new PixelFrame(tipEl, { r: 6, border: 4 });
    pf.restyle({ frame: "#33363f", frameHi: "#454956", frameLo: "#1b1d24",
                 fill: "#14161c", fillHi: "#1c1f27", fillLo: "#0e1015", outline: "#05060a", shine: "#3a3f4c" });

    let current = null;
    const place = target => {
      current = target;
      text.textContent = target.dataset.tip;
      tipEl.hidden = false;
      const r = target.getBoundingClientRect();
      const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
      let top = r.top - th - 8;
      if (top < 6) top = r.bottom + 8;
      const left = Math.max(6, Math.min(innerWidth - tw - 6, r.left + r.width / 2 - tw / 2));
      tipEl.style.left = left + "px";
      tipEl.style.top = top + "px";
    };
    const hide = () => { tipEl.hidden = true; current = null; };
    document.addEventListener("pointerover", e => {
      const t = e.target.closest && e.target.closest("[data-tip]");
      if (t) place(t); else hide();
    });
    document.addEventListener("focusin", e => {
      const t = e.target.closest && e.target.closest("[data-tip]");
      if (t) place(t); else hide();
    });
    // Keep the slab glued to its bar while the page scrolls under it.
    document.addEventListener("scroll", () => { if (current && current.isConnected) place(current); else hide(); }, true);
    document.addEventListener("keydown", e => { if (e.key === "Escape") hide(); });
  }

  window.House = { hslHex, mutedStyle, THEMES, button, toggle, plate, autoPlate, paper, autoPaper, hueOf, setLabel, frame, crt, retint, setTheme, currentTheme, initTooltip,
                   swatch, knob, bayer, rgb, ditherTable, setDither, dither: () => ditherMode };
})();
