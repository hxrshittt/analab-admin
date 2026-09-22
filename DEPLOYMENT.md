# Deploying Analab (website + admin) on Render

This is a Node.js app. GitHub Pages cannot host it (static files only).

Render's **Free** plan wipes the server's disk on every redeploy, restart and idle spin-down
(a free service sleeps after 15 minutes without traffic). So there are two ways to run this:

| | Storage | Render plan | Cost |
|---|---|---|---|
| **A. GitHub mode (recommended)** | Releases + installers saved as GitHub Releases in your repo | Free | Free |
| B. Local disk mode | Installers saved on the server's disk | Paid + persistent disk | Paid |

The admin dashboard works the same in both.

---

## A. Free: GitHub mode

Your **repo must be public** (visitors download installers straight from GitHub's servers).

### 1. Create a GitHub token
1. GitHub -> your profile picture -> **Settings** -> **Developer settings** -> **Personal access tokens** -> **Fine-grained tokens** -> **Generate new token**.
2. Name: `analab-admin`. Expiration: choose the longest you are comfortable with (you must make a new token when it expires).
3. **Repository access**: *Only select repositories* -> pick your Analab repo.
4. **Permissions** -> **Repository permissions** -> **Contents: Read and write**.
5. Click **Generate token** and copy it (it starts with `github_pat_`). You only see it once.

### 2. Set Render environment variables
Render dashboard -> your service -> **Environment**:

| Key | Value |
|---|---|
| `GITHUB_REPO` | `your-username/your-repo` (for example `hxrshittt/analab-admin`) |
| `GITHUB_TOKEN` | the token from step 1 |
| `ADMIN_USERNAME` | your admin username |
| `ADMIN_PASSWORD` | a strong password (**required**, it is read on every start) |
| `TRUST_PROXY` | `1` |

Save. Render redeploys. In **Logs** you should see `Release storage: GitHub Releases (...)` and `GitHub connected`.

### 3. Publish
Sign in at `/admin` -> **New release** -> set version, notes, drop the installer -> **Publish release**.
The release appears under your repo's **Releases** page on GitHub and on your website.

Nothing important is stored on Render, so restarts and redeploys lose nothing.

Notes:
- The very first visit after the service slept takes about a minute to load. That is Render's free plan.
- To change your admin login, edit `ADMIN_USERNAME` / `ADMIN_PASSWORD` in Render and save.
- The version number can't be edited after publishing (delete the release and publish again).
- You can also create a release by hand on GitHub and attach the installer. The tag decides the product:
  `v1.2.0` is **Decay Analyzer**, `titrator-v1.2.0` is **Titrator**. The site picks it up within about 30 seconds.
- Both products share the one repo. The live version of each product is remembered with a hidden marker at the
  end of that release's description on GitHub, so please leave that last line alone if you edit a description.
- If a very large upload through Render times out, publish it by hand on GitHub as above.

---

## B. Paid: local disk mode

1. Use a **paid** Render instance type and add a **Disk** mounted at `/var/data`.
2. Environment: `TRUST_PROXY=1`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `DATA_DIR=/var/data/data`, `UPLOAD_DIR=/var/data/uploads`.
   Do **not** set `GITHUB_REPO` / `GITHUB_TOKEN`.
3. Publish from `/admin` the same way. Installers are stored on the disk.

---

## Updating the website code
Edit the files, then `git add .`, `git commit -m "message"`, `git push`. Render redeploys automatically.

## Default version
Until you publish a release the site and `GET /api/latest` report `0.0.0`.
