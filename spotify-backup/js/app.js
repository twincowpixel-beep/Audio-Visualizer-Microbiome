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
  // Same muted-pill recipe as Radio Jungle's bootUI: each control has its
  // own soft hue; frame, face, rim and label are derived from it.
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
  const HUE = {
    "app": 0.38,                      // Spotify-ish green window
    "login-btn": 0.38, "start-btn": 0.33, "download-btn": 0.58, "print-btn": 0.11,
    "stop-btn": 0.02, "logout-btn": 0.02, "logout2-btn": 0.02, "again-btn": 0.72,
    "copy-btn": 0.64, "save-id-btn": 0.33,
    "request-btn": 0.88, "send-request-btn": 0.88, "request-back-btn": 0.72, "request-done-back-btn": 0.72,
  };
  const NOTICE_HUE = { error: 0.02, info: 0.11, ok: 0.33 };
  let noticeFrame = null;

  function bootChrome() {
    const win = mutedStyle(HUE.app);
    new PixelFrame($("app"), { r: 10, border: 5, ...win });
    document.querySelectorAll(".eb-btn").forEach(el => {
      const s = mutedStyle(HUE[el.id] ?? 0.5);
      const big = el.classList.contains("big");
      new PixelButton(el, { r: big ? 12 : 10, border: 4, ...s });
      el.style.color = s.ink;
    });
    noticeFrame = new PixelFrame($("notice"), { r: 8, border: 4, ...mutedStyle(NOTICE_HUE.error) });
    // CRT panel: near-black phosphor screen inside a hard black rim.
    new PixelFrame($("crt"), {
      r: 6, border: 3, outline: "#111111", frame: "#111111", frameHi: "#111111", frameLo: "#111111",
      fill: "#0a0f0a", fillHi: "#0a0f0a", fillLo: "#0a0f0a", noGloss: true, noSmudge: true,
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
    noticeFrame.restyle(mutedStyle(NOTICE_HUE[kind] ?? NOTICE_HUE.info));
    $("notice").style.color = mutedStyle(NOTICE_HUE[kind] ?? NOTICE_HUE.info).ink;
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
      if (e.status === 429) {
        const mins = Math.max(1, Math.ceil((e.retryAfter || 60) / 60));
        return "Spotify asked us to take a break for about " + mins + " minute" + (mins === 1 ? "" : "s") +
               ". Everything saved so far is ready below; you can run the backup again later for the rest.";
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

  async function toChoose() {
    try {
      const me = await client().get("/me");
      $("who").textContent = me.display_name || me.id || "there";
      show("choose");
    } catch (e) {
      if (e instanceof AuthError || (e.name === "ApiError" && e.status === 401)) SpotifyAuth.logout();
      show("login");
      notice(friendly(e));
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

  function requestMailto(name, email) {
    const body = "Hi! Please add me to the Spotify Backup page.\n\nName: " + name +
                 "\nSpotify email: " + email +
                 "\n\n(Add me at developer.spotify.com/dashboard → your app → User Management.)";
    return "mailto:" + OWNER_EMAIL + "?subject=" + encodeURIComponent("Spotify Backup: access request from " + name) +
           "&body=" + encodeURIComponent(body);
  }

  async function sendRequest(e) {
    e.preventDefault();
    const name = $("req-name").value.trim();
    const email = $("req-email").value.trim();
    if (!name) { notice("Please type your name.", "info"); $("req-name").focus(); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      notice("Please type the email address you use for Spotify.", "info"); $("req-email").focus(); return;
    }
    clearNotice();
    const btn = $("send-request-btn");
    btn.disabled = true;
    const form = new URLSearchParams(new FormData($("request-form")));
    form.set("name", name);
    form.set("email", email);
    // Netlify uses a field called "subject" as the notification email's subject.
    form.set("subject", "Spotify Backup: access request from " + name);
    form.set("what-to-do", "Add this person at developer.spotify.com/dashboard → your app → User Management (name + this email).");
    let sent = false;
    try {
      const res = await fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      sent = res.ok;
    } catch (err) { /* offline, or not on Netlify: fall back to email */ }
    btn.disabled = false;

    $("request-form").hidden = true;
    $("request-done").hidden = false;
    const who = cfg.OWNER_NAME ? OWNER : "The owner";
    if (sent) {
      $("request-done-text").textContent = "Request sent! " + who + " will add " + email + " to the app. " +
        "Spotify doesn't send a message when that's done, so just come back and try logging in later.";
      $("request-fallback").hidden = true;
    } else if (OWNER_EMAIL) {
      $("request-done-text").textContent = "The request form isn't working right now, so here's an email with your " +
        "details already filled in. Press the link below, then press Send. (Or write to " + OWNER_EMAIL + " yourself.)";
      $("request-mailto").href = requestMailto(name, email);
      $("request-fallback").hidden = false;
    } else {
      $("request-done-text").textContent = "The request form isn't working right now. Please ask " + OWNER +
        " directly to add " + email + " to the app.";
      $("request-fallback").hidden = true;
    }
  }

  // ===== The backup run =================================================
  let controller = null;
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

  function setStatus({ part, parts, label, done, total }) {
    let text = label;
    if (total) text += " — " + done.toLocaleString() + " of " + total.toLocaleString();
    else if (done) text += " — " + done.toLocaleString() + " so far";
    $("run-label").textContent = text;
    $("run-part").textContent = "Part " + part + " of " + parts + ". Please keep this page open until it's finished.";
    const bar = $("bar");
    if (total) {
      const pct = Math.min(100, Math.round((done / total) * 100));
      bar.classList.remove("unknown");
      $("bar-fill").style.width = pct + "%";
      bar.setAttribute("aria-valuenow", String(pct));
    } else {
      bar.classList.add("unknown");
      bar.removeAttribute("aria-valuenow");
    }
  }

  function options() {
    return {
      liked: $("opt-liked").checked,
      myPlaylists: $("opt-mine").checked,
      followedPlaylists: $("opt-followed").checked,
      albums: $("opt-albums").checked,
      artists: $("opt-artists").checked,
      covers: $("opt-covers").checked,
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

  function preventLeave(e) { e.preventDefault(); e.returnValue = ""; }

  async function start() {
    const opts = options();
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
        onWait: sec => logLine("Spotify asked us to slow down — waiting " + sec + " second" + (sec === 1 ? "" : "s") + "…"),
      });
      await Backup.run(api, opts, { onStatus: setStatus, onLog: logLine, signal }, data);
    } catch (e) {
      if (e.name === "AbortError") logLine("Stopped.");
      else { failure = e; logLine("Problem: " + friendly(e)); }
    } finally {
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
    await finish(data, failure);
  }

  async function finish(data, failure) {
    $("run-label").textContent = "Packing your backup…";
    const { root, files } = Exporters.buildFiles(data, { fontDataUrl: await loadFontDataUrl() });
    const zip = Zip.makeZip(files);
    const html = files.find(f => f.path.endsWith("/My Music.html")).data;
    result = { blob: new Blob([zip], { type: "application/zip" }), root, html, data };

    $("done-title").textContent = data.complete
      ? "All done! Your backup is ready."
      : "Stopped early — here's everything saved up to that point.";
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
    result = null;
    show("login");
    notice(message || "Logged out. To remove this page's access to your Spotify completely, go to spotify.com/account/apps.", "info");
  }

  // ===== Boot ===========================================================
  async function boot() {
    bootChrome();
    wireSetup();
    $("login-btn").addEventListener("click", async () => {
      clearNotice();
      const problem = SpotifyAuth.addressProblem();
      if (problem) { notice(problem); return; }
      try { await SpotifyAuth.login(); } catch (e) { notice(friendly(e)); }
    });
    $("start-btn").addEventListener("click", start);
    $("request-btn").addEventListener("click", showRequest);
    $("request-form").addEventListener("submit", sendRequest);
    $("request-back-btn").addEventListener("click", () => { clearNotice(); show("login"); });
    $("request-done-back-btn").addEventListener("click", () => { clearNotice(); show("login"); });
    $("stop-btn").addEventListener("click", () => {
      if (controller) { controller.abort(); $("stop-btn").disabled = true; logLine("Stopping…"); }
    });
    $("download-btn").addEventListener("click", download);
    $("print-btn").addEventListener("click", openPrintable);
    $("again-btn").addEventListener("click", () => { clearNotice(); show("choose"); });
    $("logout-btn").addEventListener("click", () => logout());
    $("logout2-btn").addEventListener("click", () => logout());

    const wantSetup = new URLSearchParams(location.search).has("setup");
    try {
      if (await SpotifyAuth.handleRedirect()) { await toChoose(); return; }
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
