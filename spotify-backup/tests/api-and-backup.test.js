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

test("get() gives up if Spotify keeps rate-limiting without saying for how long", async () => {
  let calls = 0;
  const api = createClient({
    getToken: async () => "t", refreshToken: async () => {},
    fetchImpl: async () => { calls++; return json({}, 429); },
    sleep: noSleep,
  });
  await assert.rejects(api.get("/me"), e => e.status === 429);
  assert.equal(calls, 9);
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

test("run() lists followed playlists by name and stops probing after repeated refusals", async () => {
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
  assert.equal(probes.length, 3);
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
