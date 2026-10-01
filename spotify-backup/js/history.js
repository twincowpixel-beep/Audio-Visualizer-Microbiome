/* ============================================================
   ListenHistory — real listening stats from Spotify's own data download.

   The Web API never says how many minutes you've listened; only the
   "Download your data" files do. Two flavours are understood:
     Extended streaming history  Streaming_History_Audio_*.json
        { ts, ms_played, master_metadata_track_name,
          master_metadata_album_artist_name, master_metadata_album_album_name,
          spotify_track_uri, episode_name, episode_show_name, ... }
     Account data (last year)    StreamingHistory_music_*.json
        { endTime: "2024-01-31 22:05", artistName, trackName, msPlayed }
   Drop the whole .zip Spotify emails you, or the .json files from it.
   Nothing leaves the browser.
   ============================================================ */
(function () {
  const PLAY_MS = 30000;   // a "play" is 30 s or more, same as Spotify and last.fm

  // ---------- reading the files ----------------------------------------
  /** Minimal ZIP reader: walks the central directory, inflates with the
      browser's own DecompressionStream. Returns [{ name, bytes }]. */
  async function unzip(buf, wanted = () => true) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("That file isn't a zip Spotify made.");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = [];
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith("/") || !wanted(name)) continue;
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = u8.subarray(start, start + csize);
      let bytes;
      if (method === 0) bytes = raw;
      else if (method === 8) {
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      } else continue;
      out.push({ name, bytes });
    }
    return out;
  }

  const HISTORY_FILE = /(streaming_?history|endsong)[^/]*\.json$/i;

  /** files: File objects (or { name, arrayBuffer() }). Returns raw records. */
  async function readFiles(files) {
    const texts = [];
    for (const f of files) {
      if (/\.zip$/i.test(f.name)) {
        for (const e of await unzip(await f.arrayBuffer(), n => HISTORY_FILE.test(n) && !/video/i.test(n))) {
          texts.push({ name: e.name, text: new TextDecoder().decode(e.bytes) });
        }
      } else if (/\.json$/i.test(f.name)) {
        texts.push({ name: f.name, text: new TextDecoder().decode(await f.arrayBuffer()) });
      }
    }
    const records = [];
    for (const t of texts) {
      let arr;
      try { arr = JSON.parse(t.text); } catch (e) { continue; }
      if (Array.isArray(arr)) records.push(...arr);
    }
    return records;
  }

  // ---------- normalising --------------------------------------------------
  /** → { t (ms since epoch), ms, track, artist, album, podcast, extended } */
  function normalise(raw) {
    const out = [];
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      if ("ts" in r || "ms_played" in r) {
        const t = Date.parse(r.ts);
        if (!isFinite(t)) continue;
        if (r.master_metadata_track_name) {
          out.push({ t, ms: +r.ms_played || 0, track: r.master_metadata_track_name,
                     artist: r.master_metadata_album_artist_name || "Unknown artist",
                     album: r.master_metadata_album_album_name || "", podcast: false, extended: true });
        } else if (r.episode_name) {
          out.push({ t, ms: +r.ms_played || 0, track: r.episode_name, artist: r.episode_show_name || "Podcast",
                     album: r.episode_show_name || "", podcast: true, extended: true });
        }
      } else if ("endTime" in r && "msPlayed" in r) {
        // "2024-01-31 22:05" is UTC in Spotify's account export.
        const t = Date.parse(String(r.endTime).replace(" ", "T") + ":00Z");
        if (!isFinite(t) || !r.trackName) continue;
        out.push({ t, ms: +r.msPlayed || 0, track: r.trackName, artist: r.artistName || "Unknown artist",
                   album: "", podcast: !!r.episodeName, extended: false });
      }
    }
    // The extended history covers everything the short one does — never count twice.
    const list = out.some(x => x.extended) ? out.filter(x => x.extended) : out;
    return list.sort((a, b) => a.t - b.t);
  }

  // ---------- the numbers --------------------------------------------------
  function topBy(map, key, n) {
    return [...map.values()].sort((a, b) => b[key] - a[key] || b.ms - a.ms).slice(0, n);
  }

  /** year: a number to look at one year, or null for everything. */
  function compute(list, year = null) {
    const rows = year == null ? list : list.filter(r => new Date(r.t).getFullYear() === year);
    const music = rows.filter(r => !r.podcast);
    const artists = new Map(), tracks = new Map(), albums = new Map();
    const byHour = new Array(24).fill(0), byWeekday = new Array(7).fill(0);
    const byYear = new Map(), byMonth = new Array(12).fill(0);
    let totalMs = 0, musicMs = 0, podcastMs = 0, plays = 0;

    for (const r of rows) {
      totalMs += r.ms;
      if (r.podcast) podcastMs += r.ms; else musicMs += r.ms;
      const d = new Date(r.t);
      byHour[d.getHours()] += r.ms;
      byWeekday[d.getDay()] += r.ms;
      byMonth[d.getMonth()] += r.ms;
      byYear.set(d.getFullYear(), (byYear.get(d.getFullYear()) || 0) + r.ms);
      const played = r.ms >= PLAY_MS ? 1 : 0;
      plays += played;
      if (r.podcast) continue;
      const add = (map, key, base) => {
        const e = map.get(key) || { ...base, ms: 0, plays: 0 };
        e.ms += r.ms; e.plays += played;
        map.set(key, e);
      };
      add(artists, r.artist, { name: r.artist });
      add(tracks, r.track + "\u0000" + r.artist, { name: r.track, artist: r.artist });
      if (r.album) add(albums, r.album + "\u0000" + r.artist, { name: r.album, artist: r.artist });
    }

    const days = new Set(rows.map(r => new Date(r.t).toDateString())).size;
    return {
      year,
      years: [...new Set(list.map(r => new Date(r.t).getFullYear()))].sort((a, b) => a - b),
      first: rows.length ? rows[0].t : null,
      last: rows.length ? rows[rows.length - 1].t : null,
      totalMs, musicMs, podcastMs, plays,
      activeDays: days,
      artistCount: artists.size,
      trackCount: tracks.size,
      topArtists: topBy(artists, "ms", 10),
      topTracks: topBy(tracks, "plays", 10),
      topAlbums: topBy(albums, "ms", 10),
      byHour, byWeekday, byMonth,
      byYear: [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([y, ms]) => ({ year: y, ms })),
      hasAlbums: music.some(r => r.album),
    };
  }

  // Not "History": that name is the browser's own history API.
  window.ListenHistory = { unzip, readFiles, normalise, compute, PLAY_MS };
})();
