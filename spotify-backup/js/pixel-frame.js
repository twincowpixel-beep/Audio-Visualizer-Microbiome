/* ============================================================
   PixelFrame — draws an EarthBound-style rounded, bevelled, dithered
   pixel-art border into any HTMLElement, rendered as a background <canvas>.

   Layers, outer → inner (concentric so corner arcs are parallel):
     1. dark outline  (1 px at radius r)
     2. bright frame  (from `--pf-frame`, thickness `border`)
     3. dark interior (from `--pf-fill`)
   Bevel highlight/shadow drawn ONLY on straight edges (never across the
   corner curves — that was what caused the "sharp compound edges" bug we
   fixed in the Python app).  Plus:
     - dithered gloss (small checkerboard) along the top-left straight edge
     - scattered "smudge" pixels for hand-drawn feel
   The canvas resizes with the element via a ResizeObserver.

   Use:  new PixelFrame(el, { frame: "#f0a0c8", fill: "#2a1228", border: 5, r: 12 });
   ============================================================ */

class PixelFrame {
  constructor(el, opts = {}) {
    this.el = el;
    this.opts = Object.assign({
      r: 12, border: 5,
      outline:  "#7a2c50",
      frame:    "#f0a0c8",
      frameHi:  null,             // auto-derived from frame if omitted
      frameLo:  null,
      fill:     "#2a1228",
      fillHi:   "#3c1c3a",
      fillLo:   "#170810",
      shine:    "#ffffff",
      shineWidth: 44,             // px along the top edge
    }, opts);
    if (!this.opts.frameHi) this.opts.frameHi = this._mix(this.opts.frame, "#ffffff", 0.45);
    if (!this.opts.frameLo) this.opts.frameLo = this._mix(this.opts.frame, "#000000", 0.45);

    // Canvas sits behind the content.  The element uses `position: relative`
    // so children (added by the app) render on top without extra work.
    const cs = getComputedStyle(el);
    if (cs.position === "static") el.style.position = "relative";
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, {
      position: "absolute", inset: "0",
      width: "100%", height: "100%",
      pointerEvents: "none",
      zIndex: "0",
      imageRendering: "pixelated",
    });
    el.prepend(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;

    // Element's own background must be transparent (frame handles fill).
    el.style.backgroundColor = "transparent";

    // Coalesce redraws to one per animation frame — the ResizeObserver can
    // fire many times per frame when the user is dragging a corner, and
    // each draw() has to paint hundreds of rects.
    let queued = false;
    const scheduleDraw = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; this.draw(); });
    };
    const ro = new ResizeObserver(scheduleDraw);
    ro.observe(el);
    this._ro = ro;
    this.draw();
  }

  destroy() {
    this._ro?.disconnect();
    this.canvas.remove();
  }

  /** Change any of the palette colors at runtime, e.g. per-window accents. */
  restyle(opts) {
    Object.assign(this.opts, opts);
    if (opts.frame) {
      this.opts.frameHi = opts.frameHi || this._mix(opts.frame, "#ffffff", 0.45);
      this.opts.frameLo = opts.frameLo || this._mix(opts.frame, "#000000", 0.45);
    }
    this.draw();
  }

  _mix(a, b, t) {
    const p = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
    const A = p(a), B = p(b);
    const c = A.map((x,i) => Math.round(x*(1-t) + B[i]*t));
    return "#" + c.map(v => v.toString(16).padStart(2,"0")).join("");
  }

  draw() {
    const { r, border, outline, frame, frameHi, frameLo, fill, fillHi, fillLo, shine, shineWidth } = this.opts;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (w < 6 || h < 6) return;
    // canvas at CSS pixels — we want visible chunky pixels, so no DPR scaling
    this.canvas.width  = w;
    this.canvas.height = h;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    // Concentric silhouette layers
    this._roundFill(0, 0, w, h, r, outline);
    this._roundFill(1, 1, w - 1, h - 1, r - 1, frame);
    const ir = Math.max(1, r - border);
    this._roundFill(border, border, w - border, h - border, ir, fill);

    // Bevel — straight edges ONLY, so corner arcs stay uniform
    const bw = Math.max(2, border - 2);
    ctx.fillStyle = frameHi;
    ctx.fillRect(r, 1, w - 2 * r, bw);                   // top
    ctx.fillRect(1, r, bw, h - 2 * r);                   // left
    ctx.fillStyle = frameLo;
    ctx.fillRect(r, h - 1 - bw, w - 2 * r, bw);          // bottom
    ctx.fillRect(w - 1 - bw, r, bw, h - 2 * r);          // right

    // Dithered gloss on top straight edge
    const gx = r, gwPx = Math.min(shineWidth, Math.max(0, Math.floor((w - 2 * r) * 0.4)));
    if (gwPx > 6 && !this.opts.noGloss) {
      for (let px = 0; px < gwPx; px += 3) {
        for (let py = 0; py < 3; py++) {
          const on = ((Math.floor(px / 3) + py) & 1) === 0;
          ctx.fillStyle = on ? shine : frameHi;
          ctx.fillRect(gx + px, 1, 1, 1);
          ctx.fillRect(gx + px, 2, 1, 1);
        }
      }
    }

    // Inner interior bevel — highlight top, shadow bottom (straight only)
    ctx.fillStyle = fillHi;
    ctx.fillRect(border + ir, border, w - 2 * (border + ir), 1);
    ctx.fillStyle = fillLo;
    ctx.fillRect(border + ir, h - border - 1, w - 2 * (border + ir), 1);

    // Scattered "hand-drawn" smudges (deterministic per size so it's stable)
    if (!this.opts.noSmudge) {
      let seed = (w * 73856093) ^ (h * 19349663);
      const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      ctx.fillStyle = frameHi;
      for (let i = 0; i < 6; i++) {
        const x = Math.floor(rand() * (w - 4)) + 2;
        const y = Math.floor(rand() * (Math.min(h * 0.4, 20))) + 2;
        ctx.fillRect(x, y, 1, 1);
      }
      ctx.fillStyle = frameLo;
      for (let i = 0; i < 4; i++) {
        const x = Math.floor(rand() * (w - 4)) + 2;
        const y = Math.floor(h * 0.6 + rand() * (h * 0.35));
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  /** Pixel-rounded rect — the same per-scanline circle math as the Python
      version, so corners stair-step smoothly with no pointed tip. */
  _roundFill(x0, y0, x1, y1, r, color) {
    r = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2) | 0;
    if (r < 1) { this.ctx.fillStyle = color; this.ctx.fillRect(x0, y0, x1 - x0, y1 - y0); return; }
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.fillRect(x0, y0 + r, x1 - x0, y1 - y0 - 2 * r);      // centre
    // corners — per-pixel bands, inset computed at band CENTRE (avoids point)
    for (let yy = 0; yy < r; yy++) {
      const dy = r - yy - 0.5;
      const inset = Math.max(0, Math.min(r, Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)))));
      ctx.fillRect(x0 + inset, y0 + yy, (x1 - x0) - 2 * inset, 1);
      ctx.fillRect(x0 + inset, y1 - 1 - yy, (x1 - x0) - 2 * inset, 1);
    }
  }
}

