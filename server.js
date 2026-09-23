'use strict';

/**
 * Analab website server
 * - Serves the public website from /public
 * - Admin login + dashboard at /admin (single admin account, no registration)
 * - Lets the admin publish versions and upload installer files
 * - Public pages read the live version from /api/latest and /api/releases
 *
 * Two storage modes for releases:
 *   local  (default)  installers + release list are saved on this server's disk (needs a persistent disk on Render)
 *   github            releases are saved as GitHub Releases in your repo. Nothing important lives on the server,
 *                     so it works on Render's free plan. Enabled when GITHUB_REPO and GITHUB_TOKEN are set.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');

// ---------------------------------------------------------------------------
// Config (.env is optional; real environment variables always win)
// ---------------------------------------------------------------------------
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const GITHUB_REPO = (process.env.GITHUB_REPO || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const GITHUB_API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const USE_GITHUB = !!(GITHUB_REPO && GITHUB_TOKEN);
// GitHub allows release files up to 2 GiB
const MAX_UPLOAD_MB = Math.min(Number(process.env.MAX_UPLOAD_MB) || 2048, USE_GITHUB ? 2000 : Infinity);
const ALLOWED_EXT = ['.exe', '.msi', '.zip'];
const COOKIE = 'analab_admin';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// remove half-uploaded files left by a crash
for (const f of fs.readdirSync(UPLOAD_DIR)) if (f.endsWith('.part')) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const rid = (p) => p + crypto.randomBytes(5).toString('hex');
const httpError = (status, message) => Object.assign(new Error(message), { status });
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const DEFAULT_VERSION = '0.0.0';

function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function cmpVersion(a, b) {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
function parseLines(text) {
  return String(text || '').split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim().slice(0, 240))
    .filter(Boolean).slice(0, 40);
}
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function safeName(name) {
  const clean = path.basename(String(name || 'installer')).replace(/[^\w.\- ()]+/g, '_').slice(0, 120);
  return clean || 'installer';
}
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}
const rm = (file) => file && fs.rm(file, { force: true }, () => {});
const today = () => new Date().toISOString().slice(0, 10);
const sortedDesc = (list) => [...list].sort((a, b) => cmpVersion(b.version, a.version));

// ---------------------------------------------------------------------------
// Admin account
//  - local mode: created on first run (or with --reset-admin) and saved in data/admin.json
//  - github mode: always built from ADMIN_USERNAME / ADMIN_PASSWORD, so a wiped disk changes nothing
// ---------------------------------------------------------------------------
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

let generatedPassword = null;
function createAdmin() {
  const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    password = Array.from(crypto.randomBytes(14), (b) => alphabet[b % alphabet.length]).join('');
    generatedPassword = password;
  }
  writeJson(ADMIN_FILE, { username, hash: bcrypt.hashSync(password, 12), tokenVersion: 1 });
  return username;
}
let createdAdminName = null;
if (USE_GITHUB || process.argv.includes('--reset-admin') || !fs.existsSync(ADMIN_FILE)) createdAdminName = createAdmin();
let admin = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
const saveAdmin = () => writeJson(ADMIN_FILE, admin);
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

// ---------------------------------------------------------------------------
// Signed session cookie (HMAC, no external deps)
// The signing secret must survive restarts, otherwise you get signed out whenever Render wakes up.
// ---------------------------------------------------------------------------
const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
let SECRET;
if (process.env.SESSION_SECRET) SECRET = sha256Hex('analab-session:' + process.env.SESSION_SECRET);
else if (USE_GITHUB) SECRET = sha256Hex('analab-session:' + GITHUB_TOKEN);
else {
  if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
}

const b64 = (s) => Buffer.from(s).toString('base64url');
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

function signSession(payload) {
  const body = b64(JSON.stringify(payload));
  return body + '.' + hmac(body);
}
function readSession(req) {
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const token = decodeURIComponent(raw.slice(COOKIE.length + 1));
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = hmac(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now() || p.v !== admin.tokenVersion || p.u !== admin.username) return null;
    return p;
  } catch { return null; }
}
function setSession(req, res, remember) {
  const ttl = remember ? 30 * 864e5 : 12 * 36e5;
  const token = signSession({ u: admin.username, v: admin.tokenVersion, exp: Date.now() + ttl, r: !!remember });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttl / 1000)}${secure ? '; Secure' : ''}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function requireAuth(req, res, next) {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  // Changing data needs a custom header, which cross-site forms cannot send (CSRF guard)
  if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'analab-admin') {
    return res.status(403).json({ error: 'Request blocked.' });
  }
  req.session = s;
  next();
}

// Login throttling: 8 failed attempts per 15 minutes per IP
const attempts = new Map();
const WINDOW = 15 * 60 * 1000, MAX_FAILS = 8;
function throttled(ip) {
  const a = attempts.get(ip);
  if (!a) return 0;
  if (Date.now() - a.first > WINDOW) { attempts.delete(ip); return 0; }
  return a.count >= MAX_FAILS ? Math.ceil((a.first + WINDOW - Date.now()) / 1000) : 0;
}
function fail(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > WINDOW) attempts.set(ip, { count: 1, first: Date.now() });
  else a.count++;
}
setInterval(() => { for (const [ip, a] of attempts) if (Date.now() - a.first > WINDOW) attempts.delete(ip); }, WINDOW).unref();

// ---------------------------------------------------------------------------
// Products
// One website, two software products. Each product has its own list of releases and its own
// "live" version. Old data (saved before Titrator existed) belongs to Decay Analyzer.
// ---------------------------------------------------------------------------
const PRODUCTS = {
  'decay-analyzer': { name: 'Decay Analyzer', tagPrefix: '', filePrefix: 'analab-decay-analyzer', releaseName: (v) => `Analab ${v}` },
  titrator: { name: 'Titrator', tagPrefix: 'titrator-', filePrefix: 'analab-titrator', releaseName: (v) => `Analab Titrator ${v}` },
};
const DEFAULT_PRODUCT = 'decay-analyzer';
const productId = (v) => {
  const p = String(v == null || v === '' ? DEFAULT_PRODUCT : v).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PRODUCTS, p) ? p : null;
};
const isPlaceholderId = (id) => String(id).startsWith('placeholder-');
// Shown until the first real release of a product is published. Never stored.
function placeholderView(product) {
  const p = { id: 'placeholder-' + product, product, version: DEFAULT_VERSION, date: today(), whatsNew: [], fixes: [], downloads: 0, file: null, placeholder: true };
  return { latestId: p.id, releases: [p] };
}

// ---------------------------------------------------------------------------
// Storage: LOCAL (JSON file + installers on this server's disk)
//
// Every store returns releases in one shape:
//   { id, product, version, date, whatsNew[], fixes[], file: {name,size,sha256,uploadedAt}|null, downloads, placeholder? }
// and every store offers: list(product), find(id), create(product, form, file), update(id, form, file),
// setLatest(id), remove(id), download(id).
// ---------------------------------------------------------------------------
function makeLocalStore() {
  const DB_FILE = path.join(DATA_DIR, 'db.json');
  const fresh = !fs.existsSync(DB_FILE);
  let db = fresh ? { latest: {}, releases: [] } : JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  let dirty = fresh;
  // upgrade a database saved before there were two products
  if (!db.latest) { db.latest = { [DEFAULT_PRODUCT]: db.latestId || null }; delete db.latestId; dirty = true; }
  for (const r of db.releases) if (!r.product) { r.product = DEFAULT_PRODUCT; dirty = true; }
  const saveDb = () => writeJson(DB_FILE, db);
  if (dirty) saveDb();

  const filePathOf = (r) => (r.file ? path.join(UPLOAD_DIR, r.file.stored) : null);
  const norm = (r) => ({
    id: r.id, product: r.product, version: r.version, date: r.date, whatsNew: r.whatsNew, fixes: r.fixes, downloads: r.downloads,
    file: r.file ? { name: r.file.name, size: r.file.size, sha256: r.file.sha256, uploadedAt: r.file.uploadedAt } : null,
  });
  const get = (id) => db.releases.find((r) => r.id === id);

  async function storeFile(tmp, originalName, version, product) {
    const ext = path.extname(originalName).toLowerCase();
    const stored = `${PRODUCTS[product].filePrefix}-${version.replace(/[^\w.-]/g, '_')}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    const sha256 = await sha256File(tmp);
    const size = fs.statSync(tmp).size;
    fs.renameSync(tmp, path.join(UPLOAD_DIR, stored));
    return { name: safeName(originalName), stored, size, sha256, uploadedAt: new Date().toISOString() };
  }

  return {
    kind: 'local',

    async list(product) {
      const releases = db.releases.filter((r) => r.product === product).map(norm);
      if (!releases.length) return placeholderView(product);
      const wanted = db.latest[product];
      return { latestId: releases.some((r) => r.id === wanted) ? wanted : null, releases };
    },

    async find(id) { const r = get(id); return r ? norm(r) : null; },

    async create(product, f, file) {
      const stored = await storeFile(file.tmp, file.originalName, f.version, product);
      const release = { id: rid('r_'), product, version: f.version, date: f.date, whatsNew: f.whatsNew, fixes: f.fixes, file: stored, downloads: 0, createdAt: new Date().toISOString() };
      db.releases.push(release);
      if (f.makeLatest || !db.latest[product]) db.latest[product] = release.id;
      saveDb();
      return release.id;
    },

    async update(id, f, file) {
      const release = get(id);
      if (!release) throw httpError(404, 'Release not found.');
      let oldFile = null;
      if (file) { oldFile = filePathOf(release); release.file = await storeFile(file.tmp, file.originalName, f.version, release.product); }
      Object.assign(release, { version: f.version, date: f.date, whatsNew: f.whatsNew, fixes: f.fixes });
      if (f.makeLatest) db.latest[release.product] = release.id;
      saveDb();
      rm(oldFile);
    },

    async setLatest(id) {
      const release = get(id);
      if (!release) throw httpError(404, 'Release not found.');
      db.latest[release.product] = release.id;
      saveDb();
    },

    async remove(id) {
      const release = get(id);
      if (!release) throw httpError(404, 'Release not found.');
      db.releases = db.releases.filter((r) => r !== release);
      if (db.latest[release.product] === release.id) db.latest[release.product] = null;
      saveDb();
      rm(filePathOf(release));
    },

    async download(id) {
      const release = get(id);
      const p = release && filePathOf(release);
      if (!p || !fs.existsSync(p)) return null;
      return { file: p, name: release.file.name, count: () => { release.downloads++; saveDb(); } };
    },
  };
}

// ---------------------------------------------------------------------------
// Storage: GITHUB (each release is a GitHub Release with the installer attached)
// The repo is the database. Reading works without any local state.
//   Decay Analyzer releases are tagged   v1.2.3            (unchanged, so existing releases keep working)
//   Titrator releases are tagged         titrator-v1.2.3
// GitHub only has one "latest release" per repo, so the live version of each product is remembered with a
// hidden marker at the end of that release's description.
// ---------------------------------------------------------------------------
function makeGithubStore() {
  const GH_HEADERS = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'analab-admin',
  };
  const TTL = 30 * 1000;
  const LIVE_MARK = '<!--analab-live-->';
  let cache = null, cacheAt = 0, inflight = null;

  function ghError(status, data) {
    const msg = data && data.message ? String(data.message) : '';
    let e;
    if (status === 401) e = httpError(502, 'GitHub rejected the access token. Check GITHUB_TOKEN in Render, under Environment.');
    else if (status === 403 || status === 429) {
      e = /rate limit/i.test(msg)
        ? httpError(503, 'GitHub rate limit reached. Try again in a few minutes.')
        : httpError(502, 'GitHub refused the request. The token needs “Contents: Read and write” permission on the repository.');
    } else if (status === 404) e = httpError(502, 'GitHub could not find the repository. Check GITHUB_REPO and that the token has access to it.');
    else if (status === 422) {
      const already = data && Array.isArray(data.errors) && data.errors.some((x) => x && x.code === 'already_exists');
      e = httpError(400, already ? 'That version or file name already exists on GitHub.' : 'GitHub rejected the request' + (msg ? ': ' + msg : '.'));
    } else e = httpError(502, `GitHub returned an error (${status}).`);
    e.ghStatus = status;
    return e;
  }

  async function gh(method, p, body) {
    let res;
    try {
      res = await fetch(GITHUB_API + p, {
        method,
        headers: { ...GH_HEADERS, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw Object.assign(httpError(502, 'Could not reach GitHub. Try again in a moment.'), { ghStatus: 0 });
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw ghError(res.status, data);
    return data;
  }

  // Stream a file to GitHub as a release asset
  function uploadAsset(uploadUrl, file, name, size) {
    return new Promise((resolve, reject) => {
      const u = new URL(uploadUrl.replace(/\{.*$/, '') + '?name=' + encodeURIComponent(name));
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request({
        method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
        headers: { ...GH_HEADERS, 'Content-Type': 'application/octet-stream', 'Content-Length': size },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let data = {};
          try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* ignore */ }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(ghError(res.statusCode, data));
        });
      });
      req.setTimeout(45 * 60 * 1000, () => req.destroy(new Error('timeout')));
      req.on('error', () => reject(Object.assign(httpError(502, 'Uploading to GitHub failed. Try again.'), { ghStatus: 0 })));
      fs.createReadStream(file).on('error', reject).pipe(req);
    });
  }

  // Notes + checksum live in a hidden comment at the end of the release description
  function makeBody(f, sha256, live) {
    const parts = [];
    if (f.whatsNew.length) parts.push("## What's new\n" + f.whatsNew.map((x) => '- ' + x).join('\n'));
    if (f.fixes.length) parts.push('## Bug fixes\n' + f.fixes.map((x) => '- ' + x).join('\n'));
    const meta = JSON.stringify({ date: f.date, whatsNew: f.whatsNew, fixes: f.fixes, sha256: sha256 || null }).replace(/>/g, '\\u003e');
    parts.push(`<!--analab:${meta}-->`);
    if (live) parts.push(LIVE_MARK);
    return parts.join('\n\n');
  }
  function parseMeta(body) {
    const m = /<!--analab:(\{[\s\S]*?\})-->/.exec(body || '');
    if (!m) return {};
    try { return JSON.parse(m[1]); } catch { return {}; }
  }
  // add or remove the live marker without touching the rest of the description
  function withLive(body, on) {
    const clean = String(body || '').split(LIVE_MARK).join('').replace(/\s+$/, '');
    return on ? clean + '\n\n' + LIVE_MARK : clean;
  }

  // "titrator-v1.2.3" -> { product: 'titrator', version: '1.2.3' }; "v1.2.3" -> Decay Analyzer; anything else -> null
  function parseTag(tag) {
    const t = String(tag || '');
    for (const [product, cfg] of Object.entries(PRODUCTS)) {
      if (cfg.tagPrefix && t.toLowerCase().startsWith(cfg.tagPrefix)) {
        const version = t.slice(cfg.tagPrefix.length).replace(/^v/i, '');
        return VERSION_RE.test(version) ? { product, version } : null;
      }
    }
    const version = t.replace(/^v/i, '');
    return VERSION_RE.test(version) ? { product: DEFAULT_PRODUCT, version } : null;
  }
  const tagFor = (product, version) => PRODUCTS[product].tagPrefix + 'v' + version;

  // GitHub release -> our release shape (returns null for releases that are not version tags)
  function fromGh(r) {
    const tag = parseTag(r.tag_name);
    if (!tag) return null;
    const meta = parseMeta(r.body);
    const assets = r.assets || [];
    const asset = assets.find((a) => ALLOWED_EXT.includes(path.extname(a.name).toLowerCase())) || null;
    const bullets = (r.body || '').split(/\r?\n/).filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '').trim());
    return {
      id: String(r.id), product: tag.product, version: tag.version,
      live: String(r.body || '').includes(LIVE_MARK),
      date: meta.date && validDate(meta.date) ? meta.date : String(r.published_at || r.created_at || today()).slice(0, 10),
      whatsNew: Array.isArray(meta.whatsNew) ? meta.whatsNew : bullets,
      fixes: Array.isArray(meta.fixes) ? meta.fixes : [],
      downloads: assets.reduce((n, a) => n + (a.download_count || 0), 0),
      file: asset ? {
        name: asset.name, size: asset.size, uploadedAt: asset.created_at || null, url: asset.browser_download_url,
        sha256: meta.sha256 || (asset.digest ? String(asset.digest).replace(/^sha256:/, '') : null),
      } : null,
    };
  }

  async function fetchAll() {
    const raw = await gh('GET', `/repos/${GITHUB_REPO}/releases?per_page=100`);
    let ghLatest = null;
    try { ghLatest = await gh('GET', `/repos/${GITHUB_REPO}/releases/latest`); }
    catch (e) { if (e.ghStatus !== 404) throw e; }
    return { all: raw.filter((r) => !r.draft).map(fromGh).filter(Boolean), ghLatestId: ghLatest ? String(ghLatest.id) : null };
  }

  function data() {
    if (cache && Date.now() - cacheAt < TTL) return Promise.resolve(cache);
    if (inflight) return inflight;
    inflight = fetchAll()
      .then((d) => { cache = d; cacheAt = Date.now(); return d; })
      .catch((e) => { if (cache) return cache; throw e; }) // keep the site up on a GitHub hiccup
      .finally(() => { inflight = null; });
    return inflight;
  }
  const invalidate = () => { cache = null; cacheAt = 0; };

  // The live version of a product: the release carrying the live marker; else GitHub's own "latest" if it is
  // one of this product's releases (releases made by hand or before Titrator existed); else the highest version.
  function viewOf(product, d) {
    const releases = d.all.filter((r) => r.product === product);
    if (!releases.length) return placeholderView(product);
    const marked = sortedDesc(releases.filter((r) => r.live));
    let latestId = marked.length ? marked[0].id : null;
    if (!latestId && d.ghLatestId && releases.some((r) => r.id === d.ghLatestId)) latestId = d.ghLatestId;
    if (!latestId) latestId = sortedDesc(releases)[0].id;
    return { latestId, releases };
  }

  const notPlaceholder = (id) => {
    if (isPlaceholderId(id)) throw httpError(400, 'This is the default 0.0.0 placeholder. Publish a real release instead.');
  };
  async function getRelease(id) {
    try { return await gh('GET', `/repos/${GITHUB_REPO}/releases/${encodeURIComponent(id)}`); }
    catch (e) { if (e.ghStatus === 404) throw httpError(404, 'Release not found.'); throw e; }
  }
  // only one release per product carries the live marker
  async function clearLiveMarkers(product, exceptId) {
    invalidate();
    const d = await data();
    for (const r of d.all.filter((x) => x.product === product && x.live && x.id !== exceptId)) {
      const rel = await getRelease(r.id);
      await gh('PATCH', `/repos/${GITHUB_REPO}/releases/${rel.id}`, { body: withLive(rel.body, false) });
    }
  }
  // GitHub's own "latest" badge is only kept in step for Decay Analyzer (Titrator never takes it)
  const ghLatestFlag = (product, live) => (product === DEFAULT_PRODUCT && live ? 'true' : 'false');

  return {
    kind: 'github',

    async list(product) { return viewOf(product, await data()); },

    async find(id) { return (await data()).all.find((r) => r.id === String(id)) || null; },

    async create(product, f, file) {
      try {
        const sha256 = await sha256File(file.tmp);
        const size = fs.statSync(file.tmp).size;
        const name = safeName(file.originalName);
        const d = await data();
        const live = f.makeLatest || !d.all.some((r) => r.product === product);

        // draft first, attach the installer, then publish: visitors never see a release without its file
        const rel = await gh('POST', `/repos/${GITHUB_REPO}/releases`, {
          tag_name: tagFor(product, f.version), name: PRODUCTS[product].releaseName(f.version), body: makeBody(f, sha256, live), draft: true,
        });
        try {
          await uploadAsset(rel.upload_url, file.tmp, name, size);
        } catch (e) {
          // The installer never made it to GitHub - nothing to keep, remove the empty draft.
          await gh('DELETE', `/repos/${GITHUB_REPO}/releases/${rel.id}`).catch(() => {});
          throw e;
        }
        // The installer is safely on GitHub now. If publishing fails here (rare), do NOT delete
        // the release - that would throw away the file that just finished uploading. Leave it as
        // a draft; it's visible (and can be published by hand) on GitHub's own Releases page.
        await gh('PATCH', `/repos/${GITHUB_REPO}/releases/${rel.id}`, { draft: false, make_latest: ghLatestFlag(product, live) })
          .catch((e) => { throw httpError(e.ghStatus === 0 ? 502 : (e.status || 502), `The installer uploaded, but publishing the release failed (${e.message}). Check GitHub's Releases page - the file may already be there as a draft.`); });
        if (live) await clearLiveMarkers(product, String(rel.id));
        invalidate();
        return String(rel.id);
      } finally { rm(file.tmp); }
    },

    async update(id, f, file) {
      notPlaceholder(id);
      try {
        const rel = await getRelease(id);
        const cur = fromGh(rel);
        if (!cur) throw httpError(404, 'Release not found.');
        let sha256 = cur.file ? cur.file.sha256 : null;
        if (file) {
          sha256 = await sha256File(file.tmp);
          const size = fs.statSync(file.tmp).size;
          const oldAssets = (rel.assets || []).filter((a) => ALLOWED_EXT.includes(path.extname(a.name).toLowerCase()));
          const wantName = safeName(file.originalName);
          // GitHub won't allow two assets with the same name in one release, so if the new file
          // is named the same as the one it's replacing, upload it under a temporary name first.
          const clash = oldAssets.some((a) => a.name === wantName);
          const uploadName = clash ? `new-${crypto.randomBytes(3).toString('hex')}-${wantName}` : wantName;
          // Upload the new installer BEFORE touching the old one. If this upload fails (network
          // drop, timeout on a large file, a GitHub hiccup), the old installer is untouched and
          // nothing is lost - the release keeps working exactly as it did before this request.
          const newAsset = await uploadAsset(rel.upload_url, file.tmp, uploadName, size);
          // The new file is safely on GitHub now. Only remove the old one(s).
          for (const a of oldAssets) await gh('DELETE', `/repos/${GITHUB_REPO}/releases/assets/${a.id}`).catch(() => {});
          if (uploadName !== wantName) {
            await gh('PATCH', `/repos/${GITHUB_REPO}/releases/assets/${newAsset.id}`, { name: wantName }).catch(() => {});
          }
        }
        const live = f.makeLatest || cur.live;
        await gh('PATCH', `/repos/${GITHUB_REPO}/releases/${rel.id}`, {
          body: makeBody(f, sha256, live), ...(f.makeLatest ? { make_latest: ghLatestFlag(cur.product, true) } : {}),
        });
        if (f.makeLatest) await clearLiveMarkers(cur.product, String(rel.id));
        invalidate();
      } finally { if (file) rm(file.tmp); }
    },

    async setLatest(id) {
      notPlaceholder(id);
      const rel = await getRelease(id);
      const cur = fromGh(rel);
      if (!cur) throw httpError(404, 'Release not found.');
      await gh('PATCH', `/repos/${GITHUB_REPO}/releases/${rel.id}`, { body: withLive(rel.body, true), make_latest: ghLatestFlag(cur.product, true) });
      await clearLiveMarkers(cur.product, String(rel.id));
      invalidate();
    },

    async remove(id) {
      notPlaceholder(id);
      const rel = await getRelease(id);
      await gh('DELETE', `/repos/${GITHUB_REPO}/releases/${rel.id}`);
      if (rel.tag_name) await gh('DELETE', `/repos/${GITHUB_REPO}/git/refs/tags/${encodeURIComponent(rel.tag_name)}`).catch(() => {});
      invalidate();
    },

    async download(id) {
      const r = (await data()).all.find((x) => x.id === String(id));
      return r && r.file && r.file.url ? { redirect: r.file.url } : null;
    },
  };
}

