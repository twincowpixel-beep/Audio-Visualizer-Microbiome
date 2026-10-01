/* ============================================================
   SpotifyAuth — "Log in with Spotify" using Authorization Code + PKCE.

   PKCE is the only login flow Spotify still allows for a page with no
   server: the old implicit grant (#access_token=… in the URL) was switched
   off in 2025, which is one of the usual reasons an older Spotify login
   "just stops working". No client secret is involved anywhere.

   Round trip:
     login()          → stash a random verifier + state, go to Spotify
     Spotify          → user approves, comes back to redirectUri()?code=…
     handleRedirect() → swap the code (+ verifier) for tokens
   Tokens live in sessionStorage, so closing the tab logs you out — the
   right default for friends who might be on a shared computer.
   ============================================================ */
(function () {
  const AUTH_URL  = "https://accounts.spotify.com/authorize";
  const TOKEN_URL = "https://accounts.spotify.com/api/token";
  // Read-only, and only what a backup needs.
  const SCOPES = [
    "playlist-read-private",
    "playlist-read-collaborative",
    "user-library-read",
    "user-follow-read",
  ];
  // The verifier has to survive the trip to Spotify and back. localStorage
  // rather than sessionStorage because some phones finish the login in a
  // different tab than the one that started it.
  const PENDING_KEY = "spotify-backup.pending";
  const TOKEN_KEY   = "spotify-backup.token";
  const CLIENT_KEY  = "spotify-backup.client-id";

  const cfg = window.SPOTIFY_BACKUP_CONFIG || {};

  class AuthError extends Error {
    constructor(message) { super(message); this.name = "AuthError"; }
  }

  function clientId() {
    return (cfg.CLIENT_ID || localStorage.getItem(CLIENT_KEY) || "").trim();
  }
  function clientIdFromConfig() { return !!(cfg.CLIENT_ID || "").trim(); }
  function setClientId(id) {
    id = (id || "").trim();
    if (id) localStorage.setItem(CLIENT_KEY, id); else localStorage.removeItem(CLIENT_KEY);
  }

  /** The address Spotify sends people back to. "…/index.html" and "…/" are
      different addresses to Spotify, so always use the bare folder form. */
  function redirectUri() {
    if (cfg.REDIRECT_URI) return cfg.REDIRECT_URI;
    return location.origin + location.pathname.replace(/index\.html$/, "");
  }

  /** Addresses Spotify refuses as a Redirect URI (rules since 2025):
      plain http is only allowed for 127.0.0.1 / [::1], and "localhost" is
      not allowed at all. Returns a friendly explanation, or null if fine. */
  function addressProblem() {
    const { protocol, hostname, port } = location;
    if (protocol === "file:") {
      return "This page was opened straight from a file. Spotify can only send you back to a web address. " +
             "Start a little local server (see README.md) or open the hosted copy.";
    }
    if (hostname === "localhost") {
      return "Spotify no longer accepts “localhost” as a login address. Open this page at " +
             "http://127.0.0.1" + (port ? ":" + port : "") + location.pathname + " instead.";
    }
    if (protocol === "http:" && hostname !== "127.0.0.1" && hostname !== "[::1]") {
      return "Spotify only allows logins on secure (https://) pages, apart from 127.0.0.1 for testing.";
    }
    return null;
  }

  // 64-letter alphabet so `byte & 63` picks a letter with no bias.
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function randomString(n) {
    return Array.from(crypto.getRandomValues(new Uint8Array(n)), b => ALPHABET[b & 63]).join("");
  }
  async function challengeFor(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function login() {
    if (!clientId()) throw new AuthError("This page hasn't been set up yet — it needs a Spotify Client ID.");
    const verifier = randomString(64);
    const state = randomString(16);
    const redirect = redirectUri();
    localStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state, redirect }));
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId(),
      scope: SCOPES.join(" "),
      redirect_uri: redirect,
      code_challenge_method: "S256",
      code_challenge: await challengeFor(verifier),
      state,
      // Always show Spotify's approval page, which names the account being
      // used — so nobody backs up whoever was last logged in on a shared PC.
      show_dialog: "true",
    });
    location.assign(AUTH_URL + "?" + params);
  }

  /** Call once on page load. Resolves true if we just came back from
      Spotify with a login, false if this was an ordinary page load, and
      throws AuthError (with a message fit for the user) if the login failed. */
  async function handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (!q.has("code") && !q.has("error")) return false;

    const pending = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
    localStorage.removeItem(PENDING_KEY);
    // Get the one-time code out of the address bar and the history.
    history.replaceState(null, "", location.pathname + location.hash);

    const err = q.get("error");
    if (err === "access_denied") {
      throw new AuthError("You pressed Cancel on Spotify's page — no harm done. Click “Log in with Spotify” whenever you're ready.");
    }
    if (err) throw new AuthError("Spotify didn't log you in (it said “" + err + "”). Please try again.");
    if (!pending || pending.state !== q.get("state")) {
      throw new AuthError("That login was started in another tab or has gone stale. Please click “Log in with Spotify” again.");
    }
    await tokenRequest({
      grant_type: "authorization_code",
      code: q.get("code"),
      redirect_uri: pending.redirect,
      code_verifier: pending.verifier,
    });
    return true;
  }

  async function tokenRequest(fields) {
    let res;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId(), ...fields }),
      });
    } catch (e) {
      throw new AuthError("Couldn't reach Spotify to finish logging in. Check your internet connection and try again.");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      const why = body.error_description || body.error || ("HTTP " + res.status);
      throw new AuthError("Spotify wouldn't finish the login: “" + why + "”. Please log in again.");
    }
    const prev = readToken();
    saveToken({
      access: body.access_token,
      // PKCE refreshes usually hand back a new refresh token; keep the old
      // one if this response didn't include it.
      refresh: body.refresh_token || (prev && prev.refresh) || null,
      // Renew a minute early so a long backup never sends a stale token.
      expiresAt: Date.now() + Math.max(60, (body.expires_in || 3600) - 60) * 1000,
    });
  }

  function readToken() {
    try { return JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null"); } catch (e) { return null; }
  }
  function saveToken(t) { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t)); }

  async function refresh() {
    const t = readToken();
    if (!t || !t.refresh) { logout(); throw new AuthError("Your Spotify login ran out. Please log in again."); }
    try {
      await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh });
    } catch (e) {
      logout();
      throw new AuthError("Your Spotify login ran out. Please log in again.");
    }
  }

  async function getAccessToken() {
    const t = readToken();
    if (!t) throw new AuthError("You're not logged in to Spotify any more. Please log in again.");
    if (Date.now() >= t.expiresAt) await refresh();
    return readToken().access;
  }

  function isLoggedIn() { return !!readToken(); }
  function logout() { sessionStorage.removeItem(TOKEN_KEY); }

  window.SpotifyAuth = {
    SCOPES, AuthError,
    clientId, clientIdFromConfig, setClientId, redirectUri, addressProblem,
    login, handleRedirect, getAccessToken, refresh, isLoggedIn, logout,
  };
})();
