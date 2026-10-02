/* ============================================================
   Backdrop — the moving colour-splotch background, after AudioBiome /
   Radio Jungle's ground paint.

   Splotches of the theme's colours bloom, wander and fade on the page
   colour. Like the radio's splotch shader they are resolved as a halftone,
   not airbrushed: each splotch's field is quantised into fine levels and
   cut against a 4×4 Bayer matrix, so dots grow from nothing at the edge to
   solid in the middle, in two shades of the splotch's own colour. The
   space is domain-warped (two sine octaves per axis) so edges wobble and
   breathe instead of sliding.

   Cheap on purpose: drawn at 1/PX resolution into one fixed canvas and
   scaled up crisp, capped near 15 fps, paused while the tab is hidden or
   when switched off (then it holds one still frame). Off by default for
   people who've asked their system for reduced motion.

     Backdrop.start()            make the canvas, follow House themes
     Backdrop.options()          { on, speed }
     Backdrop.set({ on, speed }) change and remember
     Backdrop.controls()         an element with the on/off toggle + speed dial
   ============================================================ */
(function () {
  const PX = 6;                 // CSS pixels per backdrop pixel
  const FPS = 15;
  const KEY = "spotify-backup.backdrop";
  const N = 7;                  // splotches alive at once

  // Page colour, a faint dot colour, and the paint colours, per theme.
  const PALETTES = {
    dots:      { base: "#f6f5f1", dot: "#d9d8d2", paint: ["#ff6b6b", "#ffd93d", "#4fc96a", "#4d96ff", "#c77dff", "#ff8fab"] },
    sunset:    { base: "#ffcfa0", dot: "#f4b88a", paint: ["#ff7a59", "#ff4f8b", "#ffb347", "#e45d9c", "#ffd36e"] },
    ocean:     { base: "#a9dff0", dot: "#90cde3", paint: ["#2f7fd8", "#45c4e0", "#5a6fe0", "#3fd6c0", "#1f5fb0"] },
    candy:     { base: "#f7e6f4", dot: "#ead2e6", paint: ["#ff8fc8", "#b39dff", "#8fd3ff", "#ffd36e", "#ff9e9e"] },
    forest:    { base: "#d2e9b8", dot: "#bcdba0", paint: ["#4f9a5c", "#8bcf6a", "#2f6f4a", "#c9d96a", "#6fb07f"] },
    vaporwave: { base: "#e7c2ff", dot: "#d6a9f4", paint: ["#ff71ce", "#01cdfe", "#05ffa1", "#b967ff", "#fffb96"] },
    mint:      { base: "#ecfff6", dot: "#d3f2e4", paint: ["#5ec2a0", "#7fd9b8", "#3fa7a0", "#9fe3f0", "#c6f08a"] },
    night:     { base: "#0a0f0a", dot: "#132a19", paint: ["#33ff66", "#1d8f44", "#2ec4ff", "#7dffa8", "#23b04c"] },
  };

  const hexRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  // Pack to the canvas's native RGBA-in-a-uint32 (little-endian: ABGR).
  const pack = c => (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);

  let canvas = null, ctx = null, img = null, buf32 = null, W = 0, H = 0;
  let cover = null, owner = null;       // per-pixel best coverage and its splotch
  let pal = null, splotches = [], t = 0, last = 0, raf = 0;
  let opts = load();
  const listeners = new Set();

  function load() {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let o = { on: !still, speed: 1 };
    try { o = Object.assign(o, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) { /* storage blocked */ }
    return o;
  }

  function setPalette(themeId) {
    const p = PALETTES[themeId] || PALETTES.dots;
    const base = hexRgb(p.base), dark = themeId === "night";
    pal = {
      base: pack(base), dot: pack(hexRgb(p.dot)),
      // Each paint colour gets its two halftone shades: a soft edge tone
      // and a deeper core, as in the radio's splotches.
      shades: p.paint.map(h => {
        const c = hexRgb(h);
        return [pack(mix(c, base, dark ? 0.45 : 0.35)), pack(c), pack(mix(c, dark ? [0, 0, 0] : [20, 10, 40], 0.28))];
      }),
    };
  }

  // A splotch blooms over `life` seconds then fades and is replaced.
  function spawn(s, fresh) {
    s.x = Math.random() * W; s.y = Math.random() * H;
    s.r = (0.16 + Math.random() * 0.2) * Math.max(W, H);
    s.c = Math.floor(Math.random() * pal.shades.length);
    s.life = 14 + Math.random() * 14;
    s.age = fresh ? Math.random() * s.life : 0;          // the first set starts mid-life
    s.wx = 0.15 + Math.random() * 0.25; s.wy = 0.12 + Math.random() * 0.25;
    s.ph = Math.random() * 6.28;
    s.drift = (Math.random() - 0.5) * 0.08;
  }

  function resize() {
    W = Math.max(8, Math.ceil(innerWidth / PX));
    H = Math.max(8, Math.ceil(innerHeight / PX));
    canvas.width = W; canvas.height = H;
    img = ctx.createImageData(W, H);
    buf32 = new Uint32Array(img.data.buffer);
    cover = new Float32Array(W * H);
    owner = new Int8Array(W * H);
    splotches = Array.from({ length: N }, () => { const s = {}; spawn(s, true); return s; });
    render();
  }

  function render() {
    if (!buf32) return;
    cover.fill(0);
    owner.fill(-1);
    // Domain warp: separable sine offsets, computed once per row/column.
    const warpX = new Float32Array(H), warpY = new Float32Array(W);
    const A = 5 + 2 * Math.sin(t * 0.21);
    for (let y = 0; y < H; y++) warpX[y] = A * Math.sin(y * 0.09 + t * 0.6) + 2 * Math.sin(y * 0.23 - t * 0.9);
    for (let x = 0; x < W; x++) warpY[x] = A * Math.sin(x * 0.08 - t * 0.5) + 2 * Math.sin(x * 0.21 + t * 0.8);

    for (let i = 0; i < splotches.length; i++) {
      const s = splotches[i];
      const k = Math.sin(Math.PI * Math.min(1, s.age / s.life));        // bloom in, fade out
      if (k <= 0.01) continue;
      const cx = s.x + Math.sin(t * s.wx + s.ph) * W * 0.06;
      const cy = s.y + Math.cos(t * s.wy + s.ph) * H * 0.06;
      const r = s.r * (0.55 + 0.45 * k);
      const x0 = Math.max(0, Math.floor(cx - r - 8)), x1 = Math.min(W - 1, Math.ceil(cx + r + 8));
      const y0 = Math.max(0, Math.floor(cy - r - 8)), y1 = Math.min(H - 1, Math.ceil(cy + r + 8));
      const inv = 1 / (r * r);
      for (let y = y0; y <= y1; y++) {
        const wx = warpX[y], row = y * W;
        for (let x = x0; x <= x1; x++) {
          const dx = x + wx - cx, dy = y + warpY[x] - cy;
          const v = (1 - (dx * dx + dy * dy) * inv) * k;
          if (v > cover[row + x]) { cover[row + x] = v; owner[row + x] = i; }
        }
      }
    }

    const base = pal.base, dot = pal.dot;
    for (let y = 0; y < H; y++) {
      const by = (y & 3) * 4, row = y * W;
      for (let x = 0; x < W; x++) {
        const p = row + x, v = cover[p], th = BAYER[by + (x & 3)];
        if (v <= 0 || v * 2.2 < th) {
          // Page colour with the house's faint 1-bit dot grid.
          buf32[p] = ((x % 3) | (y % 3)) === 0 ? dot : base;
          continue;
        }
        // Quantise the field into 16 levels, nudged by the dither so the
        // halftone steps interleave instead of banding.
        const lvl = Math.floor(v * 16 + (th - 0.5) * 1.15) / 16;
        // c may come from a theme with more colours than this one.
        const sh = pal.shades[splotches[owner[p]].c % pal.shades.length];
        buf32[p] = lvl > 0.55 ? sh[2] : lvl > 0.22 ? sh[1] : sh[0];
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function step(dt) {
    t += dt * opts.speed;
    for (const s of splotches) {
      s.age += dt * opts.speed;
      s.x += s.drift * dt * opts.speed * W * 0.1;
      if (s.age >= s.life) spawn(s, false);
    }
  }

  function loop(now) {
    raf = 0;
    if (!opts.on || document.hidden) return;
    const dt = Math.min(0.2, (now - last) / 1000);
    if (now - last >= 1000 / FPS) {
      last = now;
      step(dt);
      render();
    }
    raf = requestAnimationFrame(loop);
  }
  function kick() {
    if (!raf && opts.on && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(loop); }
  }

  function start() {
    if (canvas) return;
    canvas = document.createElement("canvas");
    canvas.className = "backdrop";
    canvas.setAttribute("aria-hidden", "true");
    document.body.prepend(canvas);
    ctx = canvas.getContext("2d");
    setPalette(window.House ? House.currentTheme().id : "dots");
    resize();
    let rt = 0;
    addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(resize, 150); });
    document.addEventListener("visibilitychange", kick);
    document.addEventListener("house:theme", e => { setPalette(e.detail.id); render(); });
    kick();
  }

  function set(next) {
    Object.assign(opts, next);
    try { localStorage.setItem(KEY, JSON.stringify(opts)); } catch (e) { /* storage blocked */ }
    listeners.forEach(fn => fn(opts));
    if (opts.on) kick(); else render();
  }

  /** The on/off toggle and the speed dial, in house style. Any number of
      copies stay in step with each other. */
  function controls() {
    const box = document.createElement("div");
    box.className = "backdrop-controls";
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "pill";
    const knobEl = document.createElement("div");
    box.append(toggleBtn, knobEl);
    House.toggle(toggleBtn, 0.38);
    const label = toggleBtn.querySelector(".pf-label");
    const dial = House.knob(knobEl, {
      min: 0.25, max: 3, step: 0.25, value: opts.speed, hue: 0.11, label: "Background animation speed",
      format: v => "Speed " + v.toFixed(2).replace(/0$/, "").replace(/\.0$/, "") + "×",
      onChange: v => set({ speed: v }),
    });
    const sync = o => {
      label.textContent = o.on ? "Moving: on" : "Moving: off";
      toggleBtn.setAttribute("aria-pressed", String(o.on));
      dial.set(o.speed);
      knobEl.classList.toggle("off", !o.on);
    };
    toggleBtn.addEventListener("click", () => set({ on: !opts.on }));
    listeners.add(sync);
    sync(opts);
    return box;
  }

  window.Backdrop = { start, set, options: () => Object.assign({}, opts), controls, PALETTES };
})();
