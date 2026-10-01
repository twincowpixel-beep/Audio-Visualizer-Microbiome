#!/usr/bin/env node
// The "View my music" button opens the backup viewer from the site, so it
// runs under the site's Content-Security-Policy, which only allows inline
// script it knows by hash. This recomputes that hash from the viewer files
// and writes it into index.html. Run after changing any file listed in
// Exporters.VIEWER_ASSETS.js:   node spotify-backup/tools/csp-hash.js
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const root = path.join(__dirname, "..");
globalThis.window = globalThis;
require(path.join(root, "js/exporters.js"));
const { VIEWER_ASSETS, viewerScript } = window.Exporters;

function viewerHash() {
  const js = VIEWER_ASSETS.js.map(f => fs.readFileSync(path.join(root, f), "utf8"));
  return "'sha256-" + crypto.createHash("sha256").update(viewerScript(js), "utf8").digest("base64") + "'";
}

if (require.main === module) {
  const file = path.join(root, "index.html");
  const html = fs.readFileSync(file, "utf8");
  const hash = viewerHash();
  const next = html.replace(/script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')?;/, "script-src 'self' " + hash + ";");
  if (next === html) console.log("index.html already has", hash);
  else { fs.writeFileSync(file, next); console.log("index.html updated:", hash); }
}
module.exports = { viewerHash };
