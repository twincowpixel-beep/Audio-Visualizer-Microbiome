// Run with:  node --test spotify-backup/tests/*.test.js
// The app's scripts are plain browser scripts that hang off `window`, so
// point `window` at Node's global object and load them in order.
const test = require("node:test");
const assert = require("node:assert/strict");

globalThis.window = globalThis;
require("../js/spotify-api.js");
require("../js/backup.js");

const { createClient, ApiError } = window.SpotifyApi;
const API = window.SpotifyApi.API;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
const noSleep = async () => {};

// ---------------------------------------------------------------- client
test("get() refreshes the token once on 401, then retries", async () => {
  let token = "old", refreshes = 0, calls = 0;
  const api = createClient({
    getToken: async () => token,
    refreshToken: async () => { refreshes++; token = "new"; },
    fetchImpl: async (url, init) => {
      calls++;
      return init.headers.Authorization === "Bearer new" ? json({ ok: 1 }) : json({}, 401);
    },
    sleep: noSleep,
  });
  assert.deepEqual(await api.get("/me"), { ok: 1 });
  assert.equal(refreshes, 1);
  assert.equal(calls, 2);
});

test("get() waits out a short 429 and reports the wait", async () => {
  const waits = [], slept = [];
  let n = 0;
  const api = createClient({
    getToken: async () => "t", refreshToken: async () => {},
    fetchImpl: async () => (n++ === 0 ? json({}, 429, { "Retry-After": "3" }) : json({ fine: true })),
    sleep: async ms => { slept.push(ms); },
    onWait: s => waits.push(s),
  });
  assert.deepEqual(await api.get("/me"), { fine: true });
  assert.deepEqual(waits, [3]);
  assert.ok(slept[0] >= 3000);
});

test("get() gives up cleanly on a very long 429", async () => {
  const api = createClient({
    getToken: async () => "t", refreshToken: async () => {},
    fetchImpl: async () => json({}, 429, { "Retry-After": "86400" }),
    sleep: noSleep, maxWaitSec: 120,
  });
  await assert.rejects(api.get("/me"), e => e instanceof ApiError && e.status === 429 && e.retryAfter === 86400);
});

test("get() backs off when Spotify keeps rate-limiting, then gives up within the time budget", async () => {
  const waits = [];
  const api = createClient({
    getToken: async () => "t", refreshToken: async () => {},
    fetchImpl: async () => json({}, 429), sleep: noSleep,
    onWait: s => waits.push(s), maxTotalWaitSec: 300,
  });
  await assert.rejects(api.get("/me"), e => e.status === 429 && e.retryAfter >= 60);
  assert.deepEqual(waits, [5, 10, 20, 40, 60, 60, 60]);   // backs off, never waits past the budget
  assert.ok(waits.reduce((a, b) => a + b, 0) <= 300);
});

test("requests are paced, and slow down further after a 429", async () => {
  let clock = 0;
  const starts = [];
  let n = 0;
  const api = createClient({
    getToken: async () => "t", refreshToken: async () => {},
    now: () => clock,
    sleep: async ms => { clock += ms; },
    fetchImpl: async () => { starts.push(clock); return n++ === 1 ? json({}, 429, { "Retry-After": "1" }) : json({}); },
    minIntervalMs: 300,
  });
  await api.get("/a");
  await api.get("/b");      // 429 once, then fine
  await api.get("/c");
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  assert.ok(gaps[0] >= 300, "second request waits its turn");
  assert.ok(gaps[2] >= 600, "after a 429 the gap doubles");
});

test("Stop cuts a long wait short straight away", async () => {
  const ctl = new AbortController();
  const api = createClient({
    getToken: async () => "t", refreshToken: async () => {},
    fetchImpl: async () => json({}, 429, { "Retry-After": "200" }),
    signal: ctl.signal, onWait: () => setTimeout(() => ctl.abort(), 20),
  });
  const t0 = Date.now();
  await assert.rejects(api.get("/me"), e => e.name === "AbortError");
  assert.ok(Date.now() - t0 < 2000);
});

test("a request that never answers times out and is retried, not left hanging", async () => {
  let calls = 0;
  const api = createClient({
    getToken: async () => "t", refreshToken: async () => {},
    sleep: noSleep, timeoutMs: 30,
    fetchImpl: (url, init) => { calls++; return calls < 3 ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("t", "AbortError")))) : Promise.resolve(json({ ok: 1 })); },
  });
  assert.deepEqual(await api.get("/me"), { ok: 1 });
  assert.equal(calls, 3);
});

test("get() retries server errors and network blips, then succeeds", async () => {
  const seq = [() => json({}, 503), () => { throw new TypeError("fetch failed"); }, () => json({ ok: true })];
  let i = 0;
  const api = createClient({
    getToken: async () => "t", refreshToken: async () => {},
    fetchImpl: async () => seq[i++](), sleep: noSleep,
  });
  assert.deepEqual(await api.get("/me"), { ok: true });
});

