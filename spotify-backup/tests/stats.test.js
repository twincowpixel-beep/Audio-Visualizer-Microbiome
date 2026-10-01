// Run with:  node --test spotify-backup/tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

globalThis.window = globalThis;
require("../js/zip.js");
require("../js/history.js");
require("../js/stats-live.js");
require("../js/exporters.js");

const H = window.ListenHistory;
const L = window.LiveStats;

// A one-file zip using real DEFLATE, the way Spotify's download is packed.
function deflatedZip(name, text) {
  const data = Buffer.from(text);
  const comp = zlib.deflateRawSync(data);
  const nameB = Buffer.from(name);
  const crc = window.Zip.crc32(new Uint8Array(data));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameB.length, 26);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
  cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(nameB.length, 28); cen.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, nameB, comp]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameB.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cen, nameB, end]);
}
const fileOf = (name, buf) => ({ name, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });

const ext = (ts, ms, track, artist, album = "LP") => ({
  ts, ms_played: ms, master_metadata_track_name: track, master_metadata_album_artist_name: artist,
  master_metadata_album_album_name: album, spotify_track_uri: "spotify:track:x",
});

test("readFiles inflates Spotify's zip and keeps only streaming-history files", async () => {
  const records = [ext("2025-03-01T10:00:00Z", 200000, "Song", "Band")];
  const zip = deflatedZip("Spotify Extended Streaming History/Streaming_History_Audio_2025.json", JSON.stringify(records));
  const out = await H.readFiles([fileOf("my_spotify_data.zip", zip)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].master_metadata_track_name, "Song");
  const stored = window.Zip.makeZip([{ path: "Spotify Account Data/StreamingHistory_music_0.json", data: "[]" },
                                     { path: "Spotify Account Data/Userdata.json", data: "{\"x\":1}" }]);
  assert.deepEqual(await H.readFiles([fileOf("a.zip", Buffer.from(stored))]), []);
});

test("normalise understands both formats and never double-counts", () => {
  const extended = [ext("2025-01-01T08:00:00Z", 60000, "A", "X"), { ts: "2025-01-01T09:00:00Z", ms_played: 1000 }];
  const basic = [{ endTime: "2025-01-01 08:01", artistName: "X", trackName: "A", msPlayed: 60000 }];
  assert.equal(H.normalise(basic).length, 1);
  const both = H.normalise([...extended, ...basic]);
  assert.equal(both.length, 1, "the basic copy is dropped when the extended history is present");
  assert.equal(both[0].extended, true);
  const pod = H.normalise([{ ts: "2025-01-01T08:00:00Z", ms_played: 5000, episode_name: "Ep", episode_show_name: "Show" }]);
  assert.equal(pod[0].podcast, true);
});

test("compute adds up minutes, plays, top lists and per-year totals", () => {
  const list = H.normalise([
    ext("2024-06-01T12:00:00Z", 180000, "One", "Alpha"),
    ext("2025-06-01T12:00:00Z", 240000, "One", "Alpha"),
    ext("2025-06-02T12:00:00Z", 10000, "Two", "Beta"),          // under 30 s: minutes yes, play no
    ext("2025-06-03T12:00:00Z", 120000, "Three", "Beta", "EP"),
    { ts: "2025-06-04T12:00:00Z", ms_played: 600000, episode_name: "Ep", episode_show_name: "Pod" },
  ]);
  const all = H.compute(list);
  assert.equal(all.totalMs, 180000 + 240000 + 10000 + 120000 + 600000);
  assert.equal(all.podcastMs, 600000);
  assert.equal(all.plays, 4);
  assert.equal(all.artistCount, 2);
  assert.deepEqual(all.years, [2024, 2025]);
  assert.equal(all.topArtists[0].name, "Alpha");
  assert.equal(all.topArtists[0].ms, 420000);
  assert.equal(all.topTracks[0].name, "One");
  assert.equal(all.topTracks[0].plays, 2);
  assert.deepEqual(all.byYear.map(y => y.year), [2024, 2025]);
  assert.equal(all.byHour.reduce((a, b) => a + b, 0), all.totalMs);

  const y2025 = H.compute(list, 2025);
  assert.equal(y2025.topArtists[0].name, "Alpha");
  assert.equal(y2025.topArtists[1].ms, 130000);
  assert.equal(y2025.plays, 3);
  assert.equal(y2025.byMonth.reduce((a, b) => a + b, 0), y2025.totalMs);
});

test("live summaries rank artists and songs, count genres, and cope without them", () => {
  const artists = [
    { name: "A", genres: ["indie", "rock"], images: [{ url: "big", width: 640 }, { url: "small", width: 64 }, { url: "tiny", width: 32 }] },
    { name: "B", genres: ["rock"], images: [] },
  ];
  const tracks = [{ name: "S", artists: [{ name: "A" }], album: { name: "LP", images: [{ url: "x", width: 300 }] } }];
  const top = L.summariseTop(artists, tracks);
  assert.equal(top.artists[0].image, "small");
  assert.equal(top.artists[1].image, "");
  assert.deepEqual(top.genres.map(g => [g.name, g.count]), [["rock", 2], ["indie", 1]]);
  assert.equal(top.tracks[0].image, "x");
  assert.equal(L.summariseTop([{ name: "A" }], []).genres, null);

  const recent = L.summariseRecent([
    { played_at: "2026-10-01T10:00:00Z", track: { name: "S", duration_ms: 120000, artists: [{ name: "A" }] } },
    { played_at: "2026-10-01T09:00:00Z", track: { name: "T", duration_ms: 60000, artists: [{ name: "B" }] } },
  ]);
  assert.equal(recent.minutes, 3);
  assert.equal(recent.artistCount, 2);
});

test("the music page embeds each album picture once and playlist covers inline", () => {
  const t = (n, img) => ({ kind: "track", title: "S" + n, artists: ["A"], album: "LP", releaseDate: "", durationMs: 1000,
    isrc: "", url: "", uri: "", isLocal: false, position: n, addedAt: "", albumImage: img });
  const data = {
    createdAt: "2026-10-01T12:00:00Z", complete: true, account: { name: "Sam" }, warnings: [],
    likedSongs: { complete: true, tracks: [t(1, "u1"), t(2, "u1"), t(3, "u2")] },
    playlists: { items: [{ id: "p1", name: "P", mine: true, tracks: [t(1, "u1")], complete: true, description: "", url: "" }] },
    albums: null, artists: null,
    covers: [{ playlistId: "p1", type: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
    thumbs: [{ url: "u1", type: "image/jpeg", bytes: new Uint8Array([4, 5]) }],
  };
  const html = window.Exporters.printableHtml(data);
  assert.equal((html.match(/data:image\/jpeg;base64,BAU=/g) || []).length, 1, "album picture embedded once");
  assert.equal((html.match(/class="art a0"/g) || []).length, 3);
  assert.equal((html.match(/class="art"/g) || []).length, 1, "song without a downloaded picture gets a blank square");
  assert.match(html, /<img class="cover" alt="" src="data:image\/png;base64,AQID">/);

  const { root, files } = window.Exporters.buildFiles(data);
  const json = JSON.parse(files.find(f => f.path === root + "/backup.json").data);
  assert.equal(json.thumbs, undefined);
});
