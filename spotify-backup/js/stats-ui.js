/* ============================================================
   StatsUI — the Stats tab.

   Top half: "Your top picks" from the Web API (needs a login).
   Bottom half: minutes listened & all-time charts from Spotify's data
   download (no login needed — the file never leaves the browser).

   The chart pieces themselves live in charts.js, shared with the
   "My Music.html" viewer that ships inside every backup.
   ============================================================ */
(function () {
  const $ = id => document.getElementById(id);

  let deps = null;          // { client, friendly, login, relogin }
  let range = "short_term";
  const liveCache = {};
  let recentCache = null;

  const { el, fmt, img, rankList, hbars, tiles, pills, ago } = Charts;
  let historyBoard = null;  // Charts.historyView, made on first load

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
    status.textContent = "Reading your file\u2026";
    try {
      const list = await Charts.readHistory(files);
      if (!historyBoard) historyBoard = Charts.historyView($("history-out"));
      $("history-out").hidden = false;
      historyBoard.show(list);
      deps.setTutorial(false);    // they've done it — get the steps out of the way
      status.textContent = "";
    } catch (e) {
      status.textContent = /No listening history/.test(e.message) ? e.message
        : "Couldn't read that file: " + (e.message || e) + ". Try the .json files from inside the zip instead.";
    }
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
      House.setLabel(toggle, open ? "Hide" : "Show me how");
    };
    toggle.addEventListener("click", () => setTutorial($("tutorial-body").hidden));
    deps.setTutorial = setTutorial;

    Charts.dropZone($("drop-zone"), $("history-file"), loadHistory);
  }

  /** Called whenever the Stats tab is shown. */
  function opened() { loadLive(); }
  function forget() { Object.keys(liveCache).forEach(k => delete liveCache[k]); recentCache = null; }

  window.StatsUI = { init, opened, forget };
})();
