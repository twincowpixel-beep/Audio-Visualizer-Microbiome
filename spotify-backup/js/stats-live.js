/* ============================================================
   LiveStats — what the Web API will still tell us about listening:
     /me/top/artists, /me/top/tracks   (last 4 weeks / 6 months / ~1 year)
     /me/player/recently-played        (the last 50 plays only)
   No play counts or minutes come back — those live in the data download
   (see history.js). Genres are counted only if Spotify still sends them.
   ============================================================ */
(function () {
  const RANGES = { short_term: "last 4 weeks", medium_term: "last 6 months", long_term: "the last year" };

  function smallImage(images) {
    if (!Array.isArray(images) || !images.length) return "";
    // Smallest picture that's still at least 64px, else the smallest there is.
    const sorted = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
    return (sorted.find(i => (i.width || 0) >= 64) || sorted[0]).url || "";
  }

  function summariseTop(artistItems = [], trackItems = []) {
    const artists = artistItems.filter(Boolean).map((a, i) => ({
      rank: i + 1, name: a.name || "", image: smallImage(a.images),
      url: (a.external_urls && a.external_urls.spotify) || "", genres: Array.isArray(a.genres) ? a.genres : [],
    }));
    const tracks = trackItems.filter(Boolean).map((t, i) => ({
      rank: i + 1, name: t.name || "", artists: (t.artists || []).map(a => a && a.name).filter(Boolean),
      album: (t.album && t.album.name) || "", image: smallImage(t.album && t.album.images),
      url: (t.external_urls && t.external_urls.spotify) || "",
    }));
    // Genre = how many of your top artists carry it. Spotify may have
    // stopped sending genres (2026); then there's simply no genre chart.
    const counts = new Map();
    artists.forEach(a => a.genres.forEach(g => counts.set(g, (counts.get(g) || 0) + 1)));
    const genres = counts.size
      ? [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8)
          .map(([name, count]) => ({ name, count }))
      : null;
    return { artists, tracks, genres };
  }

  function summariseRecent(items = []) {
    const plays = items.filter(i => i && i.track).map(i => ({
      name: i.track.name || "", artists: (i.track.artists || []).map(a => a && a.name).filter(Boolean),
      image: smallImage(i.track.album && i.track.album.images), playedAt: i.played_at || "",
      ms: i.track.duration_ms || 0,
    }));
    return {
      plays,
      minutes: Math.round(plays.reduce((s, p) => s + p.ms, 0) / 60000),
      artistCount: new Set(plays.flatMap(p => p.artists)).size,
      since: plays.length ? plays[plays.length - 1].playedAt : "",
    };
  }

  async function fetchTop(api, range) {
    const [a, t] = await Promise.all([
      api.get("/me/top/artists?limit=50&time_range=" + range),
      api.get("/me/top/tracks?limit=50&time_range=" + range),
    ]);
    return summariseTop((a && a.items) || [], (t && t.items) || []);
  }

  async function fetchRecent(api) {
    const r = await api.get("/me/player/recently-played?limit=50");
    return summariseRecent((r && r.items) || []);
  }

  window.LiveStats = { RANGES, summariseTop, summariseRecent, fetchTop, fetchRecent, smallImage };
})();
