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

   OWNER_EMAIL: where "Request access" requests are emailed. They go
   through FormSubmit (formsubmit.co, free, no account): the very first
   request sends you an "Activate Form" email — click it once and every
   request after that arrives in your inbox. If FormSubmit is down, the
   page tries Netlify Forms, then hands the friend a ready-written email.

   FORMSUBMIT_ID: optional. After activating, FormSubmit's email offers a
   random string to use instead of your address, so the address isn't
   visible in the page. Paste it here and it's used instead.
   ============================================================ */
window.SPOTIFY_BACKUP_CONFIG = {
  CLIENT_ID: "d16bf9da788640968a52555e29211ec8",
  REDIRECT_URI: "",
  OWNER_NAME: "",
  OWNER_EMAIL: "zanderchristoff01@gmail.com",
  FORMSUBMIT_ID: "",
};
