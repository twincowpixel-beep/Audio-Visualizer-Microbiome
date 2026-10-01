/* ============================================================
   StatsUI — the Stats tab.

   Top half: "Your top picks" from the Web API (needs a login).
   Bottom half: minutes listened & all-time charts from Spotify's data
   download (no login needed — the file never leaves the browser).

   Charts are single-series, so: one green, no legend (the card title
   names it), value printed at each bar's tip in ink, a hover/focus
   tooltip on every mark, and the numbers stay readable as plain text.
   Bars grow in stepped, pixel-y frames; everything holds still under
   prefers-reduced-motion.
   ============================================================ */
(function () {
  const $ = id => document.getElementById(id);
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  let deps = null;          // { client, friendly, login, relogin }
  let range = "short_term";
  const liveCache = {};
  let recentCache = null;
  let history = null;       // normalised plays
  let year = null;

  // ---------- tiny DOM helpers ----------------------------------------
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

  function img(src) {
    const i = el("img", "thumb");
    i.alt = "";
    i.loading = "lazy";
    i.decoding = "async";
    if (src) i.src = src; else i.classList.add("blank");
    i.addEventListener("error", () => { i.removeAttribute("src"); i.classList.add("blank"); }, { once: true });
    return i;
  }

  /** Ranked list with pictures — for API top lists, which have rank but no counts. */
  function rankList(ol, items, sub) {
    ol.textContent = "";
    items.forEach((it, i) => {
      const li = el("li", "rank-row");
      li.style.setProperty("--i", i);
      li.append(el("span", "rank-n", String(it.rank)), img(it.image));
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

  /** Vertical columns (clock, weekdays, months). Only the peak is labelled. */
  function columns(box, values, labels, tipFor, every = 1) {
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
      if (i === peak && v > 0) col.append(el("b", "col-peak", fmt(minutes(v) / 60) + " h"));
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

  // ---------- live (Web API) -----------------------------------------
  function liveMessage(text, withRelogin) {
    const box = $("live-status");
    box.textContent = text;
    $("live-relogin").hidden = !withRelogin;
  }

  async function loadLive() {
    if (!SpotifyAuth.isLoggedIn()) {
      $("stats-login").hidden = false;
      $("stats-live-body").hidden = true;
      return;
    }
    $("stats-login").hidden = true;
    $("stats-live-body").hidden = false;
    liveMessage("Asking Spotify…", false);
    try {
      const api = deps.client();
      if (!liveCache[range]) liveCache[range] = await LiveStats.fetchTop(api, range);
      if (!recentCache) {
        try { recentCache = await LiveStats.fetchRecent(api); } catch (e) { recentCache = { error: e }; }
      }
      renderLive();
      liveMessage("", false);
    } catch (e) {
      if (e.name === "ApiError" && (e.status === 403 || e.status === 401)) {
        liveMessage("Spotify needs your OK to share listening stats. Log in again and approve the new " +
                    "permissions (it only asks to see your top artists and recent plays).", true);
      } else {
        liveMessage(deps.friendly(e), false);
      }
    }
  }

  function renderLive() {
    const top = liveCache[range];
    const when = LiveStats.RANGES[range];
    $("top-artists-sub").textContent = "Most played, " + when;
    $("top-tracks-sub").textContent = "Most played, " + when;
    rankList($("top-artists"), top.artists.slice(0, 10), () => "");
    rankList($("top-tracks"), top.tracks.slice(0, 10), t => t.artists.join(", "));
    if (!top.artists.length && !top.tracks.length) {
      liveMessage("Spotify hasn't worked out your top picks for this period yet — try a longer one.", false);
    }

    const genreCard = $("card-genres");
    if (top.genres && top.genres.length) {
      genreCard.hidden = false;
      hbars($("genre-bars"), top.genres.map(g => ({
        label: g.name, value: g.count, shown: String(g.count),
        tip: g.name + ": " + g.count + " of your top " + top.artists.length + " artists",
      })));
    } else {
      genreCard.hidden = true;
    }

    const rc = recentCache;
    if (rc && !rc.error && rc.plays.length) {
      $("card-recent").hidden = false;
      tiles($("recent-tiles"), [
        ["recent plays", rc.plays.length],
        ["minutes of music in them", rc.minutes],
        ["different artists", rc.artistCount],
      ]);
      const ol = $("recent-list");
      ol.textContent = "";
      rc.plays.slice(0, 8).forEach((p, i) => {
        const li = el("li", "rank-row");
        li.style.setProperty("--i", i);
        li.append(img(p.image));
        const text = el("span", "rank-text");
        text.append(el("span", "rank-name", p.name), el("span", "rank-sub", p.artists.join(", ") + " · " + ago(p.playedAt)));
        li.append(text);
        ol.append(li);
      });
    } else {
      $("card-recent").hidden = true;
    }
  }

  // ---------- full history (data download) ---------------------------
  async function loadHistory(files) {
    const status = $("history-status");
    status.textContent = "Reading your file…";
    try {
      const raw = await ListenHistory.readFiles(files);
      const list = ListenHistory.normalise(raw);
      if (!list.length) {
        status.textContent = "No listening history found in that file. Choose the .zip Spotify emailed you " +
          "(or the Streaming_History .json files inside it).";
        return;
      }
      history = list;
      year = null;
      deps.setTutorial(false);    // they've done it — get the steps out of the way
      status.textContent = "";
      renderHistory();
    } catch (e) {
      status.textContent = "Couldn't read that file: " + (e.message || e) + ". Try the .json files from inside the zip instead.";
    }
  }

  function renderHistory() {
    const s = ListenHistory.compute(history, year);
    $("history-out").hidden = false;
    pills($("year-pills"), [[null, "All time"], ...s.years.map(y => [y, String(y)])], year, y => { year = y; renderHistory(); });

    const span = s.first ? new Date(s.first).toLocaleDateString(undefined, { month: "short", year: "numeric" }) +
      " – " + new Date(s.last).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "";
    $("hero-range").textContent = span;
    countUp($("hero-min"), minutes(s.totalMs));

    tiles($("history-tiles"), [
      ["hours", minutes(s.totalMs) / 60],
      ["plays (30 s or more)", s.plays],
      ["artists", s.artistCount],
      ["different songs", s.trackCount],
      ["days you listened", s.activeDays],
      ...(s.podcastMs ? [["podcast minutes", minutes(s.podcastMs)]] : []),
    ]);

    hbars($("hist-artists"), s.topArtists.map(a => ({
      label: a.name, value: a.ms, shown: fmt(minutes(a.ms)) + " min",
      tip: a.name + ": " + fmt(minutes(a.ms)) + " minutes, " + fmt(a.plays) + " plays",
    })));
    hbars($("hist-tracks"), s.topTracks.map(t => ({
      label: t.name, sub: t.artist, value: t.plays, shown: fmt(t.plays) + " plays",
      tip: t.name + " — " + t.artist + ": " + fmt(t.plays) + " plays, " + fmt(minutes(t.ms)) + " minutes",
    })));
    $("card-albums").hidden = !s.hasAlbums;
    if (s.hasAlbums) {
      hbars($("hist-albums"), s.topAlbums.map(a => ({
        label: a.name, sub: a.artist, value: a.ms, shown: fmt(minutes(a.ms)) + " min",
        tip: a.name + " — " + a.artist + ": " + fmt(minutes(a.ms)) + " minutes",
      })));
    }

    // Per year when looking at everything; per month inside one year.
    if (year == null) {
      $("time-title").textContent = "Minutes by year";
      hbars($("hist-time"), s.byYear.map(y => ({
        label: String(y.year), value: y.ms, shown: fmt(minutes(y.ms)) + " min",
        tip: y.year + ": " + fmt(minutes(y.ms)) + " minutes (" + fmt(minutes(y.ms) / 60) + " hours)",
      })));
    } else {
      $("time-title").textContent = "Minutes by month, " + year;
      hbars($("hist-time"), s.byMonth.map((ms, i) => ({
        label: MONTHS[i], value: ms, shown: fmt(minutes(ms)) + " min",
        tip: MONTHS[i] + " " + year + ": " + fmt(minutes(ms)) + " minutes",
      })));
    }

    const hourLabel = h => (h % 12 || 12) + (h < 12 ? "am" : "pm");
    columns($("hist-clock"), s.byHour, s.byHour.map((_, h) => hourLabel(h)),
      (h, v) => hourLabel(h) + "–" + hourLabel((h + 1) % 24) + ": " + fmt(minutes(v) / 60) + " hours", 6);
    columns($("hist-week"), s.byWeekday, WEEKDAYS,
      (d, v) => WEEKDAYS[d] + ": " + fmt(minutes(v) / 60) + " hours", 1);
  }

  // ---------- wiring ------------------------------------------------------
  function init(d) {
    deps = d;
    pills($("range-pills"), [["short_term", "4 weeks"], ["medium_term", "6 months"], ["long_term", "1 year"]],
      range, r => { range = r; loadLive(); });
    $("live-relogin").addEventListener("click", deps.relogin);
    $("stats-login-btn").addEventListener("click", deps.login);

    const toggle = $("tutorial-toggle");
    const setTutorial = open => {
      $("tutorial-body").hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Hide" : "Show me how";
    };
    toggle.addEventListener("click", () => setTutorial($("tutorial-body").hidden));
    deps.setTutorial = setTutorial;

    const input = $("history-file");
    input.addEventListener("change", () => { if (input.files.length) loadHistory([...input.files]); });
    const zone = $("drop-zone");
    ["dragenter", "dragover"].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.add("over"); }));
    ["dragleave", "drop"].forEach(t => zone.addEventListener(t, () => zone.classList.remove("over")));
    zone.addEventListener("drop", e => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) loadHistory([...e.dataTransfer.files]);
    });
  }

  /** Called whenever the Stats tab is shown. */
  function opened() { loadLive(); }
  function forget() { Object.keys(liveCache).forEach(k => delete liveCache[k]); recentCache = null; }

  window.StatsUI = { init, opened, forget };
})();
