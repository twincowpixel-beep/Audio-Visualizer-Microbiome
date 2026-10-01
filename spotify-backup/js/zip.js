/* ============================================================
   makeZip — a tiny ZIP writer (no compression, "stored" entries).

   A backup tool shouldn't depend on a CDN still being up, so this is the
   whole format in ~80 lines instead of a library. Song lists are small
   enough that skipping compression costs nothing that matters.
   Filenames are UTF-8 (general-purpose flag bit 11), which Windows
   Explorer, macOS Archive Utility and unzip all honour — so playlist
   names with accents or emoji survive.

   files: [{ path: "folder/name.txt", data: string | Uint8Array }]
   returns a Uint8Array holding the finished .zip
   ============================================================ */
(function () {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // MS-DOS date/time, local time, 2-second resolution, years 1980–2107.
  function dosStamp(d) {
    const year = Math.min(2107, Math.max(1980, d.getFullYear()));
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  function makeZip(files, when = new Date()) {
    const enc = new TextEncoder();
    const { time, date } = dosStamp(when);
    const UTF8 = 0x0800;

    // Explicit folder entries first, so every unzipper shows the folders
    // even when it doesn't infer them from the file paths.
    const dirs = new Set();
    for (const f of files) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/");
    }
    const entries = [...dirs].sort().map(path => ({ path, data: new Uint8Array(0), dir: true }))
      .concat(files.map(f => ({ path: f.path, data: typeof f.data === "string" ? enc.encode(f.data) : f.data })));
    if (entries.length > 0xFFFF) throw new Error("Too many files for a basic ZIP");

    const out = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.path);
      const size = e.data.length;
      const crc = crc32(e.data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);   // local file header
      local.setUint16(4, 20, true);           // version needed (2.0)
      local.setUint16(6, UTF8, true);
      local.setUint16(8, 0, true);            // stored
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      out.push(new Uint8Array(local.buffer), name, e.data);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);     // central directory header
      cen.setUint16(4, 20, true);             // made by: MS-DOS, 2.0
      cen.setUint16(6, 20, true);
      cen.setUint16(8, UTF8, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, time, true);
      cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, size, true);
      cen.setUint32(24, size, true);
      cen.setUint16(28, name.length, true);
      // extra len, comment len, disk no., internal attrs = 0
      cen.setUint32(38, e.dir ? 0x10 : 0, true);   // DOS "directory" attribute
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);

      offset += 30 + name.length + size;
      if (offset > 0xFFFFFFFF) throw new Error("Backup too large for a basic ZIP");
    }

    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);       // end of central directory
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    const parts = out.concat(central, [new Uint8Array(end.buffer)]);
    const zip = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { zip.set(p, at); at += p.length; }
    return zip;
  }

  window.Zip = { makeZip, crc32 };
})();
