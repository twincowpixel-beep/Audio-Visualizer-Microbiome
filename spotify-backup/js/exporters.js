/* ============================================================
   Exporters — turn the backup data object (see backup.js) into the
   files people actually keep:

   Spotify Backup - <name> - <date>/
     READ ME FIRST.txt        what's what, counts, anything that went wrong
     My Music.html            everything on one page — read it, print it
     Liked Songs.txt          plain text, one song per line
     Playlists/<name>.txt     one per playlist
     Saved Albums.txt, Followed Artists.txt
     Spreadsheets/*.csv       the same lists for Excel / Numbers / Sheets,
                              plus Everything.csv (every song, every list)
     Cover Pictures/          playlist artwork
     backup.json              all of it, for importing into tools later

   Pure functions over plain data, so they're tested without a browser.
   ============================================================ */
(function () {
  const NL = "\r\n";   // Notepad, TextEdit and Excel all read CRLF correctly

  // ---------- formatting helpers ----------------------------------------
  function fmtLength(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = n => String(n).padStart(2, "0");
    return h ? h + ":" + pad(m) + ":" + pad(sec) : m + ":" + pad(sec);
  }
  /** 2026-10-01 — unambiguous in every country, sorts correctly in a sheet. */
  function isoDay(iso) {
    return typeof iso === "string" ? iso.slice(0, 10) : "";
  }
  function localDay(d) {
    const pad = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function longDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  }
  function year(releaseDate) { return (releaseDate || "").slice(0, 4); }
  function plural(n, one, many) { return n.toLocaleString() + " " + (n === 1 ? one : (many || one + "s")); }

  /** Spotify playlist descriptions arrive as HTML (links, &#x27; and so on). */
  function cleanDescription(s) {
    if (!s) return "";
    const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
    return s.replace(/<[^>]*>/g, "")
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === "#") {
          const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : m;
        }
        return named[e.toLowerCase()] ?? m;
      })
      .replace(/\s+/g, " ").trim();
  }

  const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
  /** A file name that works on Windows, macOS and phones, unique within
      `used` (compared case-insensitively, as Windows and macOS do). */
  function safeName(name, used) {
    let s = String(name || "").normalize("NFC")
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
      .replace(/\s+/g, " ").trim()
      .replace(/^[. ]+|[. ]+$/g, "");
    if (!s) s = "Untitled";
    if (RESERVED.test(s)) s = "_" + s;
    if ([...s].length > 80) s = [...s].slice(0, 80).join("").replace(/[. ]+$/, "");
    if (!used) return s;
    let candidate = s, n = 2;
    while (used.has(candidate.toLowerCase())) candidate = s + " (" + n++ + ")";
    used.add(candidate.toLowerCase());
    return candidate;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
  }

  // ---------- CSV --------------------------------------------------------
  function csvCell(v) {
    let s = v == null ? "" : String(v);
    // A cell starting with = + - @ is run as a formula by spreadsheet apps.
    // A song called "=HYPERLINK(...)" should stay a song title.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
  }
  /** UTF-8 BOM so Excel shows accents and non-Latin titles correctly. */
  function toCsv(header, rows) {
    return "﻿" + [header, ...rows].map(r => r.map(csvCell).join(",")).join(NL) + NL;
  }

  const TRACK_HEADER = ["#", "Song", "Artist", "Album", "Release date", "Length", "Date added",
                        "ISRC", "Note", "Spotify link", "Spotify URI"];
  function trackNote(t) {
    return t.kind === "local" ? "Local file (not on Spotify)"
         : t.kind === "episode" ? "Podcast episode"
         : t.kind === "missing" ? "No longer available on Spotify" : "";
  }
  function trackRow(t) {
    return [t.position, t.title, t.artists.join(", "), t.album, t.releaseDate, fmtLength(t.durationMs),
            isoDay(t.addedAt), t.isrc, trackNote(t), t.url, t.uri];
  }

  // ---------- plain text -------------------------------------------------
  function trackLine(t, width) {
    const num = String(t.position).padStart(width) + ". ";
    if (t.kind === "missing") return num + t.title;
    let line = num + (t.title || "(untitled)");
    if (t.artists.length) line += " — " + t.artists.join(", ");
    const extra = [];
    if (t.album) extra.push(t.album + (year(t.releaseDate) ? " (" + year(t.releaseDate) + ")" : ""));
    if (fmtLength(t.durationMs)) extra.push(fmtLength(t.durationMs));
    if (extra.length) line += "  ·  " + extra.join("  ·  ");
    if (t.kind === "local") line += "  [local file]";
    if (t.kind === "episode") line += "  [podcast episode]";
    return line;
  }
  function trackListText(tracks) {
    const width = String(tracks.length).length;
    return tracks.map(t => "  " + trackLine(t, width)).join(NL);
  }
  function heading(title) {
    return title.toUpperCase() + NL + "=".repeat(Math.min(60, Math.max(3, [...title].length)));
  }

  function savedLine(data) {
    return "Spotify account: " + (data.account ? data.account.name : "?") +
           "  ·  saved " + longDate(data.createdAt);
  }

  function likedText(data) {
    const l = data.likedSongs;
    return [
      heading("Liked Songs"),
      plural(l.tracks.length, "song") + ", newest first" + (l.complete ? "" : "  (stopped part-way)"),
      savedLine(data),
      "",
      trackListText(l.tracks),
      "",
    ].join(NL);
  }

  function playlistText(data, pl) {
    const lines = [heading(pl.name)];
    const by = pl.mine ? "Your playlist" : "Playlist by " + (pl.owner || "someone else");
    lines.push(by + (pl.collaborative ? " (collaborative)" : "") + "  ·  " + plural(pl.tracks.length, "song") +
               (pl.complete ? "" : "  (stopped part-way)"));
    const desc = cleanDescription(pl.description);
    if (desc) lines.push("“" + desc + "”");
    if (pl.url) lines.push(pl.url);
    lines.push(savedLine(data), "", trackListText(pl.tracks), "");
    return lines.join(NL);
  }

  function namesOnlyText(data, list) {
    const lines = [
      heading("Playlists you follow (names and links only)"),
      "Spotify only lets apps read the songs in playlists you made or collaborate on,",
      "so these are saved as a name and a link. To keep a playlist's songs, open it in",
      "Spotify, select all its songs, add them to a new playlist of your own, then run",
      "the backup again.",
      savedLine(data),
      "",
    ];
    const width = String(list.length).length;
    list.forEach((pl, i) => {
      const count = pl.totalOnSpotify != null ? "  (" + plural(pl.totalOnSpotify, "song") + ")" : "";
      lines.push("  " + String(i + 1).padStart(width) + ". " + pl.name + " — by " + (pl.owner || "?") + count);
      if (pl.url) lines.push("  " + " ".repeat(width + 2) + pl.url);
    });
    lines.push("");
    return lines.join(NL);
  }

  function albumsText(data) {
    const a = data.albums, width = String(a.items.length).length;
    return [
      heading("Saved Albums"), plural(a.items.length, "album") + ", newest first", savedLine(data), "",
      ...a.items.map(x => "  " + String(x.position).padStart(width) + ". " + x.title +
        (x.artists.length ? " — " + x.artists.join(", ") : "") + (year(x.releaseDate) ? "  (" + year(x.releaseDate) + ")" : "")),
      "",
    ].join(NL);
  }

  function artistsText(data) {
    const a = data.artists, width = String(a.items.length).length;
    return [
      heading("Followed Artists"), plural(a.items.length, "artist"), savedLine(data), "",
      ...a.items.map(x => "  " + String(x.position).padStart(width) + ". " + x.name),
      "",
    ].join(NL);
  }

  function readmeText(data, counts) {
    const lines = [heading("Spotify Backup"), savedLine(data), ""];
    if (!data.complete) {
      lines.push("NOTE: this backup was stopped before it finished. It has everything",
                 "up to that point — run it again any time to get the rest.", "");
    }
    lines.push(
      "WHAT'S INSIDE",
      "  My Music.html ........ everything on one page. Double-click to open it in",
      "                         your web browser, then print it or “Save as PDF”.",
    );
    if (data.likedSongs) lines.push("  Liked Songs.txt ...... your liked songs, newest first.");
    if (counts.playlistFiles) lines.push("  Playlists/ ........... one text file per playlist.");
    if (data.albums) lines.push("  Saved Albums.txt ..... albums in your library.");
    if (data.artists) lines.push("  Followed Artists.txt . artists you follow.");
    lines.push(
      "  Spreadsheets/ ........ the same lists as .csv files. Open them with Excel,",
      "                         Numbers or Google Sheets. Everything.csv has every",
      "                         song from every list in one sheet, handy for searching.",
    );
    if (counts.covers) lines.push("  Cover Pictures/ ...... your playlists' artwork.");
    lines.push(
      "  backup.json .......... all of the above in a computer-friendly format, for",
      "                         importing into other music apps or tools later.",
      "",
      "COUNTS",
    );
    if (data.likedSongs) lines.push("  Liked songs:      " + data.likedSongs.tracks.length.toLocaleString());
    if (data.playlists) {
      lines.push("  Playlists:        " + data.playlists.items.length.toLocaleString() +
                 " (" + plural(counts.playlistSongs, "song") + " saved)");
    }
    if (data.albums) lines.push("  Saved albums:     " + data.albums.items.length.toLocaleString());
    if (data.artists) lines.push("  Followed artists: " + data.artists.items.length.toLocaleString());
    lines.push("");
    if (data.warnings.length) {
      lines.push("THINGS TO KNOW");
      data.warnings.forEach(w => lines.push(...wrap("- " + w, 76, "  ")));
      lines.push("");
    }
    lines.push(
      "TIPS",
      "  - Keep a copy somewhere other than this device: email it to yourself, or put",
      "    it on a USB stick or in Google Drive / iCloud / OneDrive.",
      "  - The ISRC column is a worldwide ID for each recording. Playlist-transfer",
      "    tools use it to find exactly the same song on Apple Music, YouTube Music,",
      "    Tidal and others.",
      "  - This is a snapshot. Make a fresh backup every few months.",
      "",
    );
    return lines.join(NL);
  }

  function wrap(text, width, indent) {
    const out = [];
    let line = "";
    for (const word of text.split(" ")) {
      if (line && (line + " " + word).length > width) { out.push(line); line = indent + word; }
      else line = line ? line + " " + word : word;
    }
    if (line) out.push(line);
    return out;
  }

  // ---------- printable page --------------------------------------------
  function base64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function imageDataUrl(type, bytes) {
    const safe = /^image\/(jpeg|png|webp|gif)$/i.test(type) ? type.toLowerCase() : "image/jpeg";
    return "data:" + safe + ";base64," + base64(bytes);
  }

  function printableHtml(data, { fontDataUrl = "" } = {}) {
    const sections = [], toc = [];
    // Album art is embedded once per album as a CSS class, so a song list
    // of 5,000 doesn't repeat the same picture 5,000 times. The page keeps
    // working with no internet and after the Spotify account is gone.
    const artClass = new Map();
    let artCss = "";
    (data.thumbs || []).forEach((t, i) => {
      artClass.set(t.url, "a" + i);
      artCss += ".a" + i + "{background-image:url(" + imageDataUrl(t.type, t.bytes) + ")}";
    });
    const art = url => artClass.size
      ? "<i class=\"art" + (artClass.has(url) ? " " + artClass.get(url) : "") + "\"></i>" : "";
    const coverFor = new Map((data.covers || []).map(c => [c.playlistId, imageDataUrl(c.type, c.bytes)]));
    const trackLi = t => {
      if (t.kind === "missing") return "<li class=\"gone\">" + art("") + escapeHtml(t.title) + "</li>";
      const extra = [t.album, year(t.releaseDate), fmtLength(t.durationMs)].filter(Boolean).join(" · ");
      const tag = t.kind === "local" ? " <em>[local file]</em>" : t.kind === "episode" ? " <em>[podcast]</em>" : "";
      return "<li>" + art(t.albumImage) + "<b>" + escapeHtml(t.title) + "</b>" +
        (t.artists.length ? " — " + escapeHtml(t.artists.join(", ")) : "") +
        (extra ? " <span>\u00b7 " + escapeHtml(extra) + "</span>" : "") + tag + "</li>";
    };
    const add = (id, title, meta, body, cover = "") => {
      toc.push("<li><a href=\"#" + id + "\">" + escapeHtml(title) + "</a></li>");
      sections.push("<section id=\"" + id + "\"><div class=\"sec-head\">" +
                    (cover ? "<img class=\"cover\" alt=\"\" src=\"" + cover + "\">" : "") +
                    "<div><h2>" + escapeHtml(title) + "</h2>" +
                    (meta ? "<p class=\"meta\">" + meta + "</p>" : "") + "</div></div>" + body + "</section>");
    };

    if (data.likedSongs) {
      const l = data.likedSongs;
      add("liked", "Liked Songs", escapeHtml(plural(l.tracks.length, "song") + ", newest first" + (l.complete ? "" : " (stopped part-way)")),
          "<ol>" + l.tracks.map(trackLi).join("") + "</ol>");
    }
    if (data.playlists) {
      data.playlists.items.forEach((pl, i) => {
        const meta = [pl.mine ? "Your playlist" : "By " + (pl.owner || "someone else")];
        if (pl.collaborative) meta.push("collaborative");
        if (pl.tracks) meta.push(plural(pl.tracks.length, "song") + (pl.complete ? "" : " (stopped part-way)"));
        else if (pl.totalOnSpotify != null) meta.push(plural(pl.totalOnSpotify, "song") + " on Spotify");
        let body = "";
        const desc = cleanDescription(pl.description);
        if (desc) body += "<p class=\"desc\">“" + escapeHtml(desc) + "”</p>";
        if (pl.url) body += "<p class=\"link\"><a href=\"" + escapeHtml(pl.url) + "\">" + escapeHtml(pl.url) + "</a></p>";
        body += pl.tracks ? "<ol>" + pl.tracks.map(trackLi).join("") + "</ol>"
                          : "<p class=\"note\">" + escapeHtml(pl.note || "Songs not available.") + "</p>";
        add("pl-" + (i + 1), pl.name, escapeHtml(meta.join(" · ")), body, coverFor.get(pl.id) || "");
      });
    }
    if (data.albums) {
      add("albums", "Saved Albums", escapeHtml(plural(data.albums.items.length, "album")),
          "<ol>" + data.albums.items.map(a => "<li>" + art(a.imageUrl) + "<b>" + escapeHtml(a.title) + "</b>" +
            (a.artists.length ? " — " + escapeHtml(a.artists.join(", ")) : "") +
            (year(a.releaseDate) ? " <span>\u00b7 " + escapeHtml(year(a.releaseDate)) + "</span>" : "") + "</li>").join("") + "</ol>");
    }
    if (data.artists) {
      add("artists", "Followed Artists", escapeHtml(plural(data.artists.items.length, "artist")),
          "<ol class=\"cols\">" + data.artists.items.map(a => "<li>" + escapeHtml(a.name) + "</li>").join("") + "</ol>");
    }

    const warn = data.warnings.length
      ? "<div class=\"warn\"><b>Things to know</b><ul>" + data.warnings.map(w => "<li>" + escapeHtml(w) + "</li>").join("") + "</ul></div>"
      : "";
    const fontFace = fontDataUrl
      ? "@font-face{font-family:Saturno;src:url(" + fontDataUrl + ") format(\"truetype\");}"
      : "";
    return "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
      "<title>My Music — Spotify backup " + escapeHtml(isoDay(data.createdAt)) + "</title><style>" + fontFace +
      ":root{--ink:#111;--muted:#5a5a5a;--rule:#111}" +
      "body{margin:0 auto;max-width:860px;padding:24px 16px 64px;background:#fff;color:var(--ink);" +
      "font:15px/1.5 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif}" +
      "h1,h2{font-family:Saturno,\"Courier New\",monospace;letter-spacing:0;font-weight:normal;font-synthesis:none}" +
      "h1{font-size:32px;line-height:32px;margin:0 0 4px}h2{font-size:16px;line-height:16px;margin:0}" +
      ".sec-head{display:flex;gap:14px;align-items:center;margin:36px 0 6px;padding-bottom:6px;border-bottom:3px solid var(--rule);break-after:avoid}" +
      ".sec-head .meta{margin:2px 0 0}nav h2{margin:28px 0 6px;padding-bottom:4px;border-bottom:3px solid var(--rule)}" +
      ".cover{width:84px;height:84px;object-fit:cover;border:2px solid var(--rule);box-shadow:3px 3px 0 var(--rule);flex:none}" +
      ".art{display:inline-block;width:28px;height:28px;margin:0 8px 0 2px;vertical-align:middle;border:1px solid var(--rule);" +
      "background:#e4e5ea center/cover no-repeat;-webkit-print-color-adjust:exact;print-color-adjust:exact}" + artCss +
      ".meta,.desc,.link,.note{margin:4px 0;color:var(--muted)}.link a{color:inherit;word-break:break-all}" +
      "ol{padding-left:3.2em;margin:10px 0}li{margin:1px 0;break-inside:avoid}li span{color:var(--muted)}" +
      "li.gone{color:var(--muted);font-style:italic}em{color:var(--muted);font-style:normal}" +
      ".cols{columns:2 220px}.toc{columns:2 220px;padding-left:1.4em}.toc a{color:inherit}" +
      ".warn{border:3px solid var(--rule);padding:8px 14px;margin:18px 0;box-shadow:4px 4px 0 var(--rule)}" +
      ".warn ul{margin:6px 0;padding-left:1.2em}" +
      "@media print{body{font-size:10.5pt;padding:0}h2{break-after:avoid}.warn{box-shadow:none}nav{display:none}}" +
      "</style></head><body><header><h1>My Music</h1><p class=\"meta\">" + escapeHtml(savedLine(data)) +
      (data.complete ? "" : " · <b>stopped before it finished</b>") + "</p></header>" + warn +
      "<nav><h2>Contents</h2><ol class=\"toc\">" + toc.join("") + "</ol></nav>" +
      sections.join("") + "</body></html>\n";
  }

  // ---------- the interactive viewer ("My Music.html") -------------------
  // The page is self-contained: these files' text is pasted into it. The
  // order matters — the site's Content-Security-Policy allows this exact
  // script by its SHA-256 (see tools/csp-hash.js), so any change to these
  // files means re-running that tool.
  const VIEWER_ASSETS = {
    css: ["css/shared.css", "css/viewer.css"],
    js: ["js/pixel-frame.js", "js/house.js", "js/backdrop.js", "js/history.js", "js/charts.js", "js/viewer-runtime.js"],
  };
  /** The one inline <script> of the viewer, from the files' texts. */
  function viewerScript(jsTexts) {
    return "\n" + jsTexts.join("\n;\n").replace(/<\/(script)/gi, "<\\/$1") + "\n";
  }

  function viewerHtml(data, { fontDataUrl = "", assets, theme = "dots" } = {}) {
    // Pictures become CSS classes so each album's art is stored once.
    // Ones that couldn't be saved are linked instead (they show online).
    const art = {}, covers = {};
    let picCss = "", remote = 0;
    const SAFE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(scdn\.co|spotifycdn\.com)\/[A-Za-z0-9\/_.~%-]+$/i;
    const link = url => {
      if (!url || !SAFE.test(url)) return "";
      const cls = "r" + remote++;
      picCss += "." + cls + "{background-image:url(\"" + url + "\")}\n";
      return cls;
    };
    (data.thumbs || []).forEach((t, i) => {
      art[t.url] = "a" + i;
      picCss += ".a" + i + "{background-image:url(" + imageDataUrl(t.type, t.bytes) + ")}\n";
    });
    (data.covers || []).forEach((c, i) => {
      covers[c.playlistId] = "c" + i;
      picCss += ".c" + i + "{background-image:url(" + imageDataUrl(c.type, c.bytes) + ")}\n";
    });
    ((data.playlists && data.playlists.items) || []).forEach(p => {
      if (!covers[p.id] && p.imageUrl) { const c = link(p.imageUrl); if (c) covers[p.id] = c; }
    });
    const wantArt = url => { if (url && !art[url]) { const c = link(url); if (c) art[url] = c; } };
    [...((data.likedSongs && data.likedSongs.tracks) || []),
     ...((data.playlists && data.playlists.items) || []).flatMap(p => p.tracks || [])].forEach(t => wantArt(t.albumImage));
    ((data.albums && data.albums.items) || []).forEach(a => wantArt(a.imageUrl));
    if (data.listening && data.listening.ranges) {
      Object.values(data.listening.ranges).forEach(r => [...(r.artists || []), ...(r.tracks || [])].forEach(x => wantArt(x.image)));
    }
    const view = Object.assign({}, data, { pictures: { art, covers }, theme });
    delete view.covers;
    delete view.thumbs;
    if (view.playlists) {
      view.playlists = Object.assign({}, view.playlists, {
        items: view.playlists.items.map(p => Object.assign({}, p, { descriptionText: cleanDescription(p.description) })),
      });
    }
    // Safe inside <script>: no "<" can close the tag early.
    const json = JSON.stringify(view).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    const fontFace = fontDataUrl
      ? "@font-face{font-family:\"Saturno\";src:url(" + fontDataUrl + ") format(\"truetype\");}\n" : "";
    return "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\n" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
      // Works offline and talks to nothing: links open Spotify, nothing else leaves the page.
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; " +
      "style-src 'unsafe-inline'; img-src data: blob: https://*.scdn.co https://*.spotifycdn.com; font-src data:; " +
      "base-uri 'none'; form-action 'none'\">\n" +
      "<title>My Music — Spotify backup " + escapeHtml(isoDay(data.createdAt)) + "</title>\n" +
      "<style>\n" + fontFace + assets.css.join("\n") + "\n" + picCss + "</style>\n</head>\n<body>\n" +
      "<noscript><p style=\"margin:24px\">This page needs JavaScript to show your music. Everything is also in the " +
      ".txt files and the Spreadsheets folder next to it.</p></noscript>\n" +
      "<script type=\"application/json\" id=\"music-data\">" + json + "</script>\n" +
      "<script>" + viewerScript(assets.js) + "</script>\n</body></html>\n";
  }

  // ---------- the whole backup ------------------------------------------
  function coverExt(type) {
    return /png/i.test(type) ? ".png" : /webp/i.test(type) ? ".webp" : ".jpg";
  }

  /** Returns { root, files: [{ path, data }] } ready for Zip.makeZip. */
  /** viewerAssets: { css: [text], js: [text] } in VIEWER_ASSETS order. Without
      them (e.g. the files couldn't be loaded) My Music.html falls back to the
      simple static page. */
  function buildFiles(data, { fontDataUrl = "", viewerAssets = null, theme = "dots" } = {}) {
    const root = safeName("Spotify Backup - " + (data.account ? data.account.name : "") + " - " +
                          localDay(new Date(data.createdAt)));
    const files = [];
    const put = (path, content) => files.push({ path: root + "/" + path, data: content });
    const everything = [];
    const counts = { playlistFiles: 0, playlistSongs: 0, covers: 0 };

    if (data.likedSongs) {
      put("Liked Songs.txt", likedText(data));
      put("Spreadsheets/Liked Songs.csv", toCsv(TRACK_HEADER, data.likedSongs.tracks.map(trackRow)));
      data.likedSongs.tracks.forEach(t => everything.push(["Liked Songs", ...trackRow(t)]));
    }

    if (data.playlists) {
      const used = new Set();
      const namesOnly = [];
      const index = [];
      const coverFor = new Map((data.covers || []).map(c => [c.playlistId, c]));
      for (const pl of data.playlists.items) {
        const name = safeName(pl.name, used);
        let file = "";
        if (pl.tracks) {
          file = "Playlists/" + name + ".txt";
          put(file, playlistText(data, pl));
          put("Spreadsheets/Playlists/" + name + ".csv", toCsv(TRACK_HEADER, pl.tracks.map(trackRow)));
          pl.tracks.forEach(t => everything.push(["Playlist: " + pl.name, ...trackRow(t)]));
          counts.playlistFiles++;
          counts.playlistSongs += pl.tracks.length;
        } else {
          namesOnly.push(pl);
        }
        const cover = coverFor.get(pl.id);
        if (cover) {
          put("Cover Pictures/" + name + coverExt(cover.type), cover.bytes);
          counts.covers++;
        }
        index.push([pl.position, pl.name, pl.owner, pl.mine ? "yes" : "no", pl.collaborative ? "yes" : "no",
                    pl.totalOnSpotify ?? "", pl.tracks ? pl.tracks.length : "", cleanDescription(pl.description),
                    pl.url, file || pl.note]);
      }
      if (namesOnly.length) {
        put("Playlists/" + safeName("Playlists you follow (names only)", used) + ".txt", namesOnlyText(data, namesOnly));
      }
      put("Spreadsheets/All Playlists.csv", toCsv(
        ["#", "Playlist", "Owner", "Yours", "Collaborative", "Songs on Spotify", "Songs saved",
         "Description", "Spotify link", "Saved as"], index));
    }

    if (data.albums) {
      put("Saved Albums.txt", albumsText(data));
      put("Spreadsheets/Saved Albums.csv", toCsv(
        ["#", "Album", "Artist", "Release date", "Tracks", "Date added", "UPC", "Spotify link", "Spotify URI"],
        data.albums.items.map(a => [a.position, a.title, a.artists.join(", "), a.releaseDate, a.totalTracks ?? "",
                                    isoDay(a.addedAt), a.upc, a.url, a.uri])));
    }
    if (data.artists) {
      put("Followed Artists.txt", artistsText(data));
      put("Spreadsheets/Followed Artists.csv", toCsv(
        ["#", "Artist", "Spotify link", "Spotify URI"],
        data.artists.items.map(a => [a.position, a.name, a.url, a.uri])));
    }

    if (everything.length) put("Spreadsheets/Everything.csv", toCsv(["Found in", ...TRACK_HEADER], everything));

    const json = Object.assign({}, data);
    delete json.covers;   // pictures are files of their own; keep the JSON readable
    delete json.thumbs;
    put("backup.json", JSON.stringify(json, null, 2) + "\n");

    files.unshift(
      { path: root + "/READ ME FIRST.txt", data: readmeText(data, counts) },
      { path: root + "/My Music.html", data: viewerAssets
          ? viewerHtml(data, { fontDataUrl, assets: viewerAssets, theme })
          : printableHtml(data, { fontDataUrl }) },
    );
    return { root, files, counts };
  }

  window.Exporters = {
    buildFiles, printableHtml, viewerHtml, viewerScript, VIEWER_ASSETS, toCsv, csvCell, safeName, fmtLength, cleanDescription, trackLine, localDay,
  };
})();
