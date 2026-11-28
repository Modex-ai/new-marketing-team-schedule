# Vendoor · Marketing Team Operations Management

Live operations dashboard for the marketing team: who's on duty now, the daily desk board, the weekly schedule (days × team, like the team sheet), desk coverage, team summary, personal schedule images, and an activity log.

## Features
- **Fully flexible weekly schedule**: every week is built on its own (copy last week, copy any week, or start empty). Each cell = Shift · Responsible of · Time (+ note).
- **You control every list**: team members (name, ID, order), shift types (Morning, Night, Off, or any new type), "Responsible of" desks, and time slots. Any cell can also take a custom time.
- **Desk coverage**: desks marked "Track coverage" are checked for every tracked shift, every day; empty slots are flagged in red.
- **Images**: save the weekly schedule or each person's week as a PNG (or share from a phone).
- **Users**: sign in with username + password. Admins add users (Admin / Editor). Every save is logged with who changed what.

## Deploy on Vercel
1. Import this repo into Vercel (Framework preset: **Other**).
2. Storage → Create **Blob** store → connect it to the project (adds `BLOB_READ_WRITE_TOKEN`).
3. Settings → Environment Variables → add `ADMIN_PIN` (password of the built-in `owner` account), `SESSION_SECRET` (long random string) and optionally `OWNER_NAME`.
4. If the Blob store is **public**, also add `BLOB_ACCESS=public`.
5. Redeploy.

## Files
- `index.html` — the whole dashboard (UI + schedule engine + image export).
- `api/schedule.js` — reads/saves the schedule in Vercel Blob (keeps the last 15 versions).
- `api/auth.js`, `api/users.js` — sign-in and user management.
- `assets/` — Vendoor logos, bundled fonts, html-to-image.

## Run it on another server (outside Vercel)

1. Node.js 20+ → `npm install`
2. Copy `.env.example` to `.env` and fill it in (`STORAGE=fs` keeps the data as files in `DATA_DIR`).
3. Bring the data over: `BLOB_READ_WRITE_TOKEN=… npm run export-data` downloads everything from Vercel Blob into `./data`.
4. `npm start` → the dashboard on `PORT` (put it behind HTTPS — Nginx / Caddy / your host's proxy).
   With Telegram, the bot follows the address you open the dashboard from (My account → Connect Telegram once).

Notes: `data/` is the whole database — back it up. Photo / video uploads use Vercel Blob's direct upload, so on another
server new attachments need a storage swap (existing ones are exported and still open).