const store = USE_GITHUB ? makeGithubStore() : makeLocalStore();

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------
function publicRelease(r, latestId) {
  return {
    id: r.id, product: r.product, version: r.version, date: r.date, whatsNew: r.whatsNew, fixes: r.fixes,
    isLatest: r.id === latestId, platform: 'Windows', arch: '64-bit',
    file: r.file ? { name: r.file.name, size: r.file.size, sha256: r.file.sha256 || null } : null,
    downloadUrl: r.file ? `/download/${r.id}` : null,
  };
}
const adminRelease = (r, latestId) => ({
  ...publicRelease(r, latestId), downloads: r.downloads, uploadedAt: r.file ? r.file.uploadedAt : null, placeholder: !!r.placeholder,
});

function readForm(req, releases, existingId) {
  const b = req.body || {};
  const version = String(b.version || '').trim().replace(/^v/i, '');
  if (!VERSION_RE.test(version)) return { error: 'Enter a version like 1.4.0.' };
  if (releases.some((r) => r.version.toLowerCase() === version.toLowerCase() && r.id !== existingId && !r.placeholder)) {
    return { error: `Version ${version} already exists.` };
  }
  const date = String(b.date || today()).trim();
  if (!validDate(date)) return { error: 'Enter a valid release date.' };
  return { version, date, whatsNew: parseLines(b.whatsNew), fixes: parseLines(b.fixes), makeLatest: b.makeLatest !== 'false' };
}

