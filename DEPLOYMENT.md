# Deploy Analab Website + Admin Dashboard

This is a Node.js app with an admin dashboard. GitHub Pages cannot host it (only static files). 

**Best option: Render.com (free tier with persistent storage)**

---

## Step 1: Push to GitHub

Go to your computer in the `analab` folder:

```bash
cd C:\Users\rnd-2\Downloads\git-ready\analab
```

(Or wherever this folder is.)

Then:

```bash
git init
git add .
git commit -m "Analab with admin dashboard"
git branch -M main
git remote add origin https://github.com/hxrshittt/analab-admin.git
git push -u origin main
```

(Or replace `analab-admin` with whatever repo name you want.)

---

## Step 2: Deploy to Render

1. Go to **https://render.com** and sign up (use GitHub login).

2. Click **New** → **Web Service**.

3. Connect your repository (`hxrshittt/analab-admin` or whatever you named it).

4. Fill in:
   - **Name:** `analab-website`
   - **Runtime:** Node.js
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance Type:** Free
   - **Region:** Pick closest to you

5. **Environment:**
   - Add `TRUST_PROXY=1`
   - Add `ADMIN_USERNAME=admin`
   - Add `ADMIN_PASSWORD=YourPassword123` (or leave empty for random)

6. **Disk:** Add a persistent disk:
   - Mount path: `/var/data`
   - Set `DATA_DIR=/var/data/analab/data`
   - Set `UPLOAD_DIR=/var/data/analab/uploads`

7. Click **Create Web Service**.

Wait 3-5 minutes. Render will give you a URL like:
```
https://analab-website.onrender.com
```

Your site is live:
- **Public site:** https://analab-website.onrender.com
- **Admin login:** https://analab-website.onrender.com/admin

---

## Step 3: First Login

1. Go to `/admin`
2. Username: `admin`
3. Password: whatever you set in Step 2 (or check Render logs for the random one)

---

## Step 4: Publish Your First Version

1. Sign in
2. Click **New release**
3. Version: `1.3.0`
4. Release date: Today
5. Notes:
   ```
   - Improved reference comparison workflow.
   - Improved reconnect handling for data capture.
   - Faster analysis for longer test runs.
   ```
6. **Drop your installer** (`.exe` or `.msi`)
7. Click **Publish release**

Everything updates automatically.

---

## Every Update After That

1. Sign in at `/admin`
2. Click **New release**
3. Set version, notes, drop installer
4. **Publish**

Done. No code changes needed.

---

## Troubleshooting

**"Build failed"**
→ Check Render logs. Make sure `package.json` and `server.js` are in the root of your repo.

**"Site won't start"**
→ Check logs. Common: missing `node_modules` (should auto-install), or wrong `TRUST_PROXY` setting.

**"Uploads disappeared after redeploy"**
→ You need the persistent disk. Render free tier has ephemeral storage. See Step 2, the Disk section.

**"I forgot my admin password"**
→ In the Render dashboard, go to **Shell**, run:
```
npm run reset-admin
```
It will print the new login.

---

## If You Want to Use a Different Host

Works the same on:
- **Railway.app** (very similar to Render)
- **Fly.io** (bare metal, more control)
- **Heroku** (paid, but works well)
- **A Windows/Linux server** (just `npm start`)

All of them need:
- Node.js 18+
- Persistent storage for `data/` and `uploads/`
- HTTPS in front (for security)
