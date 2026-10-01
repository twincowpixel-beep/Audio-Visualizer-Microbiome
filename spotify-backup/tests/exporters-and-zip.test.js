// Run with:  node --test spotify-backup/tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

globalThis.window = globalThis;
require("../js/exporters.js");
require("../js/zip.js");

const X = window.Exporters;
const { makeZip, crc32 } = window.Zip;

// ---------------------------------------------------------------- helpers
test("csvCell quotes commas, quotes and newlines, and defuses formulas", () => {
  assert.equal(X.csvCell("plain"), "plain");
  assert.equal(X.csvCell("a, b"), "\"a, b\"");
  assert.equal(X.csvCell("say \"hi\""), "\"say \"\"hi\"\"\"");
  assert.equal(X.csvCell("two\nlines"), "\"two\nlines\"");
  assert.equal(X.csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
  assert.equal(X.csvCell("@mention"), "'@mention");
  assert.equal(X.csvCell(null), "");
  assert.equal(X.csvCell(42), "42");
});

test("toCsv starts with a BOM and uses CRLF", () => {
  const csv = X.toCsv(["a", "b"], [[1, "x,y"]]);
  assert.equal(csv, "﻿a,b\r\n1,\"x,y\"\r\n");
});

test("safeName makes portable, unique file names", () => {
  assert.equal(X.safeName("AC/DC: Live?"), "AC_DC_ Live_");
  assert.equal(X.safeName("  ...dots...  "), "dots");
  assert.equal(X.safeName(""), "Untitled");
  assert.equal(X.safeName("CON"), "_CON");
  assert.equal([...X.safeName("x".repeat(200))].length, 80);
  const used = new Set();
  assert.equal(X.safeName("Chill", used), "Chill");
  assert.equal(X.safeName("chill", used), "chill (2)");
  assert.equal(X.safeName("Chill", used), "Chill (3)");
  // emoji are kept whole, never split into broken halves
  assert.equal(X.safeName("\u{1F3B8}".repeat(100)), "\u{1F3B8}".repeat(80));
});

test("fmtLength formats minutes and hours", () => {
  assert.equal(X.fmtLength(225000), "3:45");
  assert.equal(X.fmtLength(3723000), "1:02:03");
  assert.equal(X.fmtLength(null), "");
});

test("cleanDescription strips tags and decodes entities", () => {
  assert.equal(X.cleanDescription("Rock &amp; roll <a href=\"spotify:x\">here</a> &#x27;n&#39; more&nbsp;!"),
               "Rock & roll here 'n' more !");
  assert.equal(X.cleanDescription(""), "");
});

// ---------------------------------------------------------------- buildFiles
function sample() {
  const t = (n, extra = {}) => ({ kind: "track", title: "Song " + n, artists: ["Artist " + n], album: "Album",
    releaseDate: "2019-01-01", durationMs: 200000, isrc: "ISRC" + n, url: "https://open.spotify.com/track/" + n,
    uri: "spotify:track:" + n, isLocal: false, position: n, addedAt: "2026-09-0" + n + "T00:00:00Z", ...extra });
  return {
    format: "spotify-backup", formatVersion: 1, createdAt: "2026-10-01T12:00:00Z", complete: true,
    account: { id: "me", name: "Sam", url: "" },
    likedSongs: { complete: true, total: 2, tracks: [t(1), t(2, { title: "=SUM(A1)" })] },
    playlists: { complete: true, total: 3, items: [
      { position: 1, id: "p1", name: "Road/Trip", description: "Fun &amp; games", owner: "Sam", ownerId: "me", mine: true,
        collaborative: false, url: "https://open.spotify.com/playlist/p1", imageUrl: "x", totalOnSpotify: 1,
        complete: true, tracks: [t(3)], note: "" },
      { position: 2, id: "p2", name: "road/trip", description: "", owner: "Sam", ownerId: "me", mine: true,
        collaborative: false, url: "", imageUrl: "", totalOnSpotify: 0, complete: true, tracks: [], note: "" },
      { position: 3, id: "f1", name: "Their Hits", description: "", owner: "Pat", ownerId: "pat", mine: false,
        collaborative: false, url: "https://open.spotify.com/playlist/f1", imageUrl: "", totalOnSpotify: 50,
        complete: false, tracks: null, note: "Spotify only shares the songs of playlists you made or collaborate on." },
    ] },
    albums: { complete: true, total: 1, items: [{ position: 1, title: "LP", artists: ["Band"], releaseDate: "2001",
      totalTracks: 9, upc: "", addedAt: "", url: "", uri: "" }] },
    artists: { complete: true, total: 1, items: [{ position: 1, name: "<script>Band</script>", url: "", uri: "" }] },
    warnings: ["1 playlist you follow but didn't make: names only."],
    covers: [{ playlistId: "p1", type: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }],
  };
}

test("buildFiles lays out the backup folder", () => {
  const { root, files } = X.buildFiles(sample());
  assert.match(root, /^Spotify Backup - Sam - 2026-10-0[12]$/);   // local date, so allow for time zones
  const names = files.map(f => f.path.slice(root.length + 1)).sort();
  assert.deepEqual(names, [
    "Cover Pictures/Road_Trip.png",
    "Followed Artists.txt",
    "Liked Songs.txt",
    "My Music.html",
    "Playlists/Playlists you follow (names only).txt",
    "Playlists/Road_Trip.txt",
    "Playlists/road_trip (2).txt",
    "READ ME FIRST.txt",
    "Saved Albums.txt",
    "Spreadsheets/All Playlists.csv",
    "Spreadsheets/Everything.csv",
    "Spreadsheets/Followed Artists.csv",
    "Spreadsheets/Liked Songs.csv",
    "Spreadsheets/Playlists/Road_Trip.csv",
    "Spreadsheets/Playlists/road_trip (2).csv",
    "Spreadsheets/Saved Albums.csv",
    "backup.json",
  ]);
});

test("buildFiles content: text, CSV, JSON and the printable page", () => {
  const { root, files } = X.buildFiles(sample());
  const get = p => files.find(f => f.path === root + "/" + p).data;

  const liked = get("Liked Songs.txt");
  assert.match(liked, /LIKED SONGS/);
  assert.match(liked, /1\. Song 1 — Artist 1  ·  Album \(2019\)  ·  3:20/);

  const csv = get("Spreadsheets/Liked Songs.csv");
  assert.ok(csv.startsWith("﻿#,Song,Artist"));
  assert.match(csv, /\r\n2,'=SUM\(A1\),Artist 2/);

  const everything = get("Spreadsheets/Everything.csv");
  assert.match(everything, /Playlist: Road\/Trip,3,Song 3/);
  assert.equal(everything.trim().split("\r\n").length, 1 + 2 + 1);

  const followed = get("Playlists/Playlists you follow (names only).txt");
  assert.match(followed, /Their Hits — by Pat  \(50 songs\)/);
  assert.match(followed, /open\.spotify\.com\/playlist\/f1/);

  const json = JSON.parse(get("backup.json"));
  assert.equal(json.covers, undefined);
  assert.equal(json.likedSongs.tracks.length, 2);

  const html = get("My Music.html");
  assert.ok(!html.includes("<script>Band"), "names must be escaped");
  assert.match(html, /&lt;script&gt;Band/);
  assert.match(html, /“Fun &amp; games”/);
  assert.match(html, /Spotify only shares the songs/);

  const readme = get("READ ME FIRST.txt");
  assert.match(readme, /Liked songs: +2/);
  assert.match(readme, /Playlists: +3 \(1 song saved\)/);
  assert.doesNotMatch(readme, /stopped before it finished/);
});

test("an unfinished backup says so up front", () => {
  const data = sample();
  data.complete = false;
  data.likedSongs.complete = false;
  const { root, files } = X.buildFiles(data);
  const get = p => files.find(f => f.path === root + "/" + p).data;
  assert.match(get("READ ME FIRST.txt"), /stopped before it finished/);
  assert.match(get("Liked Songs.txt"), /stopped part-way/);
});

// ---------------------------------------------------------------- zip
test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xCBF43926);
});