function queryProduct(req) {
  let requested = req.query.product;
  // AutoTitrator 1.3.0 - 1.3.2 ask for /api/latest without ?product=titrator. Without this they would be
  // offered Decay Analyzer releases (and forced to install them). Every titrator build identifies itself
  // with the User-Agent "AutoTitrator/<version>", so answer those copies for Titrator.
  if ((requested == null || requested === '') && /^AutoTitrator\//i.test(String(req.get('user-agent') || ''))) {
    requested = 'titrator';
  }
  const product = productId(requested);
  if (!product) throw httpError(400, 'Unknown product. Use decay-analyzer or titrator.');
  return product;
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/admin')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'");
  }
  next();
});
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '20kb' }));

// TEMPORARY DIAGNOSTIC LOGGING - remove once the "data disappears" issue is found.
// Logs every request that could change something, with the caller's User-Agent, so we can see
// exactly what a client is doing when data goes missing.
app.use((req, res, next) => {
  const risky = req.method !== 'GET' && req.method !== 'HEAD';
  if (risky || req.path.startsWith('/api/admin') || req.path.startsWith('/download')) {
    console.log(`[diag] ${new Date().toISOString()} ${req.method} ${req.originalUrl} ua="${req.get('user-agent') || ''}" ip=${req.ip}`);
  }
  next();
});

