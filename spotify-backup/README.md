# Spotify Backup

A one-page web app that saves a written copy of a Spotify account: liked songs, playlists, saved albums and followed artists. It downloads as a `.zip` of plain text files, spreadsheets (CSV), a printable page and a JSON file. The buttons and panels use the AudioBiome / Radio Jungle house style (`js/pixel-frame.js` and the Saturno font).

Everything runs in the browser. There's no server or database, the access is read-only, and the login is dropped when the tab closes.

## One-time setup (owner)

1. **Spotify app.** Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard). You can reuse your AudioBiome app; the account that owns it needs Premium.
2. **Redirect URIs** (in the app's Settings). Add the exact address of the page, including the trailing slash. You can add more than one:
   - Testing on your computer: `http://127.0.0.1:8080/` (see below)
   - Hosted: e.g. `https://your-site.netlify.app/spotify-backup/`
3. **APIs used.** Tick **Web API**.
4. **Client ID.** Paste it into `js/config.js` as `CLIENT_ID`, and optionally set `OWNER_NAME` so error messages tell friends who to ask. The Client ID isn't a secret, because this login flow (PKCE) never uses the client secret. If you'd rather not edit the file, open the page with `?setup` on the end and paste the ID there. That only saves it in your own browser.
5. **User Management.** Add each friend's name and the email address of *their Spotify account*. New apps are limited to **5 people including you**. Apps created before February 2026 keep the users they already had.

## Running it

**On your computer**, from the repo root:

```sh
cd spotify-backup && python3 -m http.server 8080 --bind 127.0.0.1
```

Then open **http://127.0.0.1:8080/**. Use `127.0.0.1`, not `localhost`: Spotify stopped accepting `localhost` in 2025.

**For friends**, host the `spotify-backup/` folder anywhere that serves HTTPS: Netlify, Cloudflare Pages or GitHub Pages. You can deploy it the same way as `blob-playground/`. Add the hosted address to Redirect URIs, then send friends the link.

## Putting it on Netlify (drag and drop)

1. Zip the *contents* of this folder (`index.html` must be at the top of the zip), leaving out `tests/`. Or just drag the folder itself.
2. Go to [app.netlify.com/drop](https://app.netlify.com/drop) and drop it in. Note the address you get, e.g. `https://spotify-backup-xyz.netlify.app`.
3. In the Spotify dashboard → your app → **Settings → Redirect URIs**, add that address *with a slash on the end*, then Save.
4. **Request access form** (Netlify Forms):
   - Netlify → your site → **Forms**: if it says form detection is off, click **Enable form detection**, then drop the zip in again (Deploys tab) so Netlify finds the form.
   - **Site configuration → Notifications → Emails and webhooks → Form submission notifications → Add notification → Email**: enter your address and pick the `request-access` form.
   - If the form isn't set up, friends instead get a ready-written email to `OWNER_EMAIL` from `js/config.js`.
5. When a request arrives, add that person in the Spotify dashboard → **User Management** (name + their Spotify email).

To update the site later, drop a new zip on the site's **Deploys** tab (not on /drop, which makes a new site with a new address).

## If login doesn't work

These are also the most likely reasons the Spotify login never worked in AudioBiome:

| What you see | Cause |
|---|---|
| Spotify page says `INVALID_CLIENT: Invalid redirect URI` | The page address isn't in Redirect URIs *exactly* (check `http` vs `https`, the trailing slash, and `127.0.0.1` vs `localhost`). The setup box (`?setup`) shows the exact address being sent. |
| Spotify page says `INVALID_CLIENT: Invalid client` | Wrong Client ID. |
| Login works, then "Spotify won't let this account use the backup page" | That Spotify account isn't in User Management. If it's your own account, check that your Premium is active. |
| Code from an old tutorial gets `#access_token=` in the URL | That's the *implicit grant*, which Spotify switched off in 2025. This app uses PKCE instead. |
| Requests to `/playlists/{id}/tracks` fail | Renamed to `/playlists/{id}/items` in February 2026. |

## What Spotify won't share (as of 2026)

- **Songs in playlists you follow but didn't make.** Spotify only shares song lists for playlists you own or collaborate on. The backup saves the names and links of followed playlists and explains the workaround: copy the songs into a playlist of your own, then back up again.
- When a section is refused (for example, Spotify retires an endpoint), the backup carries on without it and the READ ME explains what's missing.

## Files

| File | Job |
|---|---|
| `index.html` | Markup and house-style CSS |
| `js/app.js` | The four steps (Log in → Choose → Save → Download), friendly error messages |
| `js/spotify-auth.js` | PKCE login and token refresh |
| `js/spotify-api.js` | API client: paging, retry on 429 / 5xx, refresh on 401, Stop button |
| `js/backup.js` | Walks the account and builds the data object |
| `js/exporters.js` | Text, CSV, printable HTML, JSON, READ ME |
| `js/zip.js` | Small dependency-free ZIP writer |
| `js/pixel-frame.js` | House-style `PixelFrame` / `PixelButton` (copy of `../js/pixel-frame.js`) |

## Tests

```sh
node --test spotify-backup/tests/*.test.js
```

Needs Node 18 or newer. There are no packages to install.
