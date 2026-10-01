/* ============================================================
   Spotify Backup — settings for whoever hosts this page.

   CLIENT_ID: the Client ID of your app at developer.spotify.com/dashboard
   (your app → Settings → Basic Information). It is NOT a secret: the PKCE
   login flow never uses the client secret, so it is safe in a public page.
   Leave it blank and the page shows a one-time setup box instead, which
   remembers the ID in that browser only — handy while testing.

   REDIRECT_URI: leave blank to use this page's own address (recommended).
   Whatever is used must match a Redirect URI in the dashboard EXACTLY,
   trailing slash included. The setup box shows the address it will send.

   OWNER_NAME: shown to friends in error messages ("ask Sam to add you").

   OWNER_EMAIL: where "Request access" sends people. The form is a Netlify
   Form (Netlify emails you each request once notifications are switched
   on); this address is the backup if that fails — friends get a
   ready-written email to send you instead. It is visible in the page.
   ============================================================ */
window.SPOTIFY_BACKUP_CONFIG = {
  CLIENT_ID: "d16bf9da788640968a52555e29211ec8",
  REDIRECT_URI: "",
  OWNER_NAME: "",
  OWNER_EMAIL: "zanderchristoff01@gmail.com",
};