// ---- Public API -----------------------------------------------------------
app.get('/api/latest', wrap(async (req, res) => {
  const { latestId, releases } = await store.list(queryProduct(req));
  const r = releases.find((x) => x.id === latestId);
  if (!r) return res.status(404).json({ error: 'No release published yet.' });
  res.json(publicRelease(r, latestId));
}));
app.get('/api/releases', wrap(async (req, res) => {
  const { latestId, releases } = await store.list(queryProduct(req));
  res.json({ latestId, releases: sortedDesc(releases).map((r) => publicRelease(r, latestId)) });
}));

async function sendInstaller(req, res, id) {
  const d = id && await store.download(id);
  if (!d) return res.status(404).send('Installer not available yet.');
  if (d.redirect) { res.setHeader('Cache-Control', 'no-store'); return res.redirect(302, d.redirect); }
  const range = req.headers.range;
  // count real visitor downloads only (not admin test downloads, not resumed range requests)
  if (!readSession(req) && (!range || /^bytes=0-/.test(range))) d.count();
  res.download(d.file, d.name);
}
app.get('/download/latest', wrap(async (req, res) => sendInstaller(req, res, (await store.list(queryProduct(req))).latestId)));
app.get('/download/:id', wrap((req, res) => sendInstaller(req, res, req.params.id)));

