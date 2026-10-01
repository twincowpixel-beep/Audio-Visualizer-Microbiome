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

  // Playlist songs are only readable for playlists you own or collaborate
  // on (Spotify, Feb 2026). Followed playlists are still tried, but after
  // this many refusals in a row we stop asking and just list them.
  const FOLLOWED_PROBES = 3;

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
  function catchUp(raw, out, norm) {
    while (out.length < raw.length) out.push(norm(raw[out.length], out.length + 1));
    return out;
  }

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
   */
  async function run(api, opts, ui = {}, data = {}) {
    const status = ui.onStatus || (() => {});
    const log = ui.onLog || (() => {});
    const fetchImpl = ui.fetchImpl || ((...a) => fetch(...a));

    Object.assign(data, {
      format: "spotify-backup", formatVersion: 1,
      createdAt: new Date().toISOString(), complete: false,
      account: null, likedSongs: null, playlists: null, albums: null, artists: null,
      warnings: [], covers: [], thumbs: [],
    });

    const wantPlaylists = opts.myPlaylists || opts.followedPlaylists;
    const parts = [opts.liked, wantPlaylists, opts.albums, opts.artists].filter(Boolean).length || 1;
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
      data.likedSongs = { complete: false, total: null, tracks: [] };
      status({ part, parts, label: "Liked songs", done: 0, total: null });
      try {
        await api.getAll("/me/tracks?limit=" + PAGE, {
          into: raw,
          onPage: (done, total) => {
            data.likedSongs.total = total;
            catchUp(raw, data.likedSongs.tracks, normEntry);
            status({ part, parts, label: "Liked songs", done, total });
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
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
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
          try {
            await api.getAll("/playlists/" + encodeURIComponent(p.id) +
                             "/items?limit=" + PAGE + "&additional_types=track,episode", {
              into: raw,
              onPage: () => catchUp(raw, pl.tracks, normEntry),
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
      data.albums = { complete: false, total: null, items: [] };
      status({ part, parts, label: "Saved albums", done: 0, total: null });
      try {
        await api.getAll("/me/albums?limit=" + PAGE, {
          into: raw,
          onPage: (done, total) => {
            data.albums.total = total;
            catchUp(raw, data.albums.items, normAlbum);
            status({ part, parts, label: "Saved albums", done, total });
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

    // ---- Followed artists -----------------------------------------------
    if (opts.artists) {
      part++;
      const raw = [];
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

    // ---- Cover pictures -------------------------------------------------
    // Spotify's image links will die with the account, so keep the pictures.
    // Not essential: any failure just leaves the link in the backup.
    if (opts.covers && data.playlists) {
      const withArt = data.playlists.items.filter(p => p.imageUrl);
      let failed = 0;
      for (let i = 0; i < withArt.length; i++) {
        if (ui.signal && ui.signal.aborted) break;
        status({ part, parts, label: "Cover pictures", done: i, total: withArt.length });
        const p = withArt[i];
        try {
          const res = await fetchImpl(p.imageUrl, { signal: ui.signal || undefined });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const type = res.headers.get("Content-Type") || "image/jpeg";
          data.covers.push({ playlistId: p.id, type, bytes: new Uint8Array(await res.arrayBuffer()) });
        } catch (e) {
          if (ui.signal && ui.signal.aborted) break;
          failed++;
        }
      }
      if (failed) {
        data.warnings.push(failed + " cover picture" + (failed === 1 ? "" : "s") +
          " couldn't be downloaded; their web links are in the backup instead.");
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
      const list = [...urls];
      let next = 0, done = 0, failed = 0;
      const worker = async () => {
        while (next < list.length && !(ui.signal && ui.signal.aborted)) {
          const url = list[next++];
          try {
            const res = await fetchImpl(url, { signal: ui.signal || undefined });
            if (!res.ok) throw new Error("HTTP " + res.status);
            data.thumbs.push({ url, type: res.headers.get("Content-Type") || "image/jpeg",
                               bytes: new Uint8Array(await res.arrayBuffer()) });
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
            " couldn't be downloaded, so some songs show a blank square on the music page.");
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

  window.Backup = { run, normTrack, normEntry, normAlbum, normArtist };
})();