test("get() surfaces Spotify's error message for refusals", async () => {
  const api = createClient({
    getToken: async () => "t", refreshToken: async () => {},
    fetchImpl: async () => json({ error: { status: 403, message: "Forbidden" } }, 403), sleep: noSleep,
  });
  await assert.rejects(api.get("/me/albums"), e => e.status === 403 && e.message === "Forbidden" && e.url === API + "/me/albums");
});

test("getAll() follows next links and fills `into` as it goes", async () => {
  const pages = {
    [API + "/me/tracks?limit=2"]: { items: [1, 2], total: 5, next: API + "/me/tracks?offset=2&limit=2" },
    [API + "/me/tracks?offset=2&limit=2"]: { items: [3, 4], total: 5, next: API + "/me/tracks?offset=4&limit=2" },
    [API + "/me/tracks?offset=4&limit=2"]: { items: [5], total: 5, next: null },
  };
  const api = createClient({
    getToken: async () => "t", refreshToken: async () => {},
    fetchImpl: async url => json(pages[url]), sleep: noSleep,
  });
  const seen = [];
  const into = [];
  const out = await api.getAll("/me/tracks?limit=2", { into, onPage: (d, t) => seen.push([d, t]) });
  assert.equal(out, into);
  assert.deepEqual(into, [1, 2, 3, 4, 5]);
  assert.deepEqual(seen, [[2, 5], [4, 5], [5, 5]]);
});

test("get() stops immediately once the signal is aborted", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const api = createClient({
    getToken: async () => "t", refreshToken: async () => {},
    fetchImpl: async () => json({}), sleep: noSleep, signal: ctl.signal,
  });
  await assert.rejects(api.get("/me"), e => e.name === "AbortError");
});

// ---------------------------------------------------------------- backup
const track = (n, extra = {}) => ({
  type: "track", name: "Song " + n, artists: [{ name: "Artist " + n }],
  album: { name: "Album " + n, release_date: "2019-05-01" }, duration_ms: 225000,
  external_ids: { isrc: "USRC1" + String(n).padStart(6, "0") },
  external_urls: { spotify: "https://open.spotify.com/track/" + n }, uri: "spotify:track:" + n, ...extra,
});

/** A fake API: routes path prefixes to page arrays (or an ApiError). */
function fakeApi(routes) {
  const requested = [];
  const resolve = path => {
    requested.push(path);
    const key = Object.keys(routes).find(k => path.startsWith(k));
    if (!key) throw new ApiError(404, "no route " + path, path);
    const r = routes[key];
    if (r instanceof Error) throw r;
    return r;
  };
  return {
    requested,
    async get(path) { return resolve(path); },
    async getAll(path, { into = [], pick = p => p, onPage = () => {} } = {}) {
      const pages = resolve(path);
      for (const raw of pages) {
        const page = pick(raw);
        into.push(...page.items);
        onPage(into.length, page.total ?? null);
      }
      return into;
    },
  };
}

const ALL = { liked: true, myPlaylists: true, followedPlaylists: true, albums: true, artists: true, covers: false };

test("run() builds every section and normalises tracks", async () => {
  const api = fakeApi({
    "/me/tracks": [
      { items: [{ added_at: "2026-09-30T10:00:00Z", track: track(1) }], total: 2 },
      { items: [{ added_at: "2026-09-29T10:00:00Z", track: track(2, { is_local: true, external_ids: undefined }) }], total: 2 },
    ],
    "/me/playlists": [{ items: [
      { id: "p1", name: "Mine", owner: { id: "me", display_name: "Me" }, collaborative: false, items: { total: 2 },
        images: [{ url: "small", width: 60 }, { url: "big", width: 640 }], description: "Road &amp; trip" },
      { id: "p2", name: "Collab", owner: { id: "pal" }, collaborative: true, tracks: { total: 1 } },
    ], total: 2 }],
    "/playlists/p1/items": [{ items: [{ added_at: "x", item: track(3) }, { added_at: "y", item: null }], total: 2 }],
    "/playlists/p2/items": [{ items: [{ added_at: "z", track: { type: "episode", name: "Ep", show: { name: "Show" }, duration_ms: 60000 } }], total: 1 }],
    "/me/albums": [{ items: [{ added_at: "a", album: { name: "LP", artists: [{ name: "Band" }], release_date: "2001", total_tracks: 9 } }], total: 1 }],
    "/me/following": [{ artists: { items: [{ name: "Band", uri: "spotify:artist:b" }], total: 1 } }],
    "/me": { id: "me", display_name: "Me" },
  });
  const data = await window.Backup.run(api, ALL);
  assert.equal(data.complete, true);
  assert.deepEqual(data.account, { id: "me", name: "Me", url: "" });

  assert.equal(data.likedSongs.complete, true);
  assert.equal(data.likedSongs.tracks.length, 2);
  const [a, b] = data.likedSongs.tracks;
  assert.equal(a.title, "Song 1");
  assert.deepEqual([...a.artists], ["Artist 1"]);
  assert.equal(a.isrc, "USRC1000001");
  assert.equal(a.position, 1);
  assert.equal(a.addedAt, "2026-09-30T10:00:00Z");
  assert.equal(b.kind, "local");
  assert.equal(b.isrc, "");

  const [mine, collab] = data.playlists.items;
  assert.equal(mine.mine, true);
  assert.equal(mine.imageUrl, "big");
  assert.equal(mine.totalOnSpotify, 2);
  assert.equal(mine.tracks[0].title, "Song 3");
  assert.equal(mine.tracks[1].kind, "missing");
  assert.equal(collab.collaborative, true);
  assert.equal(collab.totalOnSpotify, 1);   // old `tracks.total` shape still understood
  assert.equal(collab.tracks[0].kind, "episode");
  assert.deepEqual([...collab.tracks[0].artists], ["Show"]);

  assert.equal(data.albums.items[0].title, "LP");
  assert.equal(data.artists.items[0].name, "Band");
  assert.deepEqual([...data.warnings], []);
});

