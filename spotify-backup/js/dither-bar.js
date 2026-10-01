/* ============================================================
   DitherBar — the backup progress bar.

   A dark pixel-framed track (house PixelFrame) with a chunky canvas fill
   that flows sideways and fades through a loop of colours. Every blend
   — colour to colour, the gloss on top, the soft leading edge — is an
   ordered (Bayer) dither, never a smooth gradient, so it reads as the
   same 1-bit-ish pixel art as the rest of the house style.

     const bar = DitherBar.create(el);
     bar.set(0.42)   // 42 %
     bar.set(null)   // total unknown: a dithered band sweeps across
   Holds still (but stays coloured) under prefers-reduced-motion, and
   stops animating whenever the bar isn't on screen.
   ============================================================ */
(function () {
  const PX = 3;                    // CSS pixels per dither cell
  const BORDER = 3, R = 7;         // PixelFrame rim
  // Phosphor green → cyan → violet → pink → orange → yellow → back.
  const PALETTE = ["#33ff66", "#2ec4ff", "#8a6dff", "#ff6ec7", "#ffb347", "#ffe45e"];
  const TRACK = "#14161c", TRACK_DOT = "#232733";

  function shade(hex, k) {
    const [r, g, b] = House.rgb(hex);
    const f = v => Math.max(0, Math.min(255, Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k))));
    return [f(r), f(g), f(b)];
  }

  function create(el) {
    new PixelFrame(el, {
      r: R, border: BORDER, outline: "#05060a", frame: "#111111", frameHi: "#2a2d36", frameLo: "#05060a",
      fill: TRACK, fillHi: TRACK, fillLo: TRACK, noGloss: true, noSmudge: true,
    });
    const cv = document.createElement("canvas");
    cv.className = "dither-bar-canvas";
    el.appendChild(cv);
    const ctx = cv.getContext("2d");

    const base = PALETTE.map(c => shade(c, 0));
    const hi = PALETTE.map(c => shade(c, 0.45));     // gloss row
    const lo = PALETTE.map(c => shade(c, -0.35));    // bottom row
    const trackRgb = shade(TRACK, 0), dotRgb = shade(TRACK_DOT, 0);
    const still = matchMedia("(prefers-reduced-motion: reduce)");

    let target = null, shown = 0, raf = 0, t0 = performance.now(), img = null;

    function frame(now) {
      raf = 0;
      if (!el.isConnected || el.offsetParent === null) return;   // hidden: stop until set() again
      const w = Math.max(1, Math.floor((el.clientWidth - 2 * BORDER) / PX));
      const h = Math.max(1, Math.floor((el.clientHeight - 2 * BORDER) / PX));
      if (cv.width !== w || cv.height !== h) {
        cv.width = w; cv.height = h; img = ctx.createImageData(w, h);
        cv.style.width = w * PX + "px"; cv.style.height = h * PX + "px";
      }
      const t = still.matches ? 0 : (now - t0) / 1000;

      // Ease the visible fill toward the real value so jumps look smooth.
      if (target != null) shown += (target - shown) * (still.matches ? 1 : 0.12);
      const fillTo = target == null ? null : shown * w;
      // Unknown total: a band 35 % wide sweeping across every 2.4 s.
      const bandW = w * 0.35;
      const bandX = ((t / 2.4) % 1) * (w + bandW) - bandW;

      const N = PALETTE.length, d = img.data;
      for (let y = 0; y < h; y++) {
        const rowPal = y === 0 ? hi : (y === h - 1 && h > 2) ? lo : base;
        for (let x = 0; x < w; x++) {
          const th = House.bayer(x, y);
          // How "inside the fill" this cell is, 0..1 — softened over 4 cells.
          let inside;
          if (fillTo == null) inside = Math.min(1, Math.max(0, Math.min(x - bandX, bandX + bandW - x) / 4));
          else inside = Math.min(1, Math.max(0, (fillTo - x) / 4));
          let col;
          if (inside > th) {
            // Flowing colour: position along the palette loop, diagonal drift.
            let p = (x * 0.045 + y * 0.06 - t * 0.55) % N;
            if (p < 0) p += N;
            const i = Math.floor(p), f = p - i;
            col = rowPal[f > th ? (i + 1) % N : i];
          } else {
            col = ((x + y) & 3) === 0 ? dotRgb : trackRgb;
          }
          const k = (y * w + x) * 4;
          d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2]; d[k + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      if (!still.matches || (target != null && Math.abs(target - shown) > 0.001)) raf = requestAnimationFrame(frame);
    }

    function kick() { if (!raf) raf = requestAnimationFrame(frame); }

    return {
      set(fraction) {
        if (fraction == null) target = null;
        else {
          if (target == null) shown = 0;
          target = Math.max(0, Math.min(1, fraction));
        }
        el.setAttribute("aria-valuenow", target == null ? "" : String(Math.round(target * 100)));
        if (target == null) el.removeAttribute("aria-valuenow");
        kick();
      },
      reset() { target = null; shown = 0; kick(); },
    };
  }

  window.DitherBar = { create };
})();