// ---- Admin auth -----------------------------------------------------------
app.post('/api/admin/login', async (req, res) => {
  const wait = throttled(req.ip);
  if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
  const { username = '', password = '', remember = false } = req.body || {};
  const userOk = String(username).trim().toLowerCase() === admin.username;
  const passOk = await bcrypt.compare(String(password), userOk ? admin.hash : DUMMY_HASH);
  if (!userOk || !passOk) {
    fail(req.ip);
    await new Promise((r) => setTimeout(r, 500));
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  attempts.delete(req.ip);
  setSession(req, res, remember);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });
app.get('/api/admin/me', requireAuth, (req, res) => res.json({ username: admin.username, storage: store.kind, repo: USE_GITHUB ? GITHUB_REPO : null }));

app.post('/api/admin/account', requireAuth, async (req, res) => {
  if (USE_GITHUB) {
    return res.status(400).json({ error: 'Your login is set in Render. Change ADMIN_USERNAME or ADMIN_PASSWORD under Environment, then redeploy.' });
  }
  const { currentPassword = '', newUsername = '', newPassword = '' } = req.body || {};
  if (!(await bcrypt.compare(String(currentPassword), admin.hash))) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  const uname = String(newUsername).trim().toLowerCase();
  if (uname && !/^[a-z0-9._-]{3,32}$/.test(uname)) {
    return res.status(400).json({ error: 'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.' });
  }
  if (newPassword && String(newPassword).length < 10) {
    return res.status(400).json({ error: 'New password must be at least 10 characters.' });
  }
  if (!uname && !newPassword) return res.status(400).json({ error: 'Enter a new username or a new password.' });
  if (uname) admin.username = uname;
  if (newPassword) admin.hash = await bcrypt.hash(String(newPassword), 12);
  admin.tokenVersion++; // signs out every other session
  saveAdmin();
  setSession(req, res, !!req.session.r);
  res.json({ ok: true, username: admin.username });
});

// ---- Admin releases -------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, rid('upload-') + '.part'),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 12 },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_EXT.includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : Object.assign(new Error('Installer must be an .exe, .msi or .zip file.'), { status: 400 }), ok);
  },
});
const uploadInstaller = (req, res, next) => upload.single('installer')(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') err = Object.assign(new Error(`File is larger than the ${MAX_UPLOAD_MB} MB limit.`), { status: 413 });
  next(err);
});
const fileOf = (req) => (req.file ? { tmp: req.file.path, originalName: req.file.originalname } : null);