test("run() lists followed playlists by name and stops probing after a refusal", async () => {
  const followed = Array.from({ length: 6 }, (_, i) => ({ id: "f" + i, name: "Followed " + i, owner: { id: "someone" } }));
  const api = fakeApi({
    "/me/playlists": [{ items: followed, total: 6 }],
    "/playlists/": new ApiError(403, "Forbidden", "x"),
    "/me": { id: "me", display_name: "Me" },
  });
  const data = await window.Backup.run(api, { ...ALL, liked: false, albums: false, artists: false });
  assert.equal(data.playlists.items.length, 6);
  assert.ok(data.playlists.items.every(p => p.tracks === null && /only shares/.test(p.note)));
  const probes = api.requested.filter(p => p.startsWith("/playlists/"));
  assert.equal(probes.length, 1, "one refusal is enough: each probe costs allowance");
  assert.equal(data.warnings.length, 1);
  assert.match(data.warnings[0], /6 playlists you follow/);
});

test("run() turns a refused section into a warning and carries on", async () => {
  const api = fakeApi({
    "/me/tracks": [{ items: [{ added_at: "x", track: track(1) }], total: 1 }],
    "/me/albums": new ApiError(410, "Gone", "x"),
    "/me/following": [{ artists: { items: [], total: 0 } }],
    "/me": { id: "me", display_name: "Me" },
  });
  const data = await window.Backup.run(api, { ...ALL, myPlaylists: false, followedPlaylists: false });
  assert.equal(data.complete, true);
  assert.equal(data.albums, null);
  assert.equal(data.likedSongs.tracks.length, 1);
  assert.match(data.warnings[0], /Saved albums/);
});

test("run() keeps partial results when something fatal happens mid-way", async () => {
  const api = fakeApi({
    "/me/tracks": [{ items: [{ added_at: "x", track: track(1) }], total: 1 }],
    "/me/playlists": new ApiError(429, "slow down", "x", { retryAfter: 9999 }),
    "/me": { id: "me", display_name: "Me" },
  });
  const data = {};
  await assert.rejects(window.Backup.run(api, ALL, {}, data), e => e.status === 429);
  assert.equal(data.complete, false);
  assert.equal(data.likedSongs.tracks.length, 1);
  assert.equal(data.account.name, "Me");
});

test("run() de-duplicates playlists and respects the mine/followed choices", async () => {
  const api = fakeApi({
    "/me/playlists": [{ items: [
      { id: "p1", name: "Mine", owner: { id: "me" } },
      { id: "p1", name: "Mine again", owner: { id: "me" } },
      { id: "f1", name: "Theirs", owner: { id: "x" } },
    ] }],
    "/playlists/p1/items": [{ items: [] }],
    "/me": { id: "me", display_name: "Me" },
  });
  const data = await window.Backup.run(api, { myPlaylists: true });
  assert.deepEqual(data.playlists.items.map(p => p.name), ["Mine"]);
});

