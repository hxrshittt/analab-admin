'use strict';

/**
 * Analab website server
 * - Serves the public website from /public
 * - Admin login + dashboard at /admin (single admin account, no registration)
 * - Lets the admin publish versions and upload installer files
 * - Public pages read the live version from /api/latest and /api/releases
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 2048;
const ALLOWED_EXT = ['.exe', '.msi', '.zip'];
const COOKIE = 'analab_admin';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// remove half-uploaded files left by a crash
for (const f of fs.readdirSync(UPLOAD_DIR)) if (f.endsWith('.part')) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });

// ---------------------------------------------------------------------------
// Tiny JSON storage (atomic writes)
// ---------------------------------------------------------------------------
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const rid = (p) => p + crypto.randomBytes(5).toString('hex');

// Default state: one placeholder release, version 0.0.0 (no installer).
// Your software can treat 0.0.0 as "nothing published yet" and only update when the version goes higher.
const DEFAULT_VERSION = '0.0.0';
function seedDb() {
  const release = {
    id: rid('r_'), version: DEFAULT_VERSION, date: new Date().toISOString().slice(0, 10),
    whatsNew: [], fixes: [], file: null, downloads: 0, createdAt: new Date().toISOString(),
  };
  return { latestId: release.id, releases: [release] };
}
if (!fs.existsSync(DB_FILE)) writeJson(DB_FILE, seedDb());
let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const saveDb = () => writeJson(DB_FILE, db);

// ---------------------------------------------------------------------------
// Admin account (created on first run, or when --reset-admin is passed)
// ---------------------------------------------------------------------------
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
if (process.argv.includes('--reset-admin') || !fs.existsSync(ADMIN_FILE)) createdAdminName = createAdmin();
let admin = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
const saveAdmin = () => writeJson(ADMIN_FILE, admin);
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

// ---------------------------------------------------------------------------
// Signed session cookie (HMAC, no external deps)
// ---------------------------------------------------------------------------
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

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
// Helpers
// ---------------------------------------------------------------------------
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

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
const filePath = (r) => (r.file ? path.join(UPLOAD_DIR, r.file.stored) : null);

function publicRelease(r) {
  return {
    id: r.id, version: r.version, date: r.date, whatsNew: r.whatsNew, fixes: r.fixes,
    isLatest: r.id === db.latestId, platform: 'Windows', arch: '64-bit',
    file: r.file ? { name: r.file.name, size: r.file.size, sha256: r.file.sha256 } : null,
    downloadUrl: r.file ? `/download/${r.id}` : null,
  };
}
const adminRelease = (r) => ({ ...publicRelease(r), downloads: r.downloads, uploadedAt: r.file ? r.file.uploadedAt : null });
const sorted = () => [...db.releases].sort((a, b) => cmpVersion(b.version, a.version));

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

// ---- Public API -----------------------------------------------------------
app.get('/api/latest', (req, res) => {
  const r = db.releases.find((x) => x.id === db.latestId);
  if (!r) return res.status(404).json({ error: 'No release published yet.' });
  res.json(publicRelease(r));
});
app.get('/api/releases', (req, res) => {
  res.json({ latestId: db.latestId, releases: sorted().map(publicRelease) });
});

function sendInstaller(req, res, release) {
  const p = filePath(release);
  if (!release || !p || !fs.existsSync(p)) return res.status(404).send('Installer not available yet.');
  const range = req.headers.range;
  // count real visitor downloads only (not admin test downloads, not resumed range requests)
  if (!readSession(req) && (!range || /^bytes=0-/.test(range))) { release.downloads++; saveDb(); }
  res.download(p, release.file.name);
}
app.get('/download/latest', (req, res) => sendInstaller(req, res, db.releases.find((r) => r.id === db.latestId)));
app.get('/download/:id', (req, res) => sendInstaller(req, res, db.releases.find((r) => r.id === req.params.id)));

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
app.get('/api/admin/me', requireAuth, (req, res) => res.json({ username: admin.username }));

app.post('/api/admin/account', requireAuth, async (req, res) => {
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

async function storeFile(tmp, originalName, version) {
  const ext = path.extname(originalName).toLowerCase();
  const stored = `analab-${version.replace(/[^\w.-]/g, '_')}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const sha256 = await sha256File(tmp);
  const size = fs.statSync(tmp).size;
  fs.renameSync(tmp, path.join(UPLOAD_DIR, stored));
  return { name: safeName(originalName), stored, size, sha256, uploadedAt: new Date().toISOString() };
}

function readForm(req, { existing } = {}) {
  const b = req.body || {};
  const version = String(b.version || '').trim().replace(/^v/i, '');
  if (!VERSION_RE.test(version)) return { error: 'Enter a version like 1.4.0.' };
  if (db.releases.some((r) => r.version.toLowerCase() === version.toLowerCase() && r !== existing)) {
    return { error: `Version ${version} already exists.` };
  }
  const date = String(b.date || new Date().toISOString().slice(0, 10)).trim();
  if (!validDate(date)) return { error: 'Enter a valid release date.' };
  return { version, date, whatsNew: parseLines(b.whatsNew), fixes: parseLines(b.fixes), makeLatest: b.makeLatest !== 'false' };
}

app.get('/api/admin/releases', requireAuth, (req, res) => {
  const withFiles = db.releases.filter((r) => r.file);
  res.json({
    latestId: db.latestId,
    releases: sorted().map(adminRelease),
    stats: {
      releases: db.releases.length,
      downloads: db.releases.reduce((n, r) => n + r.downloads, 0),
      storageBytes: withFiles.reduce((n, r) => n + r.file.size, 0),
    },
    limits: { maxUploadMb: MAX_UPLOAD_MB, allowed: ALLOWED_EXT },
  });
});

app.post('/api/admin/releases', requireAuth, uploadInstaller, async (req, res, next) => {
  const tmp = req.file && req.file.path;
  try {
    const f = readForm(req);
    if (f.error) { rm(tmp); return res.status(400).json({ error: f.error }); }
    if (!req.file) return res.status(400).json({ error: 'Choose the installer file to upload.' });
    const file = await storeFile(tmp, req.file.originalname, f.version);
    const release = { id: rid('r_'), version: f.version, date: f.date, whatsNew: f.whatsNew, fixes: f.fixes, file, downloads: 0, createdAt: new Date().toISOString() };
    db.releases.push(release);
    if (f.makeLatest || !db.latestId) db.latestId = release.id;
    saveDb();
    res.status(201).json(adminRelease(release));
  } catch (e) { rm(tmp); next(e); }
});

app.put('/api/admin/releases/:id', requireAuth, uploadInstaller, async (req, res, next) => {
  const tmp = req.file && req.file.path;
  try {
    const release = db.releases.find((r) => r.id === req.params.id);
    if (!release) { rm(tmp); return res.status(404).json({ error: 'Release not found.' }); }
    const f = readForm(req, { existing: release });
    if (f.error) { rm(tmp); return res.status(400).json({ error: f.error }); }
    let oldFile = null;
    if (req.file) { oldFile = filePath(release); release.file = await storeFile(tmp, req.file.originalname, f.version); }
    Object.assign(release, { version: f.version, date: f.date, whatsNew: f.whatsNew, fixes: f.fixes });
    if (f.makeLatest) db.latestId = release.id;
    saveDb();
    rm(oldFile);
    res.json(adminRelease(release));
  } catch (e) { rm(tmp); next(e); }
});

app.post('/api/admin/releases/:id/latest', requireAuth, (req, res) => {
  const release = db.releases.find((r) => r.id === req.params.id);
  if (!release) return res.status(404).json({ error: 'Release not found.' });
  db.latestId = release.id;
  saveDb();
  res.json({ ok: true });
});

app.delete('/api/admin/releases/:id', requireAuth, (req, res) => {
  const release = db.releases.find((r) => r.id === req.params.id);
  if (!release) return res.status(404).json({ error: 'Release not found.' });
  if (release.id === db.latestId && db.releases.length > 1) {
    return res.status(400).json({ error: 'This is the live version. Make another release live before deleting it.' });
  }
  db.releases = db.releases.filter((r) => r !== release);
  if (db.latestId === release.id) db.latestId = null;
  saveDb();
  rm(filePath(release));
  res.json({ ok: true });
});

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
  console.log(`  Admin dashboard:         http://localhost:${PORT}/admin\n`);
  if (createdAdminName) {
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │  Admin account created                       │');
    console.log(`  │  Username: ${createdAdminName.padEnd(34)}│`);
    console.log(`  │  Password: ${(generatedPassword || '(from ADMIN_PASSWORD)').padEnd(34)}│`);
    console.log('  │  Change it from Account inside the dashboard │');
    console.log('  └──────────────────────────────────────────────┘\n');
  }
});