app.get('/api/admin/releases', requireAuth, wrap(async (req, res) => {
  const product = queryProduct(req);
  const { latestId, releases } = await store.list(product);
  const real = releases.filter((r) => !r.placeholder);
  res.json({
    product, productName: PRODUCTS[product].name,
    latestId,
    releases: sortedDesc(releases).map((r) => adminRelease(r, latestId)),
    stats: {
      releases: real.length,
      downloads: real.reduce((n, r) => n + r.downloads, 0),
      storageBytes: real.reduce((n, r) => n + (r.file ? r.file.size : 0), 0),
    },
    limits: { maxUploadMb: MAX_UPLOAD_MB, allowed: ALLOWED_EXT, storage: store.kind },
  });
}));

app.post('/api/admin/releases', requireAuth, uploadInstaller, async (req, res, next) => {
  const file = fileOf(req);
  try {
    const given = (req.body || {}).product;
    const product = given ? productId(given) : null; // must be chosen explicitly, never guessed
    if (!product) { rm(file && file.tmp); return res.status(400).json({ error: 'Choose which product this release is for.' }); }
    const { releases } = await store.list(product);
    const f = readForm(req, releases);
    if (f.error) { rm(file && file.tmp); return res.status(400).json({ error: f.error }); }
    if (!file) return res.status(400).json({ error: 'Choose the installer file to upload.' });
    const id = await store.create(product, f, file);
    const data = await store.list(product);
    res.status(201).json(adminRelease(data.releases.find((r) => r.id === id) || {}, data.latestId));
  } catch (e) { rm(file && file.tmp); next(e); }
});