/** Minimal reader: walks the central directory and pulls each entry back out. */
function readZip(zip) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const flags = dv.getUint16(p + 8, true);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    assert.equal(flags & 0x0800, 0x0800, "UTF-8 names flagged");
    assert.equal(dv.getUint32(local, true), 0x04034b50);
    const start = local + 30 + dv.getUint16(local + 26, true);
    const data = zip.subarray(start, start + size);
    assert.equal(crc32(data), crc, "crc for " + name);
    out[name] = data;
    p += 46 + nameLen;
  }
  return out;
}

test("makeZip round-trips text, bytes, folders and non-Latin names", () => {
  const zip = makeZip([
    { path: "Backup/READ ME.txt", data: "hello" },
    { path: "Backup/Playlists/Café \u{1F3B8}.txt", data: "déjà vu" },
    { path: "Backup/Cover Pictures/a.png", data: new Uint8Array([1, 2, 3]) },
  ], new Date(2026, 9, 1, 12, 0, 0));
  const entries = readZip(zip);
  assert.deepEqual(Object.keys(entries).sort(), [
    "Backup/", "Backup/Cover Pictures/", "Backup/Cover Pictures/a.png", "Backup/Playlists/",
    "Backup/Playlists/Café \u{1F3B8}.txt", "Backup/READ ME.txt",
  ]);
  const dec = new TextDecoder();
  assert.equal(dec.decode(entries["Backup/READ ME.txt"]), "hello");
  assert.equal(dec.decode(entries["Backup/Playlists/Café \u{1F3B8}.txt"]), "déjà vu");
  assert.deepEqual([...entries["Backup/Cover Pictures/a.png"]], [1, 2, 3]);
});
