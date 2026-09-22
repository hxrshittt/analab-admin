# Analab website + admin dashboard

Your Analab site, now with a private admin dashboard where you can sign in,
change the version, and upload the installer. The public pages (Home, Downloads,
Release Notes) update automatically from what you publish.

The site covers **two products**, each with its own pages, its own release list and its own live version:

| Product | Pages | Release API |
|---|---|---|
| Decay Analyzer | `/` (index, features, downloads, release-notes, support) | `/api/latest` |
| Titrator | `/titrator/` (same five pages) | `/api/latest?product=titrator` |

A glass switcher under the navigation bar moves between them (and keeps you on the same kind of page, so
Downloads goes to Downloads).

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

Add `?product=titrator` or `?product=decay-analyzer` to `/api/latest`, `/api/releases` and `/download/latest`.
With no `product`, they answer for Decay Analyzer, so software that already calls `/api/latest` keeps working.

Until you publish a release, the site and `GET /api/latest` report version **0.0.0**
(defined as `DEFAULT_VERSION` in `server.js`). Your software can ignore 0.0.0 and only
offer an update when the reported version is higher than the installed one
(compare each number separately, so 1.10.0 is higher than 1.9.0).

`/api/latest` returns JSON with `product`, `version`, `date`, `whatsNew`, `fixes`, `file.sha256`
and `downloadUrl` (a path like `/download/<id>`).

Already ran an older copy (before Titrator existed)? Nothing to do: `data/db.json` is upgraded automatically and
every existing release stays with Decay Analyzer. Delete `data/db.json` and restart to start from scratch.

## Publishing a new version

1. Sign in at `/admin`, choose **Titrator** or **Decay Analyzer** at the top of the sidebar, then click **New release**.
   Everything you see in the dashboard (live version, list, stats) is for the product you picked.
2. Pick a version (Patch / Minor / Major suggestions are one click), set the date,
   and write the release notes (one line per bullet).
3. Drop the installer (.exe, .msi or .zip). You will see upload progress, and a
   SHA-256 checksum is calculated automatically.
4. Keep **Make this the live version** on and click **Publish release**.

The version badge, download button, file size, checksum, previous releases and
release notes across the site all update immediately. You can also **Make live**
(roll back to an older version), edit notes, replace an installer, or delete old releases.

## Deploying

This needs a Node.js host. **GitHub Pages cannot run it.** See `DEPLOYMENT.md` for step by step Render instructions.

- **Free (Render Free plan):** set `GITHUB_REPO` and `GITHUB_TOKEN`. Releases and installers are then stored as
  GitHub Releases in your repo, so nothing is lost when Render restarts or sleeps. Set `ADMIN_PASSWORD` too.
- **Paid / your own server:** leave those two empty. Installers and data are saved on disk in `uploads/` and `data/`.
  On Render attach a persistent disk and set `DATA_DIR` and `UPLOAD_DIR` to it.
- Set `TRUST_PROXY=1` when the host provides HTTPS in front of the app.
- Upload size limit is 2 GB by default (`MAX_UPLOAD_MB`, GitHub allows up to 2000). Some proxies (for example
  Cloudflare's free plan, 100 MB) cap request size before it reaches the app.

## Security notes

- Passwords are stored hashed (bcrypt); sessions use a signed HttpOnly, SameSite=Strict cookie.
- Login is rate limited (8 failed attempts per 15 minutes per IP).
- Only `public/` is served. `data/`, `uploads/`, `server.js` and `.env` are never exposed.
- Always run it behind HTTPS in production.

## Structure

```
server.js            backend (login, releases, uploads, downloads)
public/              Decay Analyzer pages (index, features, downloads, release-notes, support)
public/titrator/     Titrator pages (same five pages)
public/product.css   product switcher (liquid glass) + Titrator theme
public/product.js    switcher behaviour (drag, slide, remember position between pages)
public/titrator.js   the live titration demo on the Titrator home page
public/admin/        admin login page + dashboard styles/scripts
views/dashboard.html dashboard page (only served to a signed-in admin)
data/                created at runtime: releases, admin login
uploads/             created at runtime: installer files
```
