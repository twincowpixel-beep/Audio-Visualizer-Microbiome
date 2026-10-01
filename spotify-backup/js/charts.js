/* ============================================================
   Charts — the stats building blocks, shared by the site's My stats tab
   and the "My Music.html" viewer inside every backup.

   Charts are single-series, so: one green, no legend (the card title
   names it), the value printed at each bar's tip in ink, a hover/focus
   tooltip (data-tip → House tooltip) on every mark, and the numbers stay
   readable as plain text. Bars grow in stepped, pixel-y frames;
   everything holds still under prefers-reduced-motion.
   Styles: css/shared.css.
   ============================================================ */
(function () {
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const fmt = n => Math.round(n).toLocaleString();
  const minutes = ms => ms / 60000;

  function countUp(node, value, suffix = "") {
    if (still()) { node.textContent = fmt(value) + suffix; return; }
    const t0 = performance.now(), dur = 700, steps = 12;
    const tick = now => {
      const k = Math.min(1, (now - t0) / dur);
      const stepped = Math.ceil(k * steps) / steps;      // pixel-y counting, not smooth
      node.textContent = fmt(value * stepped) + suffix;
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** A picture: `src` is a URL, or { cls } for an embedded CSS-class picture. */
  function img(src) {
    if (src && typeof src === "object") {
      const i = el("i", "thumb art " + (src.cls || "blank"));
      i.setAttribute("aria-hidden", "true");
      return i;
    }
    const i = el("img", "thumb");
    i.alt = "";
    i.loading = "lazy";
    i.decoding = "async";
    if (src) i.src = src; else i.classList.add("blank");
    i.addEventListener("error", () => { i.removeAttribute("src"); i.classList.add("blank"); }, { once: true });
    return i;
  }

  /** Ranked list with pictures — for top lists that have rank but no counts. */
  function rankList(ol, items, sub, picture = it => it.image) {
    ol.textContent = "";
    items.forEach((it, i) => {
      const li = el("li", "rank-row");
      li.style.setProperty("--i", i);
      li.append(el("span", "rank-n", String(it.rank || i + 1)), img(picture(it)));
      const text = el("span", "rank-text");
      text.append(el("span", "rank-name", it.name));
      const s = sub(it);
      if (s) text.append(el("span", "rank-sub", s));
      li.append(text);
      ol.append(li);
    });
  }

  /** Horizontal bars. rows: [{ label, sub, value, shown, tip }] */
  function hbars(box, rows) {
    box.textContent = "";
    const max = Math.max(1, ...rows.map(r => r.value));
    rows.forEach((r, i) => {
      const row = el("div", "hbar");
      row.style.setProperty("--i", i);
      row.tabIndex = 0;
      row.dataset.tip = r.tip;
      const head = el("div", "hbar-head");
      const name = el("span", "hbar-name", r.label);
      if (r.sub) name.append(el("span", "hbar-sub", " · " + r.sub));
      head.append(name, el("span", "hbar-val", r.shown));
      const track = el("div", "hbar-track");
      const fill = el("i");
      fill.style.width = Math.max(1.5, (r.value / max) * 100) + "%";
      track.append(fill);
      row.append(head, track);
      box.append(row);
    });
  }

  /** Vertical columns on a CRT screen. Only the peak is labelled.
      peakLabel(value) → text for that one label. */
  function columns(box, values, labels, tipFor, every = 1, peakLabel = v => fmt(minutes(v) / 60) + " h") {
    box.textContent = "";
    const max = Math.max(1, ...values);
    const peak = values.indexOf(Math.max(...values));
    const plot = el("div", "cols-plot");
    const axis = el("div", "cols-axis");
    values.forEach((v, i) => {
      const col = el("div", "col");
      col.style.setProperty("--i", i);
      col.tabIndex = 0;
      col.dataset.tip = tipFor(i, v);
      const bar = el("i");
      bar.style.height = (v / max) * 100 + "%";
      col.style.setProperty("--h", (v / max) * 100 + "%");
      if (i === peak && v > 0) col.append(el("b", "col-peak", peakLabel(v)));
      col.append(bar);
      plot.append(col);
      axis.append(el("span", null, i % every === 0 ? labels[i] : ""));
    });
    box.append(plot, axis);
  }

  function tiles(box, list) {
    box.textContent = "";
    list.forEach(([label, value, suffix]) => {
      const t = el("div", "tile");
      const v = el("span", "tile-val", "0");
      t.append(v, el("span", "tile-label", label));
      box.append(t);
      if (typeof value === "number") countUp(v, value, suffix || ""); else v.textContent = value;
    });
  }

  function pills(box, options, current, onPick) {
    box.textContent = "";
    options.forEach(([value, label]) => {
      const b = el("button", "pill", label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(value === current));
      b.addEventListener("click", () => {
        box.querySelectorAll(".pill").forEach(p => p.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        onPick(value);
      });
      box.append(b);
    });
  }

  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (!isFinite(s)) return "";
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }

  /** A house-framed card: { box, body } — body is where content goes. */
  function card(hue, title, sub) {
    const box = el("div", "card");
    box.append(el("h3", null, title));
    const subEl = el("p", "card-sub", sub || "");
    box.append(subEl);
    const body = el("div");
    box.append(body);
    if (window.House) House.frame(box, hue, { r: 8, border: 4 });
    return { box, body, title: box.querySelector("h3"), sub: subEl };
  }

  /** Wire a drop zone + file input to onFiles([...File]). */
  function dropZone(zone, input, onFiles) {
    input.addEventListener("change", () => { if (input.files.length) onFiles([...input.files]); });
    ["dragenter", "dragover"].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.add("over"); }));
    ["dragleave", "drop"].forEach(t => zone.addEventListener(t, () => zone.classList.remove("over")));
    zone.addEventListener("drop", e => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
    });
  }

  /** The full listening-history dashboard (Spotify data download), built
      into `root`. Returns { show(list) } — list from ListenHistory.normalise. */
  function historyView(root) {
    root.textContent = "";
    const yearBox = el("div", "pills");
    yearBox.setAttribute("role", "group");
    yearBox.setAttribute("aria-label", "Year");
    const hero = el("div", "hero");
    const heroMin = el("span", "hero-min", "0");
    const heroLabel = el("span", "hero-label");
    hero.append(heroMin, heroLabel);
    const tileBox = el("div", "tiles");
    const grid = el("div", "cards");
    const cArtists = card(0.95, "Top artists", "By minutes listened");
    const cTracks = card(0.58, "Top songs", "By plays (30 seconds or more)");
    const cAlbums = card(0.11, "Top albums", "By minutes listened");
    const cTime = card(0.47, "Minutes by year", "Total listening time");
    const cClock = card(0.72, "Time of day", "Hours listened in each hour of the day");
    const cWeek = card(0.64, "Day of the week", "Hours listened on each day");
    const screen = c => { const s = el("div", "screen"); const inner = el("div"); s.append(inner); c.body.append(s); return inner; };
    const crt = c => { const s = el("div", "crt-chart"); c.body.append(s); return s; };
    const boxes = {
      artists: screen(cArtists), tracks: screen(cTracks), albums: screen(cAlbums), time: screen(cTime),
      clock: crt(cClock), week: crt(cWeek),
    };
    [cArtists, cTracks, cAlbums, cTime, cClock, cWeek].forEach(c => grid.append(c.box));
    root.append(yearBox, hero, tileBox, grid);

    let list = [], year = null;
    function render() {
      const s = ListenHistory.compute(list, year);
      pills(yearBox, [[null, "All time"], ...s.years.map(y => [y, String(y)])], year, y => { year = y; render(); });
      const span = s.first ? new Date(s.first).toLocaleDateString(undefined, { month: "short", year: "numeric" }) +
        " – " + new Date(s.last).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "";
      heroLabel.textContent = "minutes listened · " + span;
      countUp(heroMin, minutes(s.totalMs));
      tiles(tileBox, [
        ["hours", minutes(s.totalMs) / 60],
        ["plays (30 s or more)", s.plays],
        ["artists", s.artistCount],
        ["different songs", s.trackCount],
        ["days you listened", s.activeDays],
        ...(s.podcastMs ? [["podcast minutes", minutes(s.podcastMs)]] : []),
      ]);
      hbars(boxes.artists, s.topArtists.map(a => ({
        label: a.name, value: a.ms, shown: fmt(minutes(a.ms)) + " min",
        tip: a.name + ": " + fmt(minutes(a.ms)) + " minutes, " + fmt(a.plays) + " plays",
      })));
      hbars(boxes.tracks, s.topTracks.map(t => ({
        label: t.name, sub: t.artist, value: t.plays, shown: fmt(t.plays) + " plays",
        tip: t.name + " — " + t.artist + ": " + fmt(t.plays) + " plays, " + fmt(minutes(t.ms)) + " minutes",
      })));
      cAlbums.box.hidden = !s.hasAlbums;
      if (s.hasAlbums) {
        hbars(boxes.albums, s.topAlbums.map(a => ({
          label: a.name, sub: a.artist, value: a.ms, shown: fmt(minutes(a.ms)) + " min",
          tip: a.name + " — " + a.artist + ": " + fmt(minutes(a.ms)) + " minutes",
        })));
      }
      // Per year when looking at everything; per month inside one year.
      if (year == null) {
        cTime.title.textContent = "Minutes by year";
        hbars(boxes.time, s.byYear.map(y => ({
          label: String(y.year), value: y.ms, shown: fmt(minutes(y.ms)) + " min",
          tip: y.year + ": " + fmt(minutes(y.ms)) + " minutes (" + fmt(minutes(y.ms) / 60) + " hours)",
        })));
      } else {
        cTime.title.textContent = "Minutes by month, " + year;
        hbars(boxes.time, s.byMonth.map((ms, i) => ({
          label: MONTHS[i], value: ms, shown: fmt(minutes(ms)) + " min",
          tip: MONTHS[i] + " " + year + ": " + fmt(minutes(ms)) + " minutes",
        })));
      }
      const hourLabel = h => (h % 12 || 12) + (h < 12 ? "am" : "pm");
      columns(boxes.clock, s.byHour, s.byHour.map((_, h) => hourLabel(h)),
        (h, v) => hourLabel(h) + "–" + hourLabel((h + 1) % 24) + ": " + fmt(minutes(v) / 60) + " hours", 6);
      columns(boxes.week, s.byWeekday, WEEKDAYS, (d, v) => WEEKDAYS[d] + ": " + fmt(minutes(v) / 60) + " hours", 1);
    }
    return { show(l) { list = l; year = null; render(); } };
  }

  /** Read a dropped Spotify data file into normalised plays, or throw a
      message fit for the person. */
  async function readHistory(files) {
    const list = ListenHistory.normalise(await ListenHistory.readFiles(files));
    if (!list.length) {
      throw new Error("No listening history found in that file. Choose the .zip Spotify emailed you " +
                      "(or the Streaming_History .json files inside it).");
    }
    return list;
  }

  window.Charts = {
    WEEKDAYS, MONTHS, still, el, fmt, minutes, countUp, img, rankList, hbars, columns, tiles, pills, ago,
    card, dropZone, historyView, readHistory,
  };
})();
