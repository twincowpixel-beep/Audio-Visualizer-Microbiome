/* ============================================================
   Backup — walks the account and builds one plain data object:

   {
     format: "spotify-backup", formatVersion: 1, createdAt, complete,
     account:    { id, name, url },
     likedSongs: { complete, total, tracks: [Track] }          | null
     playlists:  { complete, total, items: [Playlist] }        | null
     albums:     { complete, total, items: [Album] }           | null
     artists:    { complete, total, items: [Artist] }          | null
     warnings:   [string]
   }
   A section is null when it wasn't asked for or Spotify refused it. Track
   is the flat, service-neutral shape in normTrack() — the ISRC in it is
   what lets another service find the exact same recording later.

   One section failing (Spotify keeps retiring endpoints) only adds a
   warning; login problems, a long rate-limit or Stop end the whole run,
   and the caller still gets everything gathered so far via `data`.
   ============================================================ */
(function () {
  const PAGE = 50;   // the largest page size every list endpoint accepts

  // Spotify's picture servers don't send the header that lets a web page
  // download their images (CORS), so a direct fetch usually fails. On
  // Netlify, _redirects turns these same-site paths into server-side
  // fetches of the real image, which the page is allowed to read.
  // Keep this list and _redirects in step (a test checks).
  const IMAGE_PROXY = {
    "i.scdn.co": "/img/i/",
    "mosaic.scdn.co": "/img/mosaic/",
    "image-cdn-ak.spotifycdn.com": "/img/cdn-ak/",
    "image-cdn-fa.spotifycdn.com": "/img/cdn-fa/",
    "seed-mix-image.spotifycdn.com": "/img/seed-mix/",
    "blend-playlist-covers.spotifycdn.com": "/img/blend/",
    "pickasso.spotifycdn.com": "/img/pickasso/",
    "daily-mix.scdn.co": "/img/daily-mix/",
    "lineup-images.scdn.co": "/img/lineup/",
    "thisis-images.spotifycdn.com": "/img/thisis/",
  };

  // Playlist songs are only readable for playlists you own or collaborate
  // on (Spotify, Feb 2026). Followed playlists are still tried, but after
  // this many refusals in a row we stop asking and just list them.
  const FOLLOWED_PROBES = 1;   // each probe costs allowance (see spotify-api.js)

  function normTrack(t, extra = {}) {
    if (!t) {
      return { kind: "missing", title: "(no longer available on Spotify)", artists: [], album: "",
               releaseDate: "", durationMs: null, isrc: "", url: "", uri: "", isLocal: false, ...extra };
    }
    if (t.type === "episode") {
      const show = t.show || {};
      return { kind: "episode", title: t.name || "", artists: [show.publisher || show.name].filter(Boolean),
               album: show.name || "", releaseDate: t.release_date || "", durationMs: t.duration_ms ?? null,
               isrc: "", url: (t.external_urls && t.external_urls.spotify) || "", uri: t.uri || "",
               isLocal: false, ...extra };
    }
    const album = t.album || {};
    return {
      kind: t.is_local ? "local" : "track",
      title: t.name || "",
      artists: (t.artists || []).map(a => a && a.name).filter(Boolean),
      album: album.name || "",
      releaseDate: album.release_date || "",
      albumImage: smallImage(album.images),
      durationMs: t.duration_ms ?? null,
      isrc: (t.external_ids && t.external_ids.isrc) || "",
      url: (t.external_urls && t.external_urls.spotify) || "",
      uri: t.uri || "",
      isLocal: !!t.is_local,
      ...extra,
    };
  }

  /** Saved-track and playlist-item wrappers. Playlist items were renamed
      from `track` to `item` in 2026; accept either. */
  function normEntry(entry, position) {
    const t = entry ? (entry.item !== undefined ? entry.item : entry.track) : null;
    return normTrack(t, { position, addedAt: (entry && entry.added_at) || "" });
  }

  function normAlbum(entry, position) {
    const a = (entry && entry.album) || {};
    return {
      position,
      title: a.name || "",
      artists: (a.artists || []).map(x => x && x.name).filter(Boolean),
      releaseDate: a.release_date || "",
      imageUrl: smallImage(a.images),
      totalTracks: a.total_tracks ?? null,
      upc: (a.external_ids && a.external_ids.upc) || "",
      addedAt: (entry && entry.added_at) || "",
      url: (a.external_urls && a.external_urls.spotify) || "",
      uri: a.uri || "",
    };
  }

  function normArtist(a, position) {
    return {
      position,
      name: (a && a.name) || "",
      url: (a && a.external_urls && a.external_urls.spotify) || "",
      uri: (a && a.uri) || "",
    };
  }

  /** Normalise only the entries that arrived since last time. */
  function catchUp(raw, out, norm, start = 0) {
    while (out.length < start + raw.length) out.push(norm(raw[out.length - start], out.length + 1));
    return out;
  }

  /** Continuing a stopped run: keep what's already there up to the last
      full page and ask Spotify only for the rest. Returns { kept, start }. */
  function resumePoint(prevItems) {
    if (!prevItems || !prevItems.length) return { kept: [], start: 0 };
    const start = prevItems.length - (prevItems.length % PAGE);
    return { kept: prevItems.slice(0, start), start };
  }
  const withOffset = (path, start) => path + (start ? "&offset=" + start : "");

  /** Smallest picture that's still at least 64px — a thumbnail for lists. */
  function smallImage(images) {
    if (!Array.isArray(images) || !images.length) return "";
    const sorted = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
    return (sorted.find(i => (i.width || 0) >= 64) || sorted[0]).url || "";
  }

  function bigImage(images) {
    if (!Array.isArray(images) || !images.length) return "";
    // Usually largest-first, but not promised; null sizes sort last.
    return [...images].sort((a, b) => (b.width || 0) - (a.width || 0))[0].url || "";
  }

  // A refusal that means "this part of Spotify is off-limits", as opposed to
  // a login, network or rate-limit problem that should stop everything.
  function isRefusal(e) {
    return e && e.name === "ApiError" && [400, 403, 404, 410].includes(e.status);
  }

  /**
   * opts:  { liked, myPlaylists, followedPlaylists, albums, artists, covers }
   * ui:    { onStatus({ part, parts, label, done, total }), onLog(text) }
   * data:  pass an object in to keep partial results if the run throws.
   * ui.resume: the data of a run that stopped early (rate limit, Stop,
   *        lost connection). Finished parts are kept as they are and
   *        unfinished lists pick up from where they got to.
   */
  async function run(api, opts, ui = {}, data = {}) {
    const status = ui.onStatus || (() => {});
    const log = ui.onLog || (() => {});
    const fetchImpl = ui.fetchImpl || ((...a) => fetch(...a));

    // One picture as { type, bytes }: through the site's own image relay
    // first, then straight from Spotify. The relay is given up on after a
    // few misses with no successes (not on Netlify, e.g. testing locally).
    let relayHits = 0, relayMisses = 0;
    async function fetchImage(url) {
      const signal = ui.signal || undefined;
      const read = async res => {
        const type = res.headers.get("Content-Type") || "";
        if (!res.ok || !/^image\//i.test(type)) throw new Error("HTTP " + res.status + " " + type);
        return { type, bytes: new Uint8Array(await res.arrayBuffer()) };
      };
      let u = null;
      try { u = new URL(url); } catch (e) { throw new Error("bad picture link"); }
      const relay = IMAGE_PROXY[u.hostname];
      if (relay && ui.relay !== false && (relayHits > 0 || relayMisses < 3)) {
        try {
          const got = await read(await fetchImpl(relay + u.pathname.replace(/^\//, "") + u.search, { signal }));
          relayHits++;
          return got;
        } catch (e) {
          if (signal && signal.aborted) throw e;
          relayMisses++;
        }
      }
      return read(await fetchImpl(url, { signal }));
    }

    const prev = ui.resume || null;
    Object.assign(data, {
      format: "spotify-backup", formatVersion: 1,
      createdAt: new Date().toISOString(), complete: false,
      account: null, likedSongs: null, playlists: null, albums: null, artists: null, listening: null,
      warnings: [],
      covers: prev && prev.covers ? prev.covers.slice() : [],
      thumbs: prev && prev.thumbs ? prev.thumbs.slice() : [],
    });
    if (prev) log("Continuing from where the last run stopped.");

    const wantPlaylists = opts.myPlaylists || opts.followedPlaylists;
    const parts = [opts.liked, wantPlaylists, opts.albums, opts.artists, opts.stats].filter(Boolean).length || 1;
    let part = 0;

    const me = await api.get("/me");
    data.account = {
      id: me.id || "",
      name: me.display_name || me.id || "",
      url: (me.external_urls && me.external_urls.spotify) || "",
    };
    log("Logged in as " + data.account.name + ".");

    // ---- Liked songs ----------------------------------------------------
    if (opts.liked) {
      part++;
      const raw = [];
      const before = prev && prev.likedSongs;
      if (before && before.complete) {
        data.likedSongs = before;
        log("Liked songs: " + before.tracks.length.toLocaleString() + " kept from before.");
      } else {
      const { kept, start } = resumePoint(before && before.tracks);
      data.likedSongs = { complete: false, total: before ? before.total : null, tracks: kept };
      status({ part, parts, label: "Liked songs", done: start, total: data.likedSongs.total });
      try {
        await api.getAll(withOffset("/me/tracks?limit=" + PAGE, start), {
          into: raw,
          onPage: (done, total) => {
            data.likedSongs.total = total;
            catchUp(raw, data.likedSongs.tracks, normEntry, start);
            status({ part, parts, label: "Liked songs", done: start + done, total });
          },
        });
        data.likedSongs.complete = true;
        log("Liked songs: " + data.likedSongs.tracks.length.toLocaleString() + " saved.");
      } catch (e) {
        if (!isRefusal(e)) throw e;
        data.likedSongs = null;
        data.warnings.push("Liked songs: Spotify wouldn't share them (" + e.status + "), so they're not in this backup.");
        log("Liked songs: Spotify said no (" + e.status + ") — skipped.");
      }
      }
    }

    // ---- Playlists ------------------------------------------------------
    if (wantPlaylists) {
      part++;
      status({ part, parts, label: "Finding your playlists", done: 0, total: null });
      let list = [];
      try {
        list = await api.getAll("/me/playlists?limit=" + PAGE, {
          onPage: (done, total) => status({ part, parts, label: "Finding your playlists", done, total }),
        });
      } catch (e) {
        if (!isRefusal(e)) throw e;
        data.warnings.push("Playlists: Spotify wouldn't list them (" + e.status + "), so they're not in this backup.");
        log("Playlists: Spotify said no (" + e.status + ") — skipped.");
        list = null;
      }

      if (list) {
        // The same playlist can be listed twice (e.g. followed and in a folder).
        const seen = new Set();
        list = list.filter(p => p && p.id && !seen.has(p.id) && seen.add(p.id));
        list = list.filter(p => {
          const mine = p.owner && p.owner.id === data.account.id;
          return (mine || p.collaborative) ? opts.myPlaylists : opts.followedPlaylists;
        });
        data.playlists = { complete: false, total: list.length, items: [] };
        log("Found " + list.length + " playlist" + (list.length === 1 ? "" : "s") + ".");

        let followedRefusals = 0, followedBlocked = false;
        const earlier = new Map(((prev && prev.playlists && prev.playlists.items) || []).map(x => [x.id, x]));
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          const old = earlier.get(p.id);
          // Finished last time (or refused last time): keep it as it was.
          if (old && (old.complete || old.tracks === null)) {
            data.playlists.items.push(Object.assign({}, old, { position: i + 1 }));
            if (old.tracks === null && !old.mine && !old.collaborative && ++followedRefusals >= FOLLOWED_PROBES) followedBlocked = true;
            continue;
          }
          const mine = !!(p.owner && p.owner.id === data.account.id);
          const counts = p.items || p.tracks || {};   // renamed tracks → items in 2026
          const pl = {
            position: i + 1,
            id: p.id,
            name: p.name || "Untitled playlist",
            description: p.description || "",
            owner: (p.owner && (p.owner.display_name || p.owner.id)) || "",
            ownerId: (p.owner && p.owner.id) || "",
            mine,
            collaborative: !!p.collaborative,
            public: p.public ?? null,
            url: (p.external_urls && p.external_urls.spotify) || "",
            uri: p.uri || "",
            imageUrl: bigImage(p.images),
            totalOnSpotify: typeof counts.total === "number" ? counts.total : null,
            complete: false,
            tracks: [],
            note: "",
          };
          data.playlists.items.push(pl);
          const label = "Playlist " + (i + 1) + " of " + list.length + ": " + pl.name;
          status({ part, parts, label, done: i, total: list.length });

          const readable = mine || pl.collaborative;
          if (!readable && followedBlocked) {
            pl.tracks = null;
            pl.note = "Spotify only shares the songs of playlists you made or collaborate on.";
            continue;
          }
          const raw = [];
          const { kept, start } = resumePoint(old && old.tracks);
          pl.tracks = kept;
          try {
            await api.getAll(withOffset("/playlists/" + encodeURIComponent(p.id) +
                             "/items?limit=" + PAGE + "&additional_types=track,episode", start), {
              into: raw,
              onPage: () => catchUp(raw, pl.tracks, normEntry, start),
            });
            pl.complete = true;
            if (!readable) followedRefusals = 0;
            log(pl.name + ": " + pl.tracks.length.toLocaleString() + " song" + (pl.tracks.length === 1 ? "" : "s") + ".");
          } catch (e) {
            if (!isRefusal(e)) throw e;
            pl.tracks = null;
            if (readable) {
              pl.note = "Spotify wouldn't share this playlist's songs (" + e.status + ").";
              data.warnings.push(pl.name + ": " + pl.note);
            } else {
              pl.note = "Spotify only shares the songs of playlists you made or collaborate on.";
              if (++followedRefusals >= FOLLOWED_PROBES) followedBlocked = true;
            }
            log(pl.name + ": songs not available — name and link saved.");
          }
        }
        data.playlists.complete = true;
        const hidden = data.playlists.items.filter(p => !p.mine && !p.collaborative && !p.tracks).length;
        if (hidden) {
          data.warnings.push(hidden + " playlist" + (hidden === 1 ? "" : "s") + " you follow but didn't make: " +
            "Spotify only lets apps read the songs in playlists you own or collaborate on, so these are saved " +
            "as a name and link only. To keep their songs, open one in Spotify, select all the songs and add " +
            "them to a new playlist of your own, then run the backup again.");
        }
      }
    }

    // ---- Saved albums ---------------------------------------------------
    if (opts.albums) {
      part++;
      const raw = [];
      const before = prev && prev.albums;
      if (before && before.complete) {
        data.albums = before;
        log("Saved albums: " + before.items.length.toLocaleString() + " kept from before.");
      } else {
      const { kept, start } = resumePoint(before && before.items);
      data.albums = { complete: false, total: before ? before.total : null, items: kept };
      status({ part, parts, label: "Saved albums", done: start, total: data.albums.total });
      try {
        await api.getAll(withOffset("/me/albums?limit=" + PAGE, start), {
          into: raw,
          onPage: (done, total) => {
            data.albums.total = total;
            catchUp(raw, data.albums.items, normAlbum, start);
            status({ part, parts, label: "Saved albums", done: start + done, total });
          },
        });
        data.albums.complete = true;
        log("Saved albums: " + data.albums.items.length.toLocaleString() + ".");
      } catch (e) {
        if (!isRefusal(e)) throw e;
        data.albums = null;
        data.warnings.push("Saved albums: Spotify wouldn't share them (" + e.status + "), so they're not in this backup.");
        log("Saved albums: Spotify said no (" + e.status + ") — skipped.");
      }
      }
    }

    // ---- Followed artists -----------------------------------------------
    if (opts.artists) {
      part++;
      const raw = [];
      if (prev && prev.artists && prev.artists.complete) {
        data.artists = prev.artists;
        log("Followed artists: " + data.artists.items.length.toLocaleString() + " kept from before.");
      } else {
      data.artists = { complete: false, total: null, items: [] };
      status({ part, parts, label: "Followed artists", done: 0, total: null });
      try {
        await api.getAll("/me/following?type=artist&limit=" + PAGE, {
          into: raw,
          pick: r => r && r.artists,
          onPage: (done, total) => {
            data.artists.total = total;
            catchUp(raw, data.artists.items, normArtist);
            status({ part, parts, label: "Followed artists", done, total });
          },
        });
        data.artists.complete = true;
        log("Followed artists: " + data.artists.items.length.toLocaleString() + ".");
      } catch (e) {
        if (!isRefusal(e)) throw e;
        data.artists = null;
        data.warnings.push("Followed artists: Spotify wouldn't share them (" + e.status + "), so they're not in this backup.");
        log("Followed artists: Spotify said no (" + e.status + ") — skipped.");
      }
      }
    }

    // ---- Top picks snapshot (for the viewer's Stats tab) ----------------
    // What Spotify says your top artists and songs are today, kept so the
    // backup's own stats page still has them later.
    if (opts.stats && prev && prev.listening) {
      part++;
      data.listening = prev.listening;
      log("Top picks: kept from before.");
    } else if (opts.stats && window.LiveStats) {
      part++;
      status({ part, parts, label: "Your top picks", done: 0, total: null });
      try {
        const ranges = {};
        for (const r of Object.keys(LiveStats.RANGES)) ranges[r] = await LiveStats.fetchTop(api, r);
        let recent = null;
        try { recent = await LiveStats.fetchRecent(api); } catch (e) { if (!isRefusal(e)) throw e; }
        data.listening = { capturedAt: new Date().toISOString(), ranges, recent };
        log("Top picks: saved for 3 time ranges.");
      } catch (e) {
        if (!isRefusal(e)) throw e;
        data.warnings.push("Top picks: Spotify wouldn't share them (" + e.status + "). If you logged in before the " +
          "stats feature existed, log out and in again to allow it.");
        log("Top picks: Spotify said no (" + e.status + ") \u2014 skipped.");
      }
    }

    // ---- Cover pictures -------------------------------------------------
    // Spotify's image links will die with the account, so keep the pictures.
    // Not essential: any failure just leaves the link in the backup.
    if (opts.covers && data.playlists) {
      const have = new Set(data.covers.map(c => c.playlistId));     // kept from a run being continued
      const withArt = data.playlists.items.filter(p => p.imageUrl && !have.has(p.id));
      let failed = 0;
      for (let i = 0; i < withArt.length; i++) {
        if (ui.signal && ui.signal.aborted) break;
        status({ part, parts, label: "Cover pictures", done: i, total: withArt.length });
        const p = withArt[i];
        try {
          const { type, bytes } = await fetchImage(p.imageUrl);
          data.covers.push({ playlistId: p.id, type, bytes });
        } catch (e) {
          if (ui.signal && ui.signal.aborted) break;
          failed++;
        }
      }
      if (failed) {
        data.warnings.push(failed + " playlist cover" + (failed === 1 ? "" : "s") +
          " couldn't be saved into the backup, so the music page links to them instead: they show while you're online.");
      }
      if (withArt.length) log("Cover pictures: " + (withArt.length - failed) + " saved.");
    }

    // Album art for the music page: one small picture per album, shared by
    // every song on it. Six at a time keeps a big library from crawling.
    if (opts.covers && !(ui.signal && ui.signal.aborted)) {
      const urls = new Set();
      const songs = [
        ...((data.likedSongs && data.likedSongs.tracks) || []),
        ...((data.playlists && data.playlists.items) || []).flatMap(p => p.tracks || []),
      ];
      songs.forEach(t => t.albumImage && urls.add(t.albumImage));
      ((data.albums && data.albums.items) || []).forEach(a => a.imageUrl && urls.add(a.imageUrl));
      if (data.listening) {
        Object.values(data.listening.ranges).forEach(r => [...r.artists, ...r.tracks].forEach(x => x.image && urls.add(x.image)));
      }
      data.thumbs.forEach(t => urls.delete(t.url));                  // kept from a run being continued
      const list = [...urls];
      let next = 0, done = 0, failed = 0;
      const worker = async () => {
        while (next < list.length && !(ui.signal && ui.signal.aborted)) {
          const url = list[next++];
          try {
            const { type, bytes } = await fetchImage(url);
            data.thumbs.push({ url, type, bytes });
          } catch (e) {
            if (!(ui.signal && ui.signal.aborted)) failed++;
          }
          done++;
          if (done % 10 === 0 || done === list.length) {
            status({ part, parts, label: "Album pictures", done, total: list.length });
          }
        }
      };
      if (list.length) {
        status({ part, parts, label: "Album pictures", done: 0, total: list.length });
        await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
        if (failed) {
          data.warnings.push(failed + " album picture" + (failed === 1 ? "" : "s") +
            " couldn't be saved into the backup, so the music page links to them instead: they show while you're online.");
        }
        log("Album pictures: " + (list.length - failed) + " saved.");
      }
    }

    // Stop pressed during the cover pictures: everything else is in, but
    // the run should still read as stopped rather than "all done".
    if (ui.signal && ui.signal.aborted) {
      const e = new Error("Stopped");
      e.name = "AbortError";
      throw e;
    }
    data.complete = true;
    return data;
  }

  window.Backup = { IMAGE_PROXY, run, normTrack, normEntry, normAlbum, normArtist };
})();