test("pictures come through the site's relay when it works, straight from Spotify when it doesn't", async () => {
  const img = (type = "image/jpeg") => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": type } });
  const base = {
    "/me/playlists": [{ items: [{ id: "p1", name: "P", owner: { id: "me" }, images: [{ url: "https://i.scdn.co/image/cover", width: 300 }] }] }],
    "/playlists/p1/items": [{ items: [{ added_at: "x", item: track(1, { album: { name: "LP", images: [{ url: "https://i.scdn.co/image/alb", width: 64 }] } }) }] }],
    "/me": { id: "me", display_name: "Me" },
  };
  // 1. On Netlify: the relay answers, Spotify is never asked directly.
  const asked = [];
  const viaRelay = await window.Backup.run(fakeApi(base), { myPlaylists: true, covers: true },
    { fetchImpl: async url => { asked.push(url); return url.startsWith("/img/i/") ? img() : new Response("no", { status: 403 }); } });
  assert.deepEqual(asked.sort(), ["/img/i/image/alb", "/img/i/image/cover"]);
  assert.equal(viaRelay.covers.length, 1);
  assert.equal(viaRelay.thumbs.length, 1);
  assert.equal(viaRelay.warnings.length, 0);

  // 2. No relay (local testing): HTML 404s from the relay, the direct fetch works.
  const direct = await window.Backup.run(fakeApi(base), { myPlaylists: true, covers: true },
    { fetchImpl: async url => url.startsWith("/img/") ? new Response("<html>", { status: 404, headers: { "Content-Type": "text/html" } }) : img() });
  assert.equal(direct.covers.length + direct.thumbs.length, 2);

  // 3. Neither: pictures are left out with a warning that says they'll be linked.
  const none = await window.Backup.run(fakeApi(base), { myPlaylists: true, covers: true },
    { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  assert.equal(none.covers.length + none.thumbs.length, 0);
  assert.ok(none.warnings.some(w => /links to them instead/.test(w)));
});

test("run() continues a stopped backup instead of starting over", async () => {
  const prev = {
    account: { id: "me", name: "Me" },
    likedSongs: { complete: false, total: 120, tracks: Array.from({ length: 73 }, (_, i) => ({ title: "Old " + i, position: i + 1 })) },
    playlists: { items: [
      { id: "done", name: "Done", mine: true, complete: true, tracks: [{ title: "kept" }] },
      { id: "half", name: "Half", mine: true, complete: false, tracks: Array.from({ length: 50 }, () => ({ title: "x" })) },
    ] },
    listening: { capturedAt: "x", ranges: {} },
    covers: [], thumbs: [],
  };
  const api = fakeApi({
    "/me/tracks?limit=50&offset=50": [{ items: Array.from({ length: 70 }, (_, i) => ({ added_at: "x", track: track(100 + i) })), total: 120 }],
    "/me/playlists": [{ items: [{ id: "done", name: "Done", owner: { id: "me" } }, { id: "half", name: "Half", owner: { id: "me" } }] }],
    "/playlists/half/items?limit=50&additional_types=track,episode&offset=50": [{ items: [{ added_at: "x", item: track(9) }] }],
    "/me": { id: "me", display_name: "Me" },
  });
  const data = await window.Backup.run(api, { liked: true, myPlaylists: true, stats: true }, { resume: prev });
  assert.equal(data.complete, true);
  assert.equal(data.likedSongs.tracks.length, 120);              // 50 kept + 70 fetched from offset 50
  assert.equal(data.likedSongs.tracks[49].title, "Old 49");
  assert.equal(data.likedSongs.tracks[50].title, "Song 100");
  assert.equal(data.likedSongs.tracks[50].position, 51);
  assert.equal(data.playlists.items[0].tracks[0].title, "kept");
  assert.equal(data.playlists.items[1].tracks.length, 51);
  assert.ok(!api.requested.some(p => p.startsWith("/playlists/done")), "finished playlists aren't asked for again");
  assert.equal(data.listening, prev.listening);
});

test("Spotify's used-up allowance stops all requests until it resets", async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  try {
    let calls = 0, clock = 1_000_000;
    const api = createClient({
      getToken: async () => "t", refreshToken: async () => {}, sleep: noSleep, now: () => clock,
      fetchImpl: async () => { calls++; return json({ error: { status: 429, message: "Too many" }, reason: "QUOTA_EXCEEDED" }, 429); },
    });
    await assert.rejects(api.get("/me"), e => e.quota === true && e.retryAfter >= 13 * 3600 - 1);
    assert.equal(calls, 1, "no retries against a used-up allowance");
    await assert.rejects(api.get("/me/tracks"), e => e.quota === true);
    assert.equal(calls, 1, "and nothing is sent until it should have reset");
    clock += 14 * 3600 * 1000;
    await assert.rejects(api.get("/me"), e => e.quota === true);
    assert.equal(calls, 2, "after the reset time it asks again");
    window.SpotifyApi.quota.clear();
    assert.equal(window.SpotifyApi.quota.until(), 0);
  } finally {
    delete globalThis.localStorage;
  }
});