/* ============================================================
   PixelButton — the smaller variant used for interactive controls.
   Idle/hover/pressed sprite states.  Idle has a drop shadow behind the
   button; hover brightens the frame; press shifts the whole button +3px
   down-right so it "sinks" and the shadow disappears.
   ============================================================ */
class PixelButton extends PixelFrame {
  constructor(el, opts = {}) {
    super(el, Object.assign({ r: 10, border: 4 }, opts));
    // Wrap any bare text nodes AND any non-canvas element children into a
    // `<span class="pf-label">` so the button label always renders ABOVE the
    // canvas.  Without this wrapper, an absolutely-positioned canvas paints
    // above static text (same stacking context, later in paint order because
    // it's "positioned"), which is why some buttons looked empty.
    if (!el.querySelector(":scope > .pf-label")) {
      const label = document.createElement("span");
      label.className = "pf-label";
      // Move all non-canvas children (including text nodes) into the label.
      const kids = [...el.childNodes].filter(n => n !== this.canvas);
      kids.forEach(n => label.appendChild(n));
      el.appendChild(label);
      this.labelEl = label;
    } else {
      this.labelEl = el.querySelector(":scope > .pf-label");
    }
    this._pressed = false;
    this._hover   = false;
    const enter = () => { this._hover = true;  this.draw(); };
    const leave = () => { this._hover = false; this._pressed = false; this.draw(); };
    const down  = () => { this._pressed = true;  this.draw(); };
    const up    = () => { this._pressed = false; this.draw(); };
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    el.addEventListener("mousedown",  down);
    el.addEventListener("mouseup",    up);
    el.addEventListener("blur", up);
  }

