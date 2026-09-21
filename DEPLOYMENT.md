# Deploying Analab (website + admin) on Render

This is a Node.js app. GitHub Pages cannot host it (static files only).

## Important: pick the right Render plan

Render's **Free** instance has an ephemeral filesystem. Uploaded installers, the release list
and the admin login are stored on disk, so on Free they are **lost on every redeploy, restart
and idle spin-down (after 15 minutes without traffic)**.

To keep uploads, use a **paid instance type** and attach a **persistent disk**
(persistent disks are not available on Free web services).

## 1. Push the code to GitHub

```bash
git add .
git commit -m "Update Analab"
git push
```

## 2. Create the Render web service

1. Render dashboard -> **New** -> **Web Service** -> connect the GitHub repo.
2. Runtime: **Node**. Build command: `npm install`. Start command: `npm start`.
3. Instance type: a **paid** type (needed for the disk).
4. **Environment** variables:
   - `TRUST_PROXY` = `1`
   - `ADMIN_USERNAME` = your username
   - `ADMIN_PASSWORD` = a strong password (used the first time the admin account is created)
   - `DATA_DIR` = `/var/data/data`
   - `UPLOAD_DIR` = `/var/data/uploads`
5. **Disks** -> **Add disk**: mount path `/var/data`, size 1 GB or more (installers live here,
   so size it for your files; a disk can be enlarged later but not shrunk).
6. Save. Render redeploys and the disk becomes available once the deploy is live.

Public site: `https://<your-service>.onrender.com`
Admin: `https://<your-service>.onrender.com/admin`

## 3. Publish your first version

The site starts at version **0.0.0** (nothing published). In `/admin` click **New release**,
set the version (for example `1.0.0`), add notes, drop the installer, and click **Publish release**.

## 4. Updating later

- **New version of your software:** sign in at `/admin` and publish a new release. No code change or redeploy needed.
- **Changing the website code:** edit the files, then `git add .`, `git commit`, `git push`.
  Render redeploys automatically. Data on the persistent disk is kept.

## Forgot the admin password?

The password is only read from `ADMIN_PASSWORD` when the admin account is first created.
To reset it, run `npm run reset-admin` in a shell on the service (or delete `data/admin.json`
on the disk and restart) and use the login it prints.

## Other hosts

Railway, Fly.io, a VPS, or your own Windows/Linux server also work. They need Node 18+,
persistent storage for the data and upload folders, and HTTPS in front.
