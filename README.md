# Analab website + admin dashboard

Your original static site, now with a private admin dashboard where you can
sign in, change the version, and upload the installer. The public pages
(Home, Downloads, Release Notes) update automatically from what you publish.

## Run it

**Windows (easiest):** double-click `start.bat`. It installs everything the first time and opens the admin page.

Or from a terminal:

```bash
npm install
npm start
```

If PowerShell says *running scripts is disabled*, use `npm.cmd install` and `npm.cmd start`, or open Command Prompt (cmd) instead of PowerShell.

- Website: http://localhost:3000
- Admin:   http://localhost:3000/admin

On first start the console prints your admin username and password.
To choose your own, copy `.env.example` to `.env` and set `ADMIN_USERNAME`
and `ADMIN_PASSWORD` **before the first start**. Change the password any
time from **Account** inside the dashboard. There is no registration page:
there is only this one admin login.

Forgot the password? Run `npm run reset-admin` (creates a new login and prints it).

## Default version and update checks

Until you publish a release, the site and `GET /api/latest` report version **0.0.0**
(defined as `DEFAULT_VERSION` in `server.js`). Your software can ignore 0.0.0 and only
offer an update when the reported version is higher than the installed one
(compare each number separately, so 1.10.0 is higher than 1.9.0).

`/api/latest` returns JSON with `version`, `date`, `whatsNew`, `fixes`, `file.sha256`
and `downloadUrl` (a path like `/download/<id>`).

Already ran an older copy? Delete `data/db.json` and restart to get the 0.0.0 default again.

## Publishing a new version

1. Sign in at `/admin` and click **New release**.
2. Pick a version (Patch / Minor / Major suggestions are one click), set the date,
   and write the release notes (one line per bullet).
3. Drop the installer (.exe, .msi or .zip). You will see upload progress, and a
   SHA-256 checksum is calculated automatically.
4. Keep **Make this the live version** on and click **Publish release**.

The version badge, download button, file size, checksum, previous releases and
release notes across the site all update immediately. You can also **Make live**
(roll back to an older version), edit notes, replace an installer, or delete old releases.

## Deploying

This needs a Node.js host. **GitHub Pages cannot run it** (it only serves static files).
Any of these work: Render, Railway, Fly.io, a VPS, or a Windows/Linux server.

- Start command: `npm start`
- Set `TRUST_PROXY=1` when the host provides HTTPS in front of the app.
- Installers and data are saved on disk in `uploads/` and `data/`. On hosts with
  ephemeral disks (most free tiers) attach a **persistent disk/volume** and point
  `DATA_DIR` and `UPLOAD_DIR` at it, otherwise uploads disappear on redeploy.
- Back up `data/` and `uploads/` to keep your releases safe.
- Upload size limit is 2 GB by default (`MAX_UPLOAD_MB`). Some proxies (for example
  Cloudflare's free plan, 100 MB) cap request size before it reaches the app.

## Security notes

- Passwords are stored hashed (bcrypt); sessions use a signed HttpOnly, SameSite=Strict cookie.
- Login is rate limited (8 failed attempts per 15 minutes per IP).
- Only `public/` is served. `data/`, `uploads/`, `server.js` and `.env` are never exposed.
- Always run it behind HTTPS in production.

## Structure

```
server.js            backend (login, releases, uploads, downloads)
public/              the website (index, features, downloads, release-notes, support)
public/admin/        admin login page + dashboard styles/scripts
views/dashboard.html dashboard page (only served to a signed-in admin)
data/                created at runtime: releases, admin login
uploads/             created at runtime: installer files
```
