/* ============================================================
   App — the four-step screen: Log in → Choose → Save → Download.
   (Plus a one-time Setup step only the page's owner ever sees.)

   Written for friends who aren't "computer people": one big button per
   step, plain-English errors that say what to do next, and nothing that
   can lose what's been fetched — Stop and failures still hand over a
   download of everything gathered so far.
   ============================================================ */
(function () {
  const $ = id => document.getElementById(id);
  const cfg = window.SPOTIFY_BACKUP_CONFIG || {};
  const OWNER = (cfg.OWNER_NAME || "").trim() || "the person who set this page up";
  const OWNER_EMAIL = (cfg.OWNER_EMAIL || "").trim();
  const { AuthError } = SpotifyAuth;

  // ===== House-style chrome ============================================
  // Every control gets its own soft hue (see house.js); the background
  // picker rotates the whole set, as Radio Jungle's palettes do.
  const HUE = {
    "app": 0.38,                      // Spotify-ish green window
    "login-btn": 0.38, "start-btn": 0.33, "download-btn": 0.58, "print-btn": 0.11,
    "stop-btn": 0.02, "logout-btn": 0.02, "logout2-btn": 0.02, "again-btn": 0.72, "continue-btn": 0.33,
    "quota-retry": 0.11, "saved-continue": 0.33, "saved-discard": 0.02,
    "copy-btn": 0.64, "save-id-btn": 0.33,
    "request-btn": 0.88, "send-request-btn": 0.88, "request-back-btn": 0.72, "request-done-back-btn": 0.72,
    "request-copy-btn": 0.64,
    "bg-btn": 0.95, "stats-login-btn": 0.38, "live-relogin": 0.38,
    // Stats cards each take their own colour so the page reads as a set of panels.
    "card-artists": 0.95, "card-tracks": 0.58, "card-genres": 0.11, "card-recent": 0.72,
    "card-h-artists": 0.95, "card-h-tracks": 0.58, "card-albums": 0.11, "card-h-time": 0.47,
    "card-h-clock": 0.72, "card-h-week": 0.64, "card-tutorial": 0.11,
  };
  const NOTICE_HUE = { error: 0.02, info: 0.11, ok: 0.33 };

  function bootChrome() {
    House.frame($("app"), HUE.app, { r: 10, border: 5 });
    document.querySelectorAll(".eb-btn").forEach(el => House.button(el, HUE[el.id] ?? 0.5));
    document.querySelectorAll(".card").forEach(el => House.frame(el, HUE[el.id] ?? 0.5, { r: 8, border: 4 }));
    // Tabs, step markers and pills are pixel buttons too, sunk in when selected.
    document.querySelectorAll(".tab").forEach((el, i) => House.toggle(el, [0.38, 0.95][i] ?? 0.5));
    document.querySelectorAll("#steps li").forEach((el, i) => House.toggle(el, [0.38, 0.33, 0.58, 0.11][i] ?? 0.5));
    document.querySelectorAll(".pill").forEach(el => House.toggle(el, 0.11));
    House.frame($("notice"), NOTICE_HUE.error, { r: 8, border: 4 });
    House.frame($("bg-picker"), HUE["bg-btn"], { r: 8, border: 4 });
    House.crt($("crt"));
    // No pixel text loose on a panel: titles, headings and labels get plates.
    House.autoPlate(".win-title, .stats-h, .card h3, .knob-value, .backdrop-row-label, .bg-picker > p", el =>
      el.classList.contains("win-title") ? 0.38 : House.hueOf(el, 0.11));
    // …and blocks of ordinary text sit on paper panels, never bare on a window.
    House.autoPaper(".lead, #tab-backup .small, #tab-stats > .small, .checks, .counts, .warnings, .setup-list, .copy-box");
    progressBar = DitherBar.create($("bar"));
    House.initTooltip();
  }

  // ===== Background picker =============================================
  function wireBackgrounds() {
    const box = $("swatches");
    const current = House.currentTheme();
    const tiles = [];
    House.THEMES.forEach(t => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      b.dataset.tip = t.name;
      b.setAttribute("aria-label", t.name);
      b.setAttribute("aria-pressed", String(t.id === current.id));
      box.append(b);
      const pb = House.swatch(b, t);
      pb.setSelected(t.id === current.id);
      tiles.push({ b, pb });
      b.addEventListener("click", () => {
        tiles.forEach(x => { x.b.setAttribute("aria-pressed", String(x.b === b)); x.pb.setSelected(x.b === b); });
        House.setTheme(t.id);
      });
    });
    House.setTheme(current.id);
    Backdrop.start();
    $("backdrop-controls").append(Backdrop.controls());
    $("bg-btn").addEventListener("click", () => {
      const open = $("bg-picker").hidden;
      $("bg-picker").hidden = !open;
      $("bg-btn").setAttribute("aria-expanded", String(open));
    });
  }

  // ===== Tabs ===========================================================
  const TAB_KEY = "spotify-backup.tab";
  function showTab(name) {
    ["backup", "stats"].forEach(t => {
      const on = t === name;
      $("tab-" + t).hidden = !on;
      $("tab-btn-" + t).setAttribute("aria-selected", String(on));
      $("tab-btn-" + t).tabIndex = on ? 0 : -1;
    });
    $("app").classList.toggle("wide", name === "stats");
    if (name === "stats") StatsUI.opened();
  }
  function wireTabs() {
    const tabs = [$("tab-btn-backup"), $("tab-btn-stats")];
    tabs.forEach((b, i) => {
      b.addEventListener("click", () => showTab(i ? "stats" : "backup"));
      b.addEventListener("keydown", e => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const next = tabs[(i + 1) % 2];
        next.focus();
        showTab(next === tabs[1] ? "stats" : "backup");
      });
    });
  }

  // ===== Steps & notices ===============================================
  const SECTIONS = ["setup", "login", "request", "choose", "run", "done"];
  const ORDER = ["login", "choose", "run", "done"];
  function show(step) {
    SECTIONS.forEach(s => { $("step-" + s).hidden = s !== step; });
    $("steps").hidden = step === "setup";
    const at = ORDER.indexOf(step === "request" ? "login" : step);
    document.querySelectorAll("#steps li").forEach(li => {
      const i = ORDER.indexOf(li.dataset.step);
      li.classList.toggle("active", i === at);
      li.classList.toggle("past", i < at);
      if (i === at) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
  }

  function notice(text, kind = "error") {
    $("notice-text").textContent = text;
    $("notice").setAttribute("role", kind === "error" ? "alert" : "status");
    $("notice").hidden = false;
    House.retint($("notice"), NOTICE_HUE[kind] ?? NOTICE_HUE.info);
  }
  function clearNotice() { $("notice").hidden = true; }

  /** Turn any failure into a sentence that says what to do next. */
  function friendly(e) {
    if (!e) return "Something went wrong. Please try again.";
    if (e instanceof AuthError) return e.message;
    if (e.name === "ApiError") {
      if (e.status === 403 && /\/v1\/me$/.test(e.url || "")) {
        return "This Spotify account hasn't been added to the backup page yet. Press “Request access” below " +
               "and " + OWNER + " will get an email asking to add you — then come back and log in again. " +
               "(If you ARE the owner: check your Spotify Premium is active — Spotify switches developer apps off without it.)";
      }
      if (e.quota) {
        return "Spotify's usage allowance for this app is used up for now. It's shared by everything on your " +
               "Spotify developer account (AudioBiome too) and resets after a long break \u2014 Spotify says 13\u201318 hours, " +
               "so try again around " + resetTime(e.until) + ". Anything already saved is kept: come back then and press " +
               "\u201cContinue\u201d. Asking again before then doesn't help, so this page won't.";
      }
      if (e.status === 429) {
        const mins = Math.max(1, Math.ceil((e.retryAfter || 60) / 60));
        return "Spotify asked this app to take a break for about " + mins + " minute" + (mins === 1 ? "" : "s") +
               " (its speed limit is shared by everyone using the app). Everything saved so far is ready below. " +
               "After the break, press \u201cContinue backup\u201d \u2014 it picks up where it stopped instead of starting over.";
      }
      if (e.network) return e.message;
      return "Spotify answered with an error (" + e.status + (e.message ? ": " + e.message : "") +
             "). Please try again in a minute.";
    }
    return "Something went wrong: " + (e.message || e) + ". Please try again.";
  }

  // ===== Spotify ========================================================
  function client(extra = {}) {
    return SpotifyApi.createClient({
      getToken: SpotifyAuth.getAccessToken,
      refreshToken: SpotifyAuth.refresh,
      ...extra,
    });
  }

  function resetTime(untilMs) {
    const d = new Date(untilMs || Date.now() + 13 * 3600e3);
    const sameDay = d.toDateString() === new Date().toDateString();
    return (sameDay ? "" : d.toLocaleDateString(undefined, { weekday: "long" }) + " ") +
           d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const quotaBlocked = () => SpotifyApi.quota.until() > Date.now();
  function quotaNotice() {
    notice(friendly({ name: "ApiError", status: 429, quota: true, until: SpotifyApi.quota.until() }), "info");
    $("quota-box").hidden = false;
  }

  // ---- unfinished backups survive closing the page (IndexedDB) ----------
  const Saved = (() => {
    const open = () => new Promise((res, rej) => {
      const r = indexedDB.open("spotify-backup", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction("kv", mode);
        const req = fn(t.objectStore("kv"));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      get: () => tx("readonly", s => s.get("unfinished")).catch(() => null),
      put: v => tx("readwrite", s => s.put(v, "unfinished")).catch(() => {}),
      clear: () => tx("readwrite", s => s.delete("unfinished")).catch(() => {}),
    };
  })();

  async function offerSaved() {
    const saved = await Saved.get();
    if (!saved || !saved.data) { $("saved-box").hidden = true; return; }
    unfinished = { opts: saved.opts, data: saved.data };
    const n = ((saved.data.likedSongs && saved.data.likedSongs.tracks.length) || 0) +
      ((saved.data.playlists && saved.data.playlists.items.reduce((s, p) => s + ((p.tracks && p.tracks.length) || 0), 0)) || 0);
    const who = saved.data.account && saved.data.account.name ? " (" + saved.data.account.name + ")" : "";
    $("saved-text").textContent = "You have an unfinished backup" + who + " from " +
      new Date(saved.savedAt).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" }) +
      " (" + n.toLocaleString() + " songs so far). Continue it to fetch only what's missing.";
    $("saved-box").hidden = false;
  }

  /** Show the Choose step straight away; the greeting's name is fetched
      in the background and never waited for. (Waiting for it is what left
      the page blank whenever Spotify was rate-limiting the app.) */
  async function toChoose() {
    $("who").textContent = sessionStorage.getItem("spotify-backup.name") || "there";
    show("choose");
    offerSaved();
    if (quotaBlocked()) { quotaNotice(); return; }            // don't spend allowance just to say hi
    if (sessionStorage.getItem("spotify-backup.name")) return; // already know the name this visit
    try {
      // maxWaitSec 0: if Spotify says "slow down", say so instead of waiting.
      const me = await client({ maxWaitSec: 0 }).get("/me");
      $("who").textContent = me.display_name || me.id || "there";
      try { sessionStorage.setItem("spotify-backup.name", $("who").textContent); } catch (err) { /* fine */ }
    } catch (e) {
      if (e.quota) { quotaNotice(); return; }
      if (e instanceof AuthError || (e.name === "ApiError" && e.status === 401)) {
        SpotifyAuth.logout();
        show("login");
        notice(friendly(e));
      } else if (e.name === "ApiError" && e.status === 403) {
        show("login");
        notice(friendly(e));
      } else if (e.name === "ApiError" && e.status === 429) {
        const mins = Math.max(1, Math.ceil((e.retryAfter || 60) / 60));
        notice("Spotify is asking this app to slow down right now (for about " + mins + " minute" + (mins === 1 ? "" : "s") +
               "). You can still press Start: the backup waits its turn with a countdown, and if the break is long it " +
               "stops cleanly so you can press Continue later.", "info");
      }
      // A network blip just leaves the greeting as "Hi, there".
    }
  }

  // ===== Setup (owner only) ============================================
  function showSetup() {
    $("redirect-uri").textContent = SpotifyAuth.redirectUri();
    $("client-id").value = SpotifyAuth.clientId();
    show("setup");
    const problem = SpotifyAuth.addressProblem();
    if (problem) notice(problem); else clearNotice();
  }

  function wireSetup() {
    $("copy-btn").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(SpotifyAuth.redirectUri());
        notice("Copied. Paste it into Redirect URIs in the Spotify dashboard, then press Save there.", "ok");
      } catch (e) {
        // No clipboard permission (or plain http): select it for a manual copy.
        const range = document.createRange();
        range.selectNodeContents($("redirect-uri"));
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
        notice("Your browser blocked copying. The address is selected — press Ctrl+C (or ⌘C) to copy it.", "info");
      }
    });
    $("save-id-btn").addEventListener("click", () => {
      const id = $("client-id").value.trim();
      if (!/^[0-9a-f]{32}$/i.test(id)) {
        notice("That doesn't look like a Client ID. It's 32 letters and numbers, under Settings → Basic Information in the dashboard.");
        return;
      }
      SpotifyAuth.setClientId(id);
      notice("Saved. You (and anyone you've added in User Management) can log in now. " +
             "To give friends a link that works without this step, put the Client ID in js/config.js.", "ok");
      show("login");
    });
  }

  // ===== Request access ================================================
  function showRequest() {
    clearNotice();
    $("request-form").hidden = false;
    $("request-done").hidden = true;
    show("request");
    $("req-name").focus();
  }

  function requestText(name, email) {
    return "Hi! Please add me to the Spotify Backup page.\n\nName: " + name + "\nSpotify email: " + email +
           "\n\n(Add me at developer.spotify.com/dashboard → your app → User Management.)";
  }
  const requestSubject = name => "Spotify Backup: access request from " + name;

  /** FormSubmit emails the owner directly — no account, one-time activation. */
  async function viaFormSubmit(name, email) {
    if (!OWNER_EMAIL && !cfg.FORMSUBMIT_ID) return false;
    const res = await fetch("https://formsubmit.co/ajax/" + encodeURIComponent(cfg.FORMSUBMIT_ID || OWNER_EMAIL), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        name, email,
        "what to do": "Add this person at developer.spotify.com/dashboard → your app → User Management (their name + this email).",
        _subject: requestSubject(name),
        _template: "table",
        _captcha: "false",
        _replyto: email,
      }),
    });
    const body = await res.json().catch(() => ({}));
    // Before the owner clicks "Activate Form", FormSubmit answers
    // success:"false" with a message about activation — not delivered.
    return res.ok && (body.success === true || body.success === "true");
  }

  /** Netlify Forms — only emails anyone if notifications are set up in Netlify. */
  async function viaNetlify(name, email) {
    const form = new URLSearchParams(new FormData($("request-form")));
    form.set("name", name);
    form.set("email", email);
    form.set("subject", requestSubject(name));
    form.set("what-to-do", "Add this person at developer.spotify.com/dashboard → your app → User Management (name + this email).");
    const res = await fetch("/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    return res.ok;
  }

  async function sendRequest(e) {
    e.preventDefault();
    const name = $("req-name").value.trim();
    const email = $("req-email").value.trim();
    if (!name) { notice("Please type your name.", "info"); $("req-name").focus(); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      notice("Please type the email address you use for Spotify.", "info"); $("req-email").focus(); return;
    }
    if ($("request-form").elements["bot-field"].value) return;   // a bot filled the hidden box
    clearNotice();
    const btn = $("send-request-btn");
    btn.disabled = true;
    let sent = false;
    for (const attempt of [viaFormSubmit, viaNetlify]) {
      try { sent = await attempt(name, email); } catch (err) { sent = false; }
      if (sent) break;
    }
    btn.disabled = false;

    $("request-form").hidden = true;
    $("request-done").hidden = false;
    const who = cfg.OWNER_NAME ? OWNER : "The owner";
    if (sent) {
      $("request-done-text").textContent = "Request sent! " + who + " will get an email and add " + email +
        " to the app. Spotify doesn't send a message when that's done, so just come back and try logging in later.";
      $("request-fallback").hidden = true;
    } else if (OWNER_EMAIL) {
      $("request-done-text").textContent = "The request couldn't be sent automatically, so here it is ready to send " +
        "yourself. Pick whichever is easiest:";
      const text = requestText(name, email);
      $("request-mailto").href = "mailto:" + OWNER_EMAIL + "?subject=" + encodeURIComponent(requestSubject(name)) +
        "&body=" + encodeURIComponent(text);
      $("request-gmail").href = "https://mail.google.com/mail/?view=cm&fs=1&to=" + encodeURIComponent(OWNER_EMAIL) +
        "&su=" + encodeURIComponent(requestSubject(name)) + "&body=" + encodeURIComponent(text);
      $("request-owner-email").textContent = OWNER_EMAIL;
      $("request-copy-text").textContent = text;
      $("request-fallback").hidden = false;
    } else {
      $("request-done-text").textContent = "The request couldn't be sent. Please ask " + OWNER +
        " directly to add " + email + " to the app.";
      $("request-fallback").hidden = true;
    }
  }

  async function copyRequest() {
    const text = $("request-copy-text").textContent;
    try {
      await navigator.clipboard.writeText(text);
      notice("Copied! Paste it into an email or message to " + OWNER_EMAIL + ".", "ok");
    } catch (e) {
      const range = document.createRange();
      range.selectNodeContents($("request-copy-text"));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      notice("Selected — press Ctrl+C (or ⌘C) to copy it.", "info");
    }
  }

  // ===== The backup run =================================================
  let controller = null;
  let progressBar = null;     // DitherBar, made in bootChrome
  let result = null;          // { blob, root, html, data }
  let fontDataUrl = null;

  function logLine(text) {
    const box = $("log");
    const div = document.createElement("div");
    div.textContent = text;
    box.appendChild(div);
    while (box.childNodes.length > 300) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  // While Spotify makes us wait, count down on screen so it never looks frozen.
  let waitTimer = 0;
  function stopCountdown() { clearInterval(waitTimer); waitTimer = 0; }
  function countdown(until) {
    stopCountdown();
    const tick = () => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, "0");
      $("run-label").textContent = "Spotify asked us to slow down \u2014 carrying on in " + mm + ":" + ss;
      $("run-part").textContent = "This is Spotify's speed limit, not a problem with your account. " +
        "Leave the page open, or press Stop to keep what's saved so far.";
      if (!left) stopCountdown();
    };
    tick();
    waitTimer = setInterval(tick, 1000);
    progressBar.set(null);
  }

  function setStatus({ part, parts, label, done, total }) {
    stopCountdown();
    let text = label;
    if (total) text += " — " + done.toLocaleString() + " of " + total.toLocaleString();
    else if (done) text += " — " + done.toLocaleString() + " so far";
    $("run-label").textContent = text;
    $("run-part").textContent = "Part " + part + " of " + parts + ". Please keep this page open until it's finished.";
    progressBar.set(total ? done / total : null);
  }

  function options() {
    return {
      liked: $("opt-liked").checked,
      myPlaylists: $("opt-mine").checked,
      followedPlaylists: $("opt-followed").checked,
      albums: $("opt-albums").checked,
      artists: $("opt-artists").checked,
      covers: $("opt-covers").checked,
      stats: $("opt-stats").checked,
    };
  }

  // The pixel font goes inside the printable page so it looks like home
  // even when opened years from now with no internet.
  async function loadFontDataUrl() {
    if (fontDataUrl !== null) return fontDataUrl;
    try {
      const buf = new Uint8Array(await (await fetch("fonts/saturno.ttf")).arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      fontDataUrl = "data:font/ttf;base64," + btoa(bin);
    } catch (e) {
      fontDataUrl = "";
    }
    return fontDataUrl;
  }

  // The viewer inside My Music.html is these files pasted into one page
  // (see Exporters.VIEWER_ASSETS). If any fail to load, the backup still
  // gets the simple static page instead.
  let viewerAssets;
  async function loadViewerAssets() {
    if (viewerAssets !== undefined) return viewerAssets;
    try {
      const get = async f => { const r = await fetch(f); if (!r.ok) throw new Error(f); return r.text(); };
      viewerAssets = {
        css: await Promise.all(Exporters.VIEWER_ASSETS.css.map(get)),
        js: await Promise.all(Exporters.VIEWER_ASSETS.js.map(get)),
      };
    } catch (e) {
      viewerAssets = null;
    }
    return viewerAssets;
  }

  function preventLeave(e) { e.preventDefault(); e.returnValue = ""; }

  // The last run that stopped early, so "Continue backup" can pick it up.
  let unfinished = null;     // { opts, data } — also kept in IndexedDB (Saved)

  async function start(resume = null) {
    if (quotaBlocked()) { show("choose"); quotaNotice(); return; }
    const opts = resume ? resume.opts : options();
    if (!opts.liked && !opts.myPlaylists && !opts.followedPlaylists && !opts.albums && !opts.artists) {
      notice("Tick at least one thing to save.", "info");
      return;
    }
    clearNotice();
    $("log").textContent = "";
    setStatus({ part: 1, parts: 1, label: "Getting ready…", done: 0, total: null });
    $("stop-btn").disabled = false;
    show("run");

    controller = new AbortController();
    const signal = controller.signal;
    addEventListener("beforeunload", preventLeave);
    // Phones dim and sleep mid-backup otherwise, which pauses the page.
    let wake = null;
    try { wake = await navigator.wakeLock.request("screen"); } catch (e) { /* not supported */ }

    const data = {};
    let failure = null;
    try {
      const api = client({
        signal,
        onWait: (sec, until) => {
          logLine("Spotify asked us to slow down \u2014 waiting " + (sec >= 90 ? Math.ceil(sec / 60) + " minutes" : sec + " seconds") + "\u2026");
          countdown(until);
        },
      });
      await Backup.run(api, opts, { onStatus: setStatus, onLog: logLine, signal, resume: resume && resume.data }, data);
    } catch (e) {
      if (e.name === "AbortError") logLine("Stopped.");
      else { failure = e; logLine("Problem: " + friendly(e)); }
    } finally {
      stopCountdown();
      removeEventListener("beforeunload", preventLeave);
      if (wake) wake.release().catch(() => {});
      controller = null;
    }

    if (!data.account) {
      // Failed before anything was saved — nothing to hand over.
      if (failure instanceof AuthError) { SpotifyAuth.logout(); show("login"); }
      else show("choose");
      notice(failure ? friendly(failure) : "Stopped before anything was saved.");
      return;
    }
    unfinished = data.complete ? null : { opts, data };
    // Keep an unfinished run across closing the page (e.g. to finish tomorrow).
    if (unfinished) Saved.put({ opts, data, savedAt: Date.now() }); else Saved.clear();
    await finish(data, failure);
  }

  async function finish(data, failure) {
    $("run-label").textContent = "Packing your backup…";
    const { root, files } = Exporters.buildFiles(data, {
      fontDataUrl: await loadFontDataUrl(),
      viewerAssets: await loadViewerAssets(),
      theme: House.currentTheme().id,
    });
    const zip = Zip.makeZip(files);
    const html = files.find(f => f.path.endsWith("/My Music.html")).data;
    result = { blob: new Blob([zip], { type: "application/zip" }), root, html, data };

    $("done-title").textContent = data.complete
      ? "All done! Your backup is ready."
      : "Stopped early \u2014 here's everything saved up to that point.";
    $("continue-btn").hidden = data.complete;
    const counts = $("done-counts");
    counts.textContent = "";
    const add = text => { const li = document.createElement("li"); li.textContent = text; counts.appendChild(li); };
    const n = (x, one, many) => x.toLocaleString() + " " + (x === 1 ? one : many || one + "s");
    if (data.likedSongs) add(n(data.likedSongs.tracks.length, "liked song"));
    if (data.playlists) {
      const items = data.playlists.items;
      const withSongs = items.filter(p => p.tracks);
      const songs = withSongs.reduce((s, p) => s + p.tracks.length, 0);
      add(n(withSongs.length, "playlist") + " with " + n(songs, "song"));
      const namesOnly = items.length - withSongs.length;
      if (namesOnly) add(n(namesOnly, "followed playlist") + " saved as name + link");
    }
    if (data.albums) add(n(data.albums.items.length, "saved album"));
    if (data.artists) add(n(data.artists.items.length, "followed artist"));
    if (data.covers && data.covers.length) add(n(data.covers.length, "cover picture"));
    showCoverStrip(data);

    const warn = $("done-warnings");
    warn.textContent = "";
    if (data.warnings.length) {
      const title = document.createElement("div");
      title.textContent = "Good to know:";
      const ul = document.createElement("ul");
      data.warnings.forEach(w => { const li = document.createElement("li"); li.textContent = w; ul.appendChild(li); });
      warn.append(title, ul);
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }

    show("done");
    if (failure) notice(friendly(failure), "info"); else clearNotice();
  }

  let stripUrls = [];
  function showCoverStrip(data) {
    stripUrls.forEach(u => URL.revokeObjectURL(u));
    stripUrls = [];
    const box = $("done-covers");
    box.textContent = "";
    // Saved pictures where we have them, Spotify's own links otherwise.
    const saved = new Map((data.covers || []).map(c => [c.playlistId, c]));
    ((data.playlists && data.playlists.items) || []).filter(p => saved.has(p.id) || p.imageUrl).slice(0, 24).forEach((p, i) => {
      const c = saved.get(p.id);
      let url = p.imageUrl;
      if (c) { url = URL.createObjectURL(new Blob([c.bytes], { type: c.type })); stripUrls.push(url); }
      const im = document.createElement("img");
      im.src = url;
      im.alt = p.name;
      im.dataset.tip = p.name;
      im.style.setProperty("--i", i);
      im.addEventListener("error", () => im.remove(), { once: true });
      box.append(im);
    });
    box.hidden = !box.childElementCount;
  }

  function download() {
    if (!result) return;
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.root + ".zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function openPrintable() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.html], { type: "text/html" }));
    const w = window.open(url, "_blank");
    if (!w) notice("Your browser blocked the new tab. The same page is inside the download, called “My Music.html”.", "info");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function logout(message) {
    SpotifyAuth.logout();
    try { sessionStorage.removeItem("spotify-backup.name"); } catch (e) { /* fine */ }
    StatsUI.forget();
    result = null;
    show("login");
    notice(message || "Logged out. To remove this page's access to your Spotify completely, go to spotify.com/account/apps.", "info");
  }

  // ===== Boot ===========================================================
  async function doLogin() {
    clearNotice();
    const problem = SpotifyAuth.addressProblem();
    if (problem) { showTab("backup"); notice(problem); return; }
    // Come back to whichever tab the login was started from.
    try { sessionStorage.setItem(TAB_KEY, $("tab-stats").hidden ? "backup" : "stats"); } catch (e) { /* storage blocked */ }
    try { await SpotifyAuth.login(); } catch (e) { showTab("backup"); notice(friendly(e)); }
  }

  async function boot() {
    bootChrome();
    wireBackgrounds();
    wireTabs();
    wireSetup();
    StatsUI.init({
      client,
      friendly,
      login: doLogin,
      relogin: () => { SpotifyAuth.logout(); StatsUI.forget(); doLogin(); },
    });
    $("login-btn").addEventListener("click", doLogin);
    $("start-btn").addEventListener("click", () => start());
    $("request-btn").addEventListener("click", showRequest);
    $("request-form").addEventListener("submit", sendRequest);
    $("request-copy-btn").addEventListener("click", copyRequest);
    $("request-back-btn").addEventListener("click", () => { clearNotice(); show("login"); });
    $("request-done-back-btn").addEventListener("click", () => { clearNotice(); show("login"); });
    $("stop-btn").addEventListener("click", () => {
      if (controller) { controller.abort(); $("stop-btn").disabled = true; logLine("Stopping…"); }
    });
    $("download-btn").addEventListener("click", download);
    $("print-btn").addEventListener("click", openPrintable);
    $("again-btn").addEventListener("click", () => { clearNotice(); show("choose"); });
    $("continue-btn").addEventListener("click", () => { if (unfinished) start(unfinished); });
    $("saved-continue").addEventListener("click", () => { if (unfinished) start(unfinished); });
    $("saved-discard").addEventListener("click", () => { unfinished = null; Saved.clear(); $("saved-box").hidden = true; });
    $("quota-retry").addEventListener("click", () => {
      SpotifyApi.quota.clear();
      $("quota-box").hidden = true;
      clearNotice();
      try { sessionStorage.removeItem("spotify-backup.name"); } catch (e) { /* fine */ }
      toChoose();
    });
    $("logout-btn").addEventListener("click", () => logout());
    $("logout2-btn").addEventListener("click", () => logout());

    const wantSetup = new URLSearchParams(location.search).has("setup");
    let returnTab = "backup";
    try { returnTab = sessionStorage.getItem(TAB_KEY) || "backup"; sessionStorage.removeItem(TAB_KEY); } catch (e) { /* storage blocked */ }
    try {
      if (await SpotifyAuth.handleRedirect()) {
        await toChoose();
        if (returnTab === "stats" && SpotifyAuth.isLoggedIn()) showTab("stats");
        return;
      }
    } catch (e) {
      show("login");
      notice(friendly(e));
      return;
    }
    if (wantSetup || !SpotifyAuth.clientId()) { showSetup(); return; }
    if (SpotifyAuth.isLoggedIn()) { await toChoose(); return; }
    show("login");
  }

  boot();
})();
