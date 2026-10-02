/* ============================================================
   SpotifyApi — a small, patient Web API client.

   Everything a backup needs is a GET that pages through a list, so this
   is just get() + getAll(), with the failure handling that makes a
   10,000-song library finish instead of dying on page 137:
     401 → refresh the login once and retry
     pacing → ~3 requests a second, slower after any 429 (dev-mode limits
           are small and shared by everyone using the app)
     429 → wait as long as Spotify's Retry-After says (counted down on
           screen), unless that's very long or the waits add up past
           maxTotalWaitSec — then end cleanly so the run can be Continued
     stalls → every request has a time limit
     5xx / network blip → retry with backoff, three times
   A Stop button aborts through `signal`; whatever was fetched by then is
   kept, because getAll() fills the caller's array as it goes.

   Every dependency is passed in so tests can run it without a browser.
   ============================================================ */
(function () {
  const API = "https://api.spotify.com/v1";

  class ApiError extends Error {
    constructor(status, message, url, extra = {}) {
      super(message || ("Spotify answered " + status));
      this.name = "ApiError";
      this.status = status;
      this.url = url;
      Object.assign(this, extra);
    }
  }

  function abortError() {
    const e = new Error("Stopped");
    e.name = "AbortError";
    return e;
  }

  /** A pause that Stop can cut short. */
  function pause(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const id = setTimeout(() => { if (signal) signal.removeEventListener("abort", stop); resolve(); }, ms);
      const stop = () => { clearTimeout(id); reject(abortError()); };
      if (signal) signal.addEventListener("abort", stop, { once: true });
    });
  }

  function createClient({
    getToken,
    refreshToken,
    fetchImpl = (...a) => fetch(...a),
    sleep = pause,
    onWait = () => {},
    signal = null,
    // Spotify's development-mode rate limit is small and, since 2026, shared
    // by everyone using the app, so requests are paced rather than fired
    // as fast as possible: ~3 a second, slowing down after any 429.
    minIntervalMs = 300,
    maxIntervalMs = 3000,
    // A single wait longer than this, or more than this much waiting in
    // total, ends the run cleanly (with Continue offered) instead of
    // leaving the page looking frozen.
    maxWaitSec = 300,
    maxTotalWaitSec = 300,
    timeoutMs = 30000,
    now = () => Date.now(),
  }) {
    const checkStop = () => { if (signal && signal.aborted) throw abortError(); };
    let interval = minIntervalMs, lastStart = 0, okStreak = 0, waitedSec = 0;

    async function pace() {
      const due = lastStart + interval - now();
      if (due > 0) await sleep(due, signal);
      lastStart = now();
    }

    /** One fetch with a time limit, so a stalled request can't hang the run. */
    async function fetchOnce(url, init) {
      const ctl = new AbortController();
      const onStop = () => ctl.abort();
      if (signal) signal.addEventListener("abort", onStop, { once: true });
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        return await fetchImpl(url, { ...init, signal: ctl.signal });
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onStop);
      }
    }

    async function get(pathOrUrl) {
      // Only ever follow `next` links back to the API itself.
      const url = pathOrUrl.startsWith(API + "/") ? pathOrUrl : API + pathOrUrl;
      let refreshed = false, serverRetries = 0, netRetries = 0, rateRetries = 0;
      for (;;) {
        checkStop();
        await pace();
        let res;
        try {
          res = await fetchOnce(url, { headers: { Authorization: "Bearer " + await getToken() } });
        } catch (e) {
          if (signal && signal.aborted) throw abortError();
          if (e.name === "AuthError") throw e;
          // Network blip or our own time limit: try again a few times.
          if (netRetries++ < 3) { await sleep(1000 * 2 ** netRetries, signal); continue; }
          throw new ApiError(0, "Couldn't reach Spotify. Check your internet connection and try again.", url, { network: true });
        }
        if (res.ok) {
          // Ease back toward full speed after a good run.
          if (++okStreak >= 20 && interval > minIntervalMs) { interval = Math.max(minIntervalMs, interval * 0.8); okStreak = 0; }
          return res.status === 204 ? null : res.json();
        }

        if (res.status === 401 && !refreshed) {
          refreshed = true;
          await refreshToken();
          continue;
        }
        if (res.status === 429) {
          okStreak = 0;
          interval = Math.min(maxIntervalMs, interval * 2);
          // Retry-After is only readable if Spotify exposes it to browsers;
          // without it, back off 5, 10, 20, 40, 60 s…
          const told = parseInt(res.headers.get("Retry-After") || "", 10);
          const wait = told > 0 ? told : Math.min(60, 5 * 2 ** rateRetries);
          rateRetries++;
          if (wait > maxWaitSec || waitedSec + wait > maxTotalWaitSec) {
            throw new ApiError(429, "Spotify asked us to slow down.", url, { retryAfter: Math.max(wait, 60) });
          }
          waitedSec += wait;
          onWait(wait, now() + wait * 1000);
          await sleep(wait * 1000 + 250, signal);
          continue;
        }
        if (res.status >= 500 && serverRetries++ < 3) {
          await sleep(1000 * 2 ** serverRetries, signal);
          continue;
        }
        let msg = "";
        try { const b = await res.json(); msg = (b.error && (b.error.message || b.error)) || ""; } catch (e) { /* not JSON */ }
        throw new ApiError(res.status, msg, url);
      }
    }

    /** Pages through a list by following Spotify's `next` links.
        `pick` finds the paging object in a response (most endpoints return
        it at the top level; /me/following tucks it under "artists").
        Items are pushed into `into` as they arrive so a stopped or failed
        run still has everything up to that point. */
    async function getAll(path, { into = [], pick = p => p, onPage = () => {} } = {}) {
      let url = path;
      while (url) {
        const page = pick(await get(url)) || {};
        into.push(...(page.items || []));
        onPage(into.length, typeof page.total === "number" ? page.total : null);
        url = page.next || null;
      }
      return into;
    }

    return { get, getAll };
  }

  window.SpotifyApi = { API, ApiError, createClient, pause };
})();