app.put('/api/admin/releases/:id', requireAuth, uploadInstaller, async (req, res, next) => {
  const file = fileOf(req);
  try {
    const existing = await store.find(req.params.id);
    if (!existing) { rm(file && file.tmp); return res.status(404).json({ error: 'Release not found.' }); }
    const { releases } = await store.list(existing.product);
    const f = readForm(req, releases, existing.id);
    if (f.error) { rm(file && file.tmp); return res.status(400).json({ error: f.error }); }
    if (store.kind === 'github' && f.version !== existing.version) {
      rm(file && file.tmp);
      return res.status(400).json({ error: 'The version number can’t be changed after publishing. Delete this release and publish it again with the new number.' });
    }
    await store.update(existing.id, f, file);
    const data = await store.list(existing.product);
    res.json(adminRelease(data.releases.find((r) => r.id === existing.id) || {}, data.latestId));
  } catch (e) { rm(file && file.tmp); next(e); }
});

app.post('/api/admin/releases/:id/latest', requireAuth, wrap(async (req, res) => {
  await store.setLatest(req.params.id);
  res.json({ ok: true });
}));

app.delete('/api/admin/releases/:id', requireAuth, wrap(async (req, res) => {
  const release = await store.find(req.params.id);
  if (!release) return res.status(404).json({ error: 'Release not found.' });
  const { latestId, releases } = await store.list(release.product);
  if (release.id === latestId && releases.length > 1) {
    return res.status(400).json({ error: 'This is the live version. Make another release live before deleting it.' });
  }
  await store.remove(release.id);
  res.json({ ok: true });
}));

