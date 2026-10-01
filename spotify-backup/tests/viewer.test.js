// Run with:  node --test spotify-backup/tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

globalThis.window = globalThis;
require("../js/exporters.js");
const X = window.Exporters;
const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");
const assets = { css: X.VIEWER_ASSETS.css.map(read), js: X.VIEWER_ASSETS.js.map(read) };

function sample() {
  const t = (n, extra = {}) => ({ kind: "track", title: "S" + n, artists: ["A"], album: "LP", releaseDate: "2001", durationMs: 1000,
    isrc: "", url: "https://open.spotify.com/track/" + n, uri: "spotify:track:" + n, isLocal: false, position: n, addedAt: "",
    albumImage: "u1", ...extra });
  return {
    createdAt: "2026-10-01T12:00:00Z", complete: true, account: { name: "Sam" }, warnings: ["note"],
    likedSongs: { complete: true, tracks: [t(1), t(2, { title: "</script><script>alert(1)</script>" })] },
    playlists: { items: [{ id: "p1", position: 1, name: "P", mine: true, tracks: [t(1)], complete: true,
      description: "Fun &amp; games", url: "" }] },
    albums: null, artists: null, listening: null,
    covers: [{ playlistId: "p1", type: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
    thumbs: [{ url: "u1", type: "image/jpeg", bytes: new Uint8Array([4, 5]) }],
  };
}

test("the viewer page embeds the data safely, pictures once, and the runtime", () => {
  const html = X.viewerHtml(sample(), { assets, theme: "ocean" });
  const m = html.match(/<script type="application\/json" id="music-data">([\s\S]*?)<\/script>/);
  assert.ok(m, "data block present");
  const data = JSON.parse(m[1]);
  assert.equal(data.likedSongs.tracks[1].title, "</script><script>alert(1)</script>", "round-trips exactly");
  assert.ok(!m[1].includes("</script"), "nothing in the data can close the tag");
  assert.deepEqual(data.pictures, { art: { u1: "a0" }, covers: { p1: "c0" } });
  assert.equal(data.theme, "ocean");
  assert.equal(data.playlists.items[0].descriptionText, "Fun & games");
  assert.equal(data.covers, undefined);
  assert.equal(data.thumbs, undefined);
  assert.equal((html.match(/\.a0\{background-image:url\(data:image\/jpeg;base64,BAU=\)\}/g) || []).length, 1);
  assert.match(html, /\.c0\{background-image:url\(data:image\/png;base64,AQID\)\}/);
  assert.ok(html.includes(X.viewerScript(assets.js)), "runtime pasted in unchanged");
});

test("buildFiles uses the viewer when its files are available, the static page otherwise", () => {
  const withViewer = X.buildFiles(sample(), { viewerAssets: assets });
  const page = withViewer.files.find(f => f.path.endsWith("/My Music.html")).data;
  assert.match(page, /id="music-data"/);
  const plain = X.buildFiles(sample()).files.find(f => f.path.endsWith("/My Music.html")).data;
  assert.doesNotMatch(plain, /id="music-data"/);
});

test("index.html allows exactly the current viewer script (re-run tools/csp-hash.js if this fails)", () => {
  const { viewerHash } = require("../tools/csp-hash.js");
  assert.ok(read("index.html").includes("script-src 'self' " + viewerHash() + ";"));
});
