/* ============================================================
   SpotifyApi — a small, patient Web API client.

   Everything a backup needs is a GET that pages through a list, so this
   is just get() + getAll(), with the failure handling that makes a
   10,000-song library finish instead of dying on page 137:
     401 → refresh the login once and retry
     429 → wait as long as Spotify's Retry-After says (shown to the user),
           unless it asks for longer than maxWaitSec, or keeps saying it —
           then give up cleanly
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

  function createClient({
    getToken,
    refreshToken,
    fetchImpl = (...a) => fetch(...a),
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    onWait = () => {},
    signal = null,
    maxWaitSec = 120,
  }) {
    const checkStop = () => { if (signal && signal.aborted) throw abortError(); };

    async function get(pathOrUrl) {
      // Only ever follow `next` links back to the API itself.
      const url = pathOrUrl.startsWith(API + "/") ? pathOrUrl : API + pathOrUrl;
      let refreshed = false, serverRetries = 0, netRetries = 0, rateRetries = 0;
      for (;;) {
        checkStop();
        let res;
        try {
          res = await fetchImpl(url, {
            headers: { Authorization: "Bearer " + await getToken() },
            signal: signal || undefined,
          });
        } catch (e) {
          if (e.name === "AbortError" || (signal && signal.aborted)) throw abortError();
          if (e.name === "AuthError") throw e;
          if (netRetries++ < 3) { await sleep(1000 * 2 ** netRetries); continue; }
          throw new ApiError(0, "Couldn't reach Spotify. Check your internet connection and try again.", url, { network: true });
        }
        if (res.ok) return res.status === 204 ? null : res.json();

        if (res.status === 401 && !refreshed) {
          refreshed = true;
          await refreshToken();
          continue;
        }
        if (res.status === 429) {
          // Retry-After is only readable if Spotify exposes it to browsers;
          // without it, guess 5 seconds.
          const wait = parseInt(res.headers.get("Retry-After") || "", 10) || 5;
          if (wait > maxWaitSec || rateRetries++ >= 8) {
            throw new ApiError(429, "Spotify asked us to slow down.", url, { retryAfter: Math.max(wait, 60) });
          }
          onWait(wait);
          await sleep(wait * 1000 + 250);
          continue;
        }
        if (res.status >= 500 && serverRetries++ < 3) {
          await sleep(1000 * 2 ** serverRetries);
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

  window.SpotifyApi = { API, ApiError, createClient };
})();
