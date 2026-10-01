/* ============================================================
   House — the AudioBiome / Radio Jungle chrome in one place.

   Every pixel button and panel is registered here with its own base hue,
   so a background change can rotate the whole set toward that palette —
   the same trick Radio Jungle's applyButtonPalette() plays when you pick
   a world palette. Also owns the shared dark tooltip slab.

     House.button(el, hue)        PixelButton in the muted-pill recipe
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

  const registry = [];      // { el, pb, hue, kind }
  let shift = 0;

  function paint(entry) {
    const s = mutedStyle(entry.hue + shift);
    entry.pb.restyle({ frame: s.frame, fill: s.fill, fillHi: s.fillHi, fillLo: s.fillLo, outline: s.outline, shine: s.shine });
    entry.el.style.color = s.ink;
  }

  function button(el, hue = 0.5, opts = {}) {
    const big = el.classList.contains("big");
    const entry = { el, hue, pb: new PixelButton(el, { r: big ? 12 : 10, border: 4, ...opts }) };
    registry.push(entry);
    paint(entry);
    return entry.pb;
  }

  function frame(el, hue = 0.5, opts = {}) {
    const entry = { el, hue, pb: new PixelFrame(el, { r: 10, border: 5, ...opts }) };
    registry.push(entry);
    paint(entry);
    return entry.pb;
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
    registry.forEach(paint);
    try { localStorage.setItem(THEME_KEY, theme.id); } catch (e) { /* storage blocked */ }
    document.dispatchEvent(new CustomEvent("house:theme", { detail: theme }));
  }

  // ---- dithering ----------------------------------------------------------
  // 4x4 Bayer matrix: the ordered-dither pattern used for every gradient
  // here, so blends read as 1-bit pixel art rather than smooth CSS.
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
  const bayer = (x, y) => BAYER[(y & 3) * 4 + (x & 3)];
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

  /** Background picker tile: the house PixelButton (rounded bevel, drop
      shadow, sink on press) with the background's two colours dithered
      into its face, a dithered gloss along the top, and a ✓ when chosen. */
  class SwatchButton extends PixelButton {
    constructor(el, colors, hue) {
      super(el, { r: 9, border: 4, ...mutedStyle(hue) });
      this.colors = colors;
      this.selected = false;
      this.draw();
    }
    setSelected(on) {
      this.selected = on;
      if (this.labelEl) this.labelEl.textContent = on ? "✓" : "";
      this.draw();
    }
    draw() {
      if (!this.colors) return;   // PixelButton's constructor draws before we're set up
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (w < 6 || h < 6) return;
      this.opts.fill = ditherPattern(this.ctx, w, h, this.colors[0], this.colors[1]);
      const wasPressed = this._pressed;
      this._pressed = this._pressed || this.selected;     // chosen = sunk in, like a held key
      super.draw();
      // Dithered gloss on the top-left of the face (PixelFrame's shine).
      const ox = this._pressed ? 2 : 0, b = this.opts.border, r = this.opts.r;
      const ctx = this.ctx;
      for (let x = 0; x < Math.min(18, w - 2 * r); x += 2) {
        ctx.fillStyle = this.opts.shine;
        ctx.fillRect(ox + r + x, ox + b + 1, 1, 1);
        if (x < 10) ctx.fillRect(ox + r + x + 1, ox + b + 2, 1, 1);
      }
      ctx.fillRect(ox + b + 1, ox + r, 1, 1);
      ctx.fillRect(ox + b + 1, ox + r + 2, 1, 1);
      this._pressed = wasPressed;
    }
  }

  function swatch(el, theme) {
    const pb = new SwatchButton(el, theme.swatch, theme.hue == null ? 0.5 : theme.hue);
    el.style.color = theme.id === "night" ? "#33ff66" : "#111111";
    return pb;
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

  window.House = { hslHex, mutedStyle, THEMES, button, frame, crt, retint, setTheme, currentTheme, initTooltip,
                   swatch, bayer, rgb };
})();
