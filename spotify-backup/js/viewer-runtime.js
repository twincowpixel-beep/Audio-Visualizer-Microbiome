/* ============================================================
   ViewerRuntime — the little app inside every backup's "My Music.html".

   Exporters.viewerHtml() writes one self-contained page: the backup as
   JSON in <script id="music-data">, the pictures as CSS classes, and this
   file (with pixel-frame.js, house.js, history.js, charts.js) as a single
   inline script. It works from a USB stick with no internet, years from
   now, with or without Spotify.

     Tabs        Liked songs · Playlists · Albums · Artists · Stats
     Background  the site's picker (house.js themes, PixelButton swatches)
     Settings    layout (list / compact / grid), item size, which details
                 show, sort order, text style — remembered per browser
     Search      filters whatever list is on screen
   ============================================================ */
(function () {
  const raw = document.getElementById("music-data");
  if (!raw) return;
  const data = JSON.parse(raw.textContent);
  const pics = data.pictures || { art: {}, covers: {} };
  const { el, fmt, minutes, hbars, columns, tiles, pills, rankList, card } = Charts;

  // ---------- settings ----------------------------------------------------
  const SETTINGS_KEY = "my-music.settings";
  const DEFAULTS = {
    layout: "list", size: 3, sort: "default", font: "text",
    show: { art: true, num: true, album: true, year: true, length: true, added: false },
  };
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (s) return { ...DEFAULTS, ...s, show: { ...DEFAULTS.show, ...(s.show || {}) } };
    } catch (e) { /* storage blocked (common for files opened from disk) */ }
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
  const settings = loadSettings();
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* fine */ }
    applySettings();
    render();
  }
  function applySettings() {
    document.body.style.setProperty("--s", settings.size);
    document.body.classList.toggle("font-pixel", settings.font === "pixel");
  }

  // ---------- small helpers ---------------------------------------------
  const plural = (n, one, many) => n.toLocaleString() + " " + (n === 1 ? one : many || one + "s");
  const year = d => (d || "").slice(0, 4);
  function len(ms) {
    if (typeof ms !== "number") return "";
    const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    const p = n => String(n).padStart(2, "0");
    return h ? h + ":" + p(m) + ":" + p(x) : m + ":" + p(x);
  }
  const longDate = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); };
  const artFor = url => (url && pics.art[url]) || "";
  function art(url, extra = "") {
    const i = el("i", "art " + (artFor(url) || "blank") + (extra ? " " + extra : ""));
    i.setAttribute("aria-hidden", "true");
    return i;
  }
  function link(url, label) {
    const a = el("a", "ext", "↗");
    a.href = url; a.target = "_blank"; a.rel = "noopener";
    a.setAttribute("aria-label", "Open " + label + " in Spotify");
    a.dataset.tip = "Open in Spotify";
    return a;
  }
  const matches = (q, ...fields) => !q || fields.some(f => f && String(f).toLowerCase().includes(q));

  // Golden-ratio hues: neighbouring cards never share a colour.
  const hueAt = i => (0.38 + i * 0.618) % 1;

  // ---------- page chrome ---------------------------------------------------
  const app = el("main", "win wide viewer");
  const bar = el("div", "win-bar");
  const titleWrap = el("div", "v-title");
  titleWrap.append(el("h1", "win-title", "MY MUSIC"),
    el("span", "v-sub", (data.account ? data.account.name + " · " : "") + "saved " + longDate(data.createdAt) +
      (data.complete ? "" : " · stopped before it finished")));
  const btnBg = el("button", "eb-btn slim", "Background");
  const btnSettings = el("button", "eb-btn slim", "Settings");
  const btnPrint = el("button", "eb-btn slim", "Print");
  [btnBg, btnSettings, btnPrint].forEach(b => { b.type = "button"; });
  const barBtns = el("div", "v-bar-btns");
  barBtns.append(btnBg, btnSettings, btnPrint);
  bar.append(titleWrap, barBtns);

  const bgPanel = el("div", "bg-picker");
  bgPanel.hidden = true;
  bgPanel.append(el("p", null, "Pick a background"));
  const swatchBox = el("div", "swatches");
  bgPanel.append(swatchBox);

  const setPanel = el("div", "bg-picker v-settings");
  setPanel.hidden = true;

  const tabBar = el("div", "tabs v-tabs");
  tabBar.setAttribute("role", "tablist");
  const tools = el("div", "v-tools");
  const search = el("input", "field v-search");
  search.type = "search";
  search.placeholder = "Search this list…";
  search.setAttribute("aria-label", "Search this list");
  const notesBtn = el("button", "pill", "Notes (" + data.warnings.length + ")");
  notesBtn.type = "button";
  notesBtn.hidden = !data.warnings.length;
  tools.append(search, notesBtn);
  const notes = el("div", "warn-box");
  notes.hidden = true;
  notes.append(el("b", null, "Things to know about this backup"));
  const notesList = el("ul");
  data.warnings.forEach(w => notesList.append(el("li", null, w)));
  notes.append(notesList);

  const body = el("div", "win-body v-body");
  app.append(bar, bgPanel, setPanel, tabBar, tools, notes, body);
  document.body.append(app);
  document.body.append(el("p", "footer", null));
  document.body.lastChild.append(el("span", null, "Your Spotify backup · works offline · open the .txt files or spreadsheets for plain copies"));

  House.frame(app, 0.38, { r: 10, border: 5 });
  [btnBg, btnSettings, btnPrint].forEach((b, i) => House.button(b, [0.95, 0.64, 0.11][i]));
  House.frame(bgPanel, 0.95, { r: 8, border: 4 });
  House.frame(setPanel, 0.64, { r: 8, border: 4 });
  House.initTooltip();

  // Backgrounds — same picker as the site; starts on the one chosen there.
  const tilesBg = [];
  let themeId = null;
  try { themeId = localStorage.getItem("spotify-backup.theme"); } catch (e) { /* blocked */ }
  const startTheme = House.THEMES.find(t => t.id === (themeId || data.theme)) || House.THEMES[0];
  House.THEMES.forEach(t => {
    const b = el("button", "swatch");
    b.type = "button";
    b.dataset.tip = t.name;
    b.setAttribute("aria-label", t.name);
    swatchBox.append(b);
    const pb = House.swatch(b, t);
    tilesBg.push({ b, pb, t });
    b.addEventListener("click", () => {
      tilesBg.forEach(x => { x.pb.setSelected(x.b === b); x.b.setAttribute("aria-pressed", String(x.b === b)); });
      House.setTheme(t.id);
    });
  });
  tilesBg.forEach(x => { x.pb.setSelected(x.t === startTheme); x.b.setAttribute("aria-pressed", String(x.t === startTheme)); });
  House.setTheme(startTheme.id);

  const togglePanel = (panel, btn) => {
    const open = panel.hidden;
    [bgPanel, setPanel].forEach(p => { p.hidden = true; });
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  btnBg.addEventListener("click", () => togglePanel(bgPanel, btnBg));
  btnSettings.addEventListener("click", () => togglePanel(setPanel, btnSettings));
  btnPrint.addEventListener("click", () => print());
  notesBtn.addEventListener("click", () => { notes.hidden = !notes.hidden; });

  // ---------- settings panel ------------------------------------------------
  function buildSettings() {
    setPanel.textContent = "";
    setPanel.append(el("p", null, "How lists look"));
    const grid = el("div", "v-set-grid");

    const group = (label, node) => { const g = el("div", "v-set"); g.append(el("span", "v-set-label", label), node); grid.append(g); };

    const layout = el("div", "pills");
    pills(layout, [["list", "List"], ["compact", "Compact"], ["grid", "Grid"]], settings.layout, v => { settings.layout = v; saveSettings(); });
    group("Layout", layout);

    const sizeWrap = el("div", "v-size");
    const size = el("input");
    size.type = "range"; size.min = "1"; size.max = "5"; size.step = "1"; size.value = String(settings.size);
    size.setAttribute("aria-label", "Item size");
    const sizeOut = el("span", "v-size-out", ["", "Tiny", "Small", "Medium", "Large", "Huge"][settings.size]);
    size.addEventListener("input", () => {
      settings.size = +size.value;
      sizeOut.textContent = ["", "Tiny", "Small", "Medium", "Large", "Huge"][settings.size];
      saveSettings();
    });
    sizeWrap.append(size, sizeOut);
    group("Item size", sizeWrap);

    const sort = el("select", "field v-select");
    [["default", "Original order"], ["title", "Song A–Z"], ["artist", "Artist A–Z"], ["album", "Album A–Z"],
     ["added-new", "Newest added first"], ["added-old", "Oldest added first"], ["year-new", "Newest releases first"],
     ["length", "Longest first"]].forEach(([v, l]) => { const o = el("option", null, l); o.value = v; sort.append(o); });
    sort.value = settings.sort;
    sort.setAttribute("aria-label", "Sort order");
    sort.addEventListener("change", () => { settings.sort = sort.value; saveSettings(); });
    group("Sort", sort);

    const font = el("div", "pills");
    pills(font, [["text", "Easy to read"], ["pixel", "Pixel"]], settings.font, v => { settings.font = v; saveSettings(); });
    group("Text", font);

    const show = el("div", "v-checks");
    [["art", "Pictures"], ["num", "Numbers"], ["album", "Album"], ["year", "Year"], ["length", "Length"], ["added", "Date added"]]
      .forEach(([k, l]) => {
        const lab = el("label");
        const cb = el("input");
        cb.type = "checkbox"; cb.checked = !!settings.show[k];
        cb.addEventListener("change", () => { settings.show[k] = cb.checked; saveSettings(); });
        lab.append(cb, document.createTextNode(" " + l));
        show.append(lab);
      });
    group("Show", show);

    const reset = el("button", "pill", "Reset to default");
    reset.type = "button";
    reset.addEventListener("click", () => { Object.assign(settings, JSON.parse(JSON.stringify(DEFAULTS))); buildSettings(); saveSettings(); });
    group("", reset);
    setPanel.append(grid);
  }

  // ---------- song lists ----------------------------------------------------
  const by = (f, dir = 1) => (a, b) => dir * String(f(a) || "").localeCompare(String(f(b) || ""), undefined, { sensitivity: "base" });
  function sorted(list) {
    const l = [...list];
    switch (settings.sort) {
      case "title": return l.sort(by(t => t.title));
      case "artist": return l.sort(by(t => (t.artists || []).join(", ")));
      case "album": return l.sort(by(t => t.album));
      case "added-new": return l.sort(by(t => t.addedAt, -1));
      case "added-old": return l.sort(by(t => t.addedAt));
      case "year-new": return l.sort(by(t => t.releaseDate, -1));
      case "length": return l.sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0));
      default: return l;
    }
  }

  function songList(tracks, q) {
    const shown = sorted(tracks).filter(t => matches(q, t.title, (t.artists || []).join(" "), t.album));
    const list = el("ol", "songs layout-" + settings.layout);
    const S = settings.show;
    const frag = document.createDocumentFragment();
    shown.forEach(t => {
      const li = el("li", "song" + (t.kind === "missing" ? " gone" : ""));
      if (S.num) li.append(el("span", "num", String(t.position)));
      if (S.art) li.append(art(t.albumImage));
      const meta = el("div", "meta");
      meta.append(el("b", "t", t.title || "(untitled)"));
      if (t.artists && t.artists.length) meta.append(el("span", "by", t.artists.join(", ")));
      const extra = [];
      if (S.album && t.album) extra.push(t.album);
      if (S.year && year(t.releaseDate)) extra.push(year(t.releaseDate));
      if (S.length && len(t.durationMs)) extra.push(len(t.durationMs));
      if (S.added && t.addedAt) extra.push("added " + longDate(t.addedAt));
      if (t.kind === "local") extra.push("local file");
      if (t.kind === "episode") extra.push("podcast");
      if (extra.length) meta.append(el("span", "ex", extra.join(" · ")));
      li.append(meta);
      if (t.url) li.append(link(t.url, t.title));
      frag.append(li);
    });
    list.append(frag);
    const wrap = el("div");
    wrap.append(el("p", "count", q ? plural(shown.length, "match", "matches") + " for “" + q + "”" : ""), list);
    if (!shown.length) wrap.append(el("p", "empty", q ? "Nothing matches that search." : "No songs here."));
    return wrap;
  }

  // ---------- tabs --------------------------------------------------------
  const TABS = [];
  if (data.likedSongs) TABS.push(["liked", "Liked songs", data.likedSongs.tracks.length]);
  if (data.playlists) TABS.push(["playlists", "Playlists", data.playlists.items.length]);
  if (data.albums) TABS.push(["albums", "Albums", data.albums.items.length]);
  if (data.artists) TABS.push(["artists", "Artists", data.artists.items.length]);
  TABS.push(["stats", "Stats", null]);
  const tabBtns = {};
  TABS.forEach(([id, label, n]) => {
    const b = el("button", "tab", label + (n != null ? " (" + n.toLocaleString() + ")" : ""));
    b.type = "button";
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => { location.hash = id; });
    tabBtns[id] = b;
    tabBar.append(b);
  });

  function route() {
    const [tab, sub] = decodeURIComponent(location.hash.slice(1)).split("/");
    return { tab: tabBtns[tab] ? tab : TABS[0][0], sub: sub || "" };
  }

  // ---------- views -------------------------------------------------------
  function viewLiked(q) {
    const l = data.likedSongs;
    const head = el("div", "v-head");
    head.append(el("h2", "stats-h", "Liked songs"),
      el("p", "small", plural(l.tracks.length, "song") + (l.complete ? "" : " (stopped part-way)")));
    body.append(head, songList(l.tracks, q));
  }

  function playlistCover(pl, cls) {
    const c = pics.covers[pl.id];
    if (c) return el("i", cls + " " + c);
    // No picture: the playlist's initial on a dithered tile, house-style.
    const tile = el("i", cls + " cover-blank", (pl.name || "?").trim().charAt(0).toUpperCase());
    return tile;
  }

  function viewPlaylists(q, sub) {
    const items = data.playlists.items;
    if (sub) {
      const pl = items.find(p => String(p.position) === sub);
      if (pl) return viewPlaylist(pl, q);
    }
    const head = el("div", "v-head");
    head.append(el("h2", "stats-h", "Playlists"), el("p", "small", plural(items.length, "playlist") + ". Pick one to see its songs."));
    const grid = el("div", "pl-grid size-" + settings.size);
    items.filter(p => matches(q, p.name, p.owner)).forEach((pl, i) => {
      const a = el("a", "pl-card");
      a.href = "#playlists/" + pl.position;
      a.style.setProperty("--i", i);
      a.append(playlistCover(pl, "pl-cover"));
      const t = el("span", "pl-name", pl.name);
      const m = el("span", "pl-meta", pl.tracks ? plural(pl.tracks.length, "song") : "name + link only");
      a.append(t, m);
      grid.append(a);
      House.frame(a, hueAt(i), { r: 8, border: 4 });
    });
    body.append(head, grid);
  }

  function viewPlaylist(pl, q) {
    const back = el("a", "back", "← All playlists");
    back.href = "#playlists";
    const head = el("div", "pl-head");
    head.append(playlistCover(pl, "pl-cover big"));
    const info = el("div");
    info.append(el("h2", "stats-h", pl.name));
    const meta = [pl.mine ? "Your playlist" : "By " + (pl.owner || "someone else")];
    if (pl.collaborative) meta.push("collaborative");
    meta.push(pl.tracks ? plural(pl.tracks.length, "song") : (pl.totalOnSpotify != null ? plural(pl.totalOnSpotify, "song") + " on Spotify" : ""));
    info.append(el("p", "small", meta.filter(Boolean).join(" · ")));
    if (pl.descriptionText) info.append(el("p", "desc", "“" + pl.descriptionText + "”"));
    if (pl.url) { const a = el("a", "small", pl.url); a.href = pl.url; a.target = "_blank"; a.rel = "noopener"; info.append(a); }
    head.append(info);
    body.append(back, head);
    if (pl.tracks) body.append(songList(pl.tracks, q));
    else body.append(el("p", "empty", pl.note || "Spotify didn't share this playlist's songs."));
  }

  function viewAlbums(q) {
    const items = data.albums.items;
    const head = el("div", "v-head");
    head.append(el("h2", "stats-h", "Saved albums"), el("p", "small", plural(items.length, "album")));
    // Albums reuse the song-list look, so Settings applies here too.
    const asTracks = items.map(a => ({ position: a.position, title: a.title, artists: a.artists, album: "",
      releaseDate: a.releaseDate, durationMs: null, addedAt: a.addedAt, url: a.url, albumImage: a.imageUrl,
      kind: "album" }));
    body.append(head, songList(asTracks, q));
  }

  function viewArtists(q) {
    const items = data.artists.items;
    const head = el("div", "v-head");
    head.append(el("h2", "stats-h", "Artists you follow"), el("p", "small", plural(items.length, "artist")));
    const grid = el("div", "artist-grid size-" + settings.size);
    items.filter(a => matches(q, a.name)).forEach((a, i) => {
      const tile = el(a.url ? "a" : "div", "artist-tile");
      if (a.url) { tile.href = a.url; tile.target = "_blank"; tile.rel = "noopener"; }
      tile.style.setProperty("--i", i);
      const mono = el("i", "mono", (a.name || "?").trim().charAt(0).toUpperCase());
      mono.style.setProperty("--h", Math.round(hueAt(i) * 360));
      tile.append(mono, el("span", null, a.name));
      grid.append(tile);
    });
    body.append(head, grid);
  }

  // ---------- stats ------------------------------------------------------
  let historyBoard = null, historyList = null, pickRange = "short_term";
  function viewStats() {
    const allSongs = [
      ...((data.likedSongs && data.likedSongs.tracks) || []),
      ...((data.playlists && data.playlists.items) || []).flatMap(p => p.tracks || []),
    ].filter(t => t.kind === "track" || t.kind === "local");
    const unique = new Map();
    allSongs.forEach(t => unique.set(t.uri || t.title + "|" + t.artists.join(","), t));
    const songs = [...unique.values()];
    const liked = (data.likedSongs && data.likedSongs.tracks) || [];

    // 1. Library at a glance — always there, worked out from the backup itself.
    body.append(el("h2", "stats-h", "Your library at a glance"));
    const tileBox = el("div", "tiles");
    body.append(tileBox);
    tiles(tileBox, [
      ["different songs saved", songs.length],
      ["hours of music", minutes(songs.reduce((s, t) => s + (t.durationMs || 0), 0)) / 60],
      ["different artists", new Set(songs.flatMap(t => t.artists)).size],
      ...(data.playlists ? [["playlists", data.playlists.items.length]] : []),
      ...(data.albums ? [["saved albums", data.albums.items.length]] : []),
    ]);

    const grid = el("div", "cards");
    body.append(grid);
    const artistCount = new Map();
    liked.forEach(t => t.artists.forEach(a => artistCount.set(a, (artistCount.get(a) || 0) + 1)));
    if (artistCount.size) {
      const c = card(0.95, "Most-liked artists", "Artists with the most songs in your liked songs");
      const s = el("div", "screen"), box = el("div"); s.append(box); c.body.append(s); grid.append(c.box);
      hbars(box, [...artistCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => ({
        label: name, value: n, shown: plural(n, "song"), tip: name + ": " + plural(n, "liked song"),
      })));
    }
    const decades = new Map();
    songs.forEach(t => { const y = +year(t.releaseDate); if (y > 1900) decades.set(Math.floor(y / 10) * 10, (decades.get(Math.floor(y / 10) * 10) || 0) + 1); });
    if (decades.size) {
      const keys = [...decades.keys()].sort((a, b) => a - b);
      const all = [];
      for (let d = keys[0]; d <= keys[keys.length - 1]; d += 10) all.push(d);
      const c = card(0.72, "Your music by decade", "Songs saved, by when they came out");
      const crt = el("div", "crt-chart"); c.body.append(crt); grid.append(c.box);
      columns(crt, all.map(d => decades.get(d) || 0), all.map(d => "'" + String(d).slice(2) + "s"),
        (i, v) => all[i] + "s: " + plural(v, "song"), all.length > 8 ? 2 : 1, v => plural(v, "song"));
    }
    const perYear = new Map();
    liked.forEach(t => { const y = year(t.addedAt); if (y) perYear.set(y, (perYear.get(y) || 0) + 1); });
    if (perYear.size) {
      const c = card(0.58, "Songs liked each year", "When you pressed ♥");
      const s = el("div", "screen"), box = el("div"); s.append(box); c.body.append(s); grid.append(c.box);
      hbars(box, [...perYear.entries()].sort().map(([y, n]) => ({ label: y, value: n, shown: plural(n, "song"), tip: y + ": " + plural(n, "song") + " liked" })));
    }
    if (data.playlists) {
      const withSongs = data.playlists.items.filter(p => p.tracks && p.tracks.length);
      if (withSongs.length) {
        const c = card(0.11, "Biggest playlists", "By number of songs");
        const s = el("div", "screen"), box = el("div"); s.append(box); c.body.append(s); grid.append(c.box);
        hbars(box, [...withSongs].sort((a, b) => b.tracks.length - a.tracks.length).slice(0, 10).map(p => ({
          label: p.name, value: p.tracks.length, shown: plural(p.tracks.length, "song"), tip: p.name + ": " + plural(p.tracks.length, "song"),
        })));
      }
    }

    // 2. Top picks snapshot — what Spotify said on the day of the backup.
    const L = data.listening;
    if (L && L.ranges) {
      body.append(el("h2", "stats-h", "Your top picks"));
      body.append(el("p", "small", "As Spotify saw it on " + longDate(L.capturedAt) + "."));
      const rangeBox = el("div", "pills");
      body.append(rangeBox);
      const picks = el("div", "cards");
      body.append(picks);
      const labels = { short_term: "4 weeks", medium_term: "6 months", long_term: "1 year" };
      const drawPicks = () => {
        picks.textContent = "";
        const top = L.ranges[pickRange];
        if (!top) return;
        const pic = it => ({ cls: artFor(it.image) || "blank" });
        const ca = card(0.95, "Top artists", "Most played, last " + labels[pickRange]);
        const ola = el("ol", "rank"); ca.body.append(ola); picks.append(ca.box);
        rankList(ola, top.artists.slice(0, 10), () => "", pic);
        const ct = card(0.58, "Top songs", "Most played, last " + labels[pickRange]);
        const olt = el("ol", "rank"); ct.body.append(olt); picks.append(ct.box);
        rankList(olt, top.tracks.slice(0, 10), t => t.artists.join(", "), pic);
        if (top.genres && top.genres.length) {
          const cg = card(0.11, "Top genres", "How many of your top artists play each one");
          const s = el("div", "screen"), box = el("div"); s.append(box); cg.body.append(s); picks.append(cg.box);
          hbars(box, top.genres.map(g => ({ label: g.name, value: g.count, shown: String(g.count), tip: g.name + ": " + g.count + " artists" })));
        }
      };
      pills(rangeBox, Object.keys(labels).filter(r => L.ranges[r]).map(r => [r, labels[r]]), pickRange, r => { pickRange = r; drawPicks(); });
      drawPicks();
    }

    // 3. Full listening history — drop Spotify's data download in, offline.
    body.append(el("h2", "stats-h", "Minutes listened"));
    body.append(el("p", "small", "Drop the my_spotify_data.zip that Spotify emails you (Account → Privacy → Download your data). " +
      "It's read right here and never uploaded."));
    const zone = el("label", "drop", "Drop your Spotify data .zip here, or choose it:");
    const input = el("input");
    input.type = "file"; input.accept = ".zip,.json"; input.multiple = true;
    zone.append(input);
    const status = el("p", "small");
    const out = el("div");
    body.append(zone, status, out);
    historyBoard = Charts.historyView(out);
    if (historyList) historyBoard.show(historyList); else out.hidden = true;
    Charts.dropZone(zone, input, async files => {
      status.textContent = "Reading your file…";
      try {
        historyList = await Charts.readHistory(files);
        out.hidden = false;
        historyBoard.show(historyList);
        status.textContent = "";
      } catch (e) { status.textContent = e.message || String(e); }
    });
  }

  // ---------- render ------------------------------------------------------
  function render() {
    const { tab, sub } = route();
    Object.entries(tabBtns).forEach(([id, b]) => {
      b.setAttribute("aria-selected", String(id === tab));
      b.tabIndex = id === tab ? 0 : -1;
    });
    tools.hidden = tab === "stats";
    body.textContent = "";
    const q = search.value.trim().toLowerCase();
    if (tab === "liked") viewLiked(q);
    else if (tab === "playlists") viewPlaylists(q, sub);
    else if (tab === "albums") viewAlbums(q);
    else if (tab === "artists") viewArtists(q);
    else viewStats();
    document.title = (tabBtns[tab] ? tabBtns[tab].textContent.replace(/ \(.*/, "") + " — " : "") + "My Music";
  }

  let searchTimer = 0;
  search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 150); });
  addEventListener("hashchange", () => { search.value = ""; render(); scrollTo(0, 0); });
  tabBar.addEventListener("keydown", e => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const ids = TABS.map(t => t[0]);
    const at = ids.indexOf(route().tab);
    const next = ids[(at + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
    location.hash = next;
    tabBtns[next].focus();
  });

  buildSettings();
  applySettings();
  render();
})();