// ---- Admin pages ----------------------------------------------------------
app.get(['/admin', '/admin/'], (req, res) => {
  if (!readSession(req)) return res.redirect('/admin/login');
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});
app.get(['/admin/login', '/admin/login.html'], (req, res) => {
  if (readSession(req)) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html'));
});

// ---- Public site ----------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong on the server.' : err.message });
});

app.listen(PORT, () => {
  console.log(`\n  Analab website running at http://localhost:${PORT}`);
  console.log(`  Admin dashboard:         http://localhost:${PORT}/admin`);
  console.log(`  Release storage:         ${USE_GITHUB ? 'GitHub Releases (' + GITHUB_REPO + ')' : 'local disk (' + UPLOAD_DIR + ')'}\n`);
  if (createdAdminName && (generatedPassword || !USE_GITHUB)) {
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │  Admin account created                       │');
    console.log(`  │  Username: ${createdAdminName.padEnd(34)}│`);
    console.log(`  │  Password: ${(generatedPassword || '(from ADMIN_PASSWORD)').padEnd(34)}│`);
    console.log('  │  Change it from Account inside the dashboard │');
    console.log('  └──────────────────────────────────────────────┘\n');
  }
  if (USE_GITHUB && generatedPassword) {
    console.log('  WARNING: ADMIN_PASSWORD is not set, so this random password changes every restart.');
    console.log('  Set ADMIN_PASSWORD in Render, under Environment.\n');
  }
  if (USE_GITHUB) {
    Promise.all(Object.keys(PRODUCTS).map((p) => store.list(p).then((d) => `${PRODUCTS[p].name}: ${d.releases.filter((r) => !r.placeholder).length}`)))
      .then((n) => console.log(`  GitHub connected. Releases found - ${n.join(', ')}.\n`))
      .catch((e) => console.error(`  GitHub check failed: ${e.message}\n`));
  }
});