  draw() {
    // Override draw() to add the shadow behind, and shift on press
    if (!this.el) return;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (w < 6 || h < 6) return;
    // Draw into a canvas slightly larger than the element so shadow shows.
    // Instead we squeeze the box into the existing bounds (border already
    // provides visual thickness) and use box-shadow-like fake drop with an
    // offset frame draw when idle.
    this.canvas.width  = w;
    this.canvas.height = h;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    const shadowOffset = this._pressed ? 0 : 2;
    const drawOx = this._pressed ? 2 : 0;
    const drawOy = this._pressed ? 2 : 0;

    // Shadow (idle/hover only)
    if (!this._pressed && !this.opts.noShadow) {
      this.ctx.globalAlpha = 0.5;
      this._roundFillAt(drawOx + shadowOffset, drawOy + shadowOffset,
        w - (2 - shadowOffset), h - (2 - shadowOffset),
        this.opts.r, "#000000");
      this.ctx.globalAlpha = 1.0;
    }

    // Bright/hover frame swap
    const frame = this._hover
      ? this._mix(this.opts.frame, "#ffffff", 0.30)
      : this.opts.frame;
    const frameHi = this._mix(frame, "#ffffff", 0.45);
    const frameLo = this._mix(frame, "#000000", 0.45);

    const bx0 = drawOx, by0 = drawOy;
    const bx1 = w - (this._pressed ? 0 : 2);
    const by1 = h - (this._pressed ? 0 : 2);

    // outline → frame → interior
    this._roundFillAt(bx0, by0, bx1, by1, this.opts.r, this.opts.outline);
    this._roundFillAt(bx0 + 1, by0 + 1, bx1 - 1, by1 - 1, this.opts.r - 1, frame);
    const ir = Math.max(1, this.opts.r - this.opts.border);
    this._roundFillAt(bx0 + this.opts.border, by0 + this.opts.border,
                      bx1 - this.opts.border,  by1 - this.opts.border, ir, this.opts.fill);

    // Straight-edge bevel
    const bw = Math.max(2, this.opts.border - 2);
    ctx.fillStyle = frameHi;
    ctx.fillRect(bx0 + this.opts.r, by0 + 1, (bx1 - bx0) - 2 * this.opts.r, bw);
    ctx.fillRect(bx0 + 1, by0 + this.opts.r, bw, (by1 - by0) - 2 * this.opts.r);
    ctx.fillStyle = frameLo;
    ctx.fillRect(bx0 + this.opts.r, by1 - 1 - bw, (bx1 - bx0) - 2 * this.opts.r, bw);
    ctx.fillRect(bx1 - 1 - bw, by0 + this.opts.r, bw, (by1 - by0) - 2 * this.opts.r);

    // Dither on hover (top edge)
    if (this._hover && !this._pressed) {
      ctx.fillStyle = this.opts.shine;
      for (let px = bx0 + this.opts.r; px < bx1 - this.opts.r; px += 3) {
        ctx.fillRect(px, by0 + 2, 1, 1);
      }
    }
  }

  _roundFillAt(x0, y0, x1, y1, r, color) {
    r = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2) | 0;
    if (r < 1) { this.ctx.fillStyle = color; this.ctx.fillRect(x0, y0, x1 - x0, y1 - y0); return; }
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x0, y0 + r, x1 - x0, y1 - y0 - 2 * r);
    for (let yy = 0; yy < r; yy++) {
      const dy = r - yy - 0.5;
      const inset = Math.max(0, Math.min(r, Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)))));
      this.ctx.fillRect(x0 + inset, y0 + yy, (x1 - x0) - 2 * inset, 1);
      this.ctx.fillRect(x0 + inset, y1 - 1 - yy, (x1 - x0) - 2 * inset, 1);
    }
  }
}

window.PixelFrame = PixelFrame;
window.PixelButton = PixelButton;
