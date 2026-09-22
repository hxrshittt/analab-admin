(function () {
  'use strict';

  var $ = function (s, el) { return (el || document).querySelector(s); };
  var view = $('#view');
  var PRODUCTS = {
    'decay-analyzer': { name: 'Decay Analyzer', page: '/downloads.html' },
    titrator: { name: 'Titrator', page: '/titrator/downloads.html' }
  };
  var saved = null;
  try { saved = localStorage.getItem('analab-admin-product'); } catch (e) { /* storage blocked */ }
  var state = { data: null, me: null, product: PRODUCTS[saved] ? saved : 'decay-analyzer' };
  var pname = function () { return PRODUCTS[state.product].name; };

  /* ---------- Icons ---------- */
  var svg = function (body, extra) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' + (extra || '') + '>' + body + '</svg>';
  };
  var I = {
    file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/>'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
    download: svg('<path d="M12 4v11m0 0-5-5m5 5 5-5"/><path d="M4 19h16"/>'),
    edit: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>'),
    trash: svg('<path d="M4 7h16M10 11v6m4-6v6"/><path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/>'),
    check: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>'),
    alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>'),
    cloud: svg('<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.75 4.75 0 0 1-.5 9.5"/><path d="M12 21v-8m0 0-3 3m3-3 3 3"/>'),
    x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    ext: svg('<path d="M14 4h6v6m0-6L10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
    eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>')
  };

  /* ---------- Helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtSize(b) {
    if (!b) return '0 MB';
    var mb = b / 1048576;
    if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
    return (mb >= 100 ? Math.round(mb) : mb.toFixed(1)) + ' MB';
  }
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '—';
    return (+m[3]) + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2] - 1] + ' ' + m[1];
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function shortHash(h) { return h ? h.slice(0, 4) + '…' + h.slice(-4) : ''; }
  function lines(text) {
    return String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/^\s*[-*•]\s*/, '').trim(); }).filter(Boolean);
  }

  function toast(msg, type) {
    var t = document.createElement('div');
    t.className = 'toast' + (type === 'err' ? ' err' : '');
    t.innerHTML = (type === 'err' ? I.alert : I.check) + '<span>' + esc(msg) + '</span>';
    $('#toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, 4500);
  }

  function confirmDialog(o) {
    var dlg = $('#confirm');
    $('#confirm-title').textContent = o.title;
    $('#confirm-text').textContent = o.text;
    $('#confirm-yes').textContent = o.yes || 'Delete';
    return new Promise(function (resolve) {
      var done = function (v) { dlg.close(); $('#confirm-yes').onclick = $('#confirm-no').onclick = null; resolve(v); };
      $('#confirm-yes').onclick = function () { done(true); };
      $('#confirm-no').onclick = function () { done(false); };
      dlg.oncancel = function () { resolve(false); };
      dlg.showModal();
    });
  }

  function api(method, url, body) {
    var opts = { method: method, headers: { 'X-Requested-With': 'analab-admin' } };
    if (body instanceof FormData) opts.body = body;
    else if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) { location.href = '/admin/login'; throw new Error('Signed out'); }
        if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
        return data;
      });
    });
  }

  // XHR so we can show real upload progress
  function sendWithProgress(method, url, form, onProgress) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open(method, url);
      x.setRequestHeader('X-Requested-With', 'analab-admin');
      x.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      x.onload = function () {
        var data = {};
        try { data = JSON.parse(x.responseText); } catch (e) { /* ignore */ }
        if (x.status === 401) { location.href = '/admin/login'; return; }
        if (x.status >= 200 && x.status < 300) resolve(data);
        else reject(new Error(data.error || 'Upload failed. Try again.'));
      };
      x.onerror = function () { reject(new Error('Upload interrupted. Check your connection and try again.')); };
      x.send(form);
    });
  }

  function load() {
    return api('GET', '/api/admin/releases?product=' + encodeURIComponent(state.product)).then(function (d) { state.data = d; });
  }
  function paintProduct() {
    var pick = $('.product-pick');
    pick.setAttribute('data-active', state.product);
    document.querySelectorAll('.product-pick button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.product === state.product ? 'true' : 'false');
    });
  }
  function setProduct(id) {
    var pick = $('.product-pick'), changed = id !== state.product;
    state.product = id;
    try { localStorage.setItem('analab-admin-product', id); } catch (e) { /* storage blocked */ }
    paintProduct();
    if (changed && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      pick.classList.add('pulse');
      setTimeout(function () { pick.classList.remove('pulse'); }, 260);
    }
  }

  /* ---------- Decorative curve for the live card ---------- */
  function liveCurve() {
    var p = [], i, t, v, N = 60;
    for (i = 0; i <= N; i++) {
      t = i / N;
      v = 0.62 + 0.38 * Math.exp(-t * 6) - t * 0.07;
      p.push((t * 400).toFixed(1) + ' ' + (170 - v * 140).toFixed(1));
    }
    return '<svg class="live-curve" viewBox="0 0 400 200" aria-hidden="true"><line x1="0" x2="400" y1="' + (170 - 0.5 * 140) + '" y2="' + (170 - 0.5 * 140) + '"/><path d="M' + p.join(' L') + '"/></svg>';
  }

  /* ---------- Releases view ---------- */
  function renderReleases() {
    var d = state.data, live = d.releases.find(function (r) { return r.id === d.latestId; });
    document.title = 'Releases · ' + pname() + ' | Analab admin';

    var liveHtml;
    if (live) {
      var fileBits = live.file
        ? '<span class="chip">' + I.file + '<span>' + esc(live.file.name) + '</span></span>' +
          '<span class="chip">' + fmtSize(live.file.size) + '</span>' +
          '<span class="chip"><span class="mono" title="' + esc(live.file.sha256) + '">SHA-256 ' + esc(shortHash(live.file.sha256)) + '</span>' +
          '<button type="button" data-copy="' + esc(live.file.sha256) + '" title="Copy full checksum" aria-label="Copy full checksum">' + I.copy + '</button></span>'
        : (live.version === '0.0.0'
          ? '<span class="chip">' + I.alert + '<span>Default placeholder. Publish your first real release to replace it.</span></span>'
          : '<span class="chip warn">' + I.alert + '<span>No installer uploaded. Visitors can’t download this version yet.</span></span>' +
            '<a class="btn btn-light btn-sm" href="#/edit/' + live.id + '">Upload installer</a>');
      liveHtml =
        '<section class="live">' + liveCurve() +
        '<div class="live-top"><div>' +
        '<div class="live-tag"><span class="dot"></span>Live on your website (' + esc(pname()) + ')</div>' +
        '<div class="live-ver">v' + esc(live.version) + '</div>' +
        '<div class="live-meta">Released ' + fmtDate(live.date) + '</div>' +
        '<div class="live-file">' + fileBits + '</div></div>' +
        '<div class="live-actions"><a class="btn btn-light" href="#/new">' + I.plus + 'Publish new version</a>' +
        '<a class="btn btn-ghost" href="' + PRODUCTS[state.product].page + '" target="_blank" rel="noopener">' + I.ext + 'Open downloads page</a></div></div>' +
        '<div class="live-stats">' +
        '<div class="stat"><b>' + live.downloads + '</b><span>Downloads of v' + esc(live.version) + '</span></div>' +
        '<div class="stat"><b>' + d.stats.downloads + '</b><span>Downloads, all versions</span></div>' +
        '<div class="stat"><b>' + d.stats.releases + '</b><span>Releases published</span></div>' +
        '<div class="stat"><b>' + fmtSize(d.stats.storageBytes) + '</b><span>Installer storage used</span></div>' +
        '</div></section>';
    } else {
      liveHtml =
        '<section class="live live-empty">' + liveCurve() +
        '<div class="live-top"><div><div class="live-tag" style="color:#ffd88a">Nothing is live yet</div>' +
        '<div class="live-ver" style="font-size:34px">Publish your first version</div>' +
        '<div class="live-meta">Upload an installer and it appears on the downloads page.</div></div>' +
        '<div class="live-actions"><a class="btn btn-light" href="#/new">' + I.plus + 'New release</a></div></div></section>';
    }

    var rows = d.releases.map(function (r) {
      var isLive = r.id === d.latestId, only = d.releases.length === 1;
      return '<div class="rel" data-id="' + r.id + '">' +
        '<div class="c-ver"><b>' + esc(r.version) + '</b>' + (isLive ? '<span class="pill pill-live">Live</span>' : '') + '</div>' +
        '<div class="c-date">' + fmtDate(r.date) + '</div>' +
        '<div class="c-file">' + (r.file
          ? '<span class="fname" title="' + esc(r.file.name) + '">' + esc(r.file.name) + '</span><small>' + fmtSize(r.file.size) + '</small>'
          : (r.placeholder ? '<small>Default placeholder</small>' : '<span class="pill pill-warn">No installer</span>')) + '</div>' +
        '<div class="c-dl">' + r.downloads + '</div>' +
        '<div class="c-act">' + (r.placeholder ? '' :
        (isLive ? '' : '<button class="btn btn-outline btn-sm" type="button" data-action="live">Make live</button>') +
        (r.file ? '<a class="icon-btn" href="' + r.downloadUrl + '" title="Download installer" aria-label="Download installer for ' + esc(r.version) + '">' + I.download + '</a>' : '') +
        '<a class="icon-btn" href="#/edit/' + r.id + '" title="Edit release" aria-label="Edit ' + esc(r.version) + '">' + I.edit + '</a>' +
        ((!isLive || only) ? '<button class="icon-btn danger" type="button" data-action="delete" title="Delete release" aria-label="Delete ' + esc(r.version) + '">' + I.trash + '</button>' : '')) +
        '</div></div>';
    }).join('');

    view.innerHTML =
      '<div class="page-head"><div><h1>' + esc(pname()) + ' releases</h1><p>What visitors see on the ' + esc(pname()) + ' pages of your website, and every version you have published.</p></div>' +
      '<a class="btn btn-primary" href="#/new">' + I.plus + 'New release</a></div>' +
      liveHtml +
      '<section class="card"><div class="card-head"><h2>All releases</h2><span>' + d.releases.length + ' total</span></div>' +
      (rows
        ? '<div class="rel rel-head"><span>Version</span><span>Released</span><span>Installer</span><span>Downloads</span><span></span></div>' + rows
        : '<div class="empty"><h3>No releases yet</h3><p>Publish a version to see it here.</p><a class="btn btn-primary" href="#/new">New release</a></div>') +
      '</section>';
  }

  /* ---------- Release form (new + edit) ---------- */
  function renderForm(id) {
    var d = state.data, editing = id ? d.releases.find(function (r) { return r.id === id; }) : null;
    if (id && !editing) { toast('That release no longer exists.', 'err'); location.hash = '#/releases'; return; }
    document.title = (editing ? 'Edit v' + editing.version : 'New release') + ' · ' + pname() + ' | Analab admin';

    var top = d.releases[0], chosen = null;
    var locked = !!editing && d.limits.storage === 'github';
    var isLive = editing && editing.id === d.latestId;
    var m = top && /^(\d+)\.(\d+)\.(\d+)/.exec(top.version);
    var bumps = (!editing && m) ? [['Patch', m[1] + '.' + m[2] + '.' + (+m[3] + 1)], ['Minor', m[1] + '.' + (+m[2] + 1) + '.0'], ['Major', (+m[1] + 1) + '.0.0']] : [];

    view.innerHTML =
      '<div class="page-head"><div><h1>' + (editing ? 'Edit v' + esc(editing.version) : 'New ' + esc(pname()) + ' release') + '</h1>' +
      '<p>' + (editing ? 'Change the details or replace the installer.' : 'Publishing to the ' + esc(pname()) + ' pages. Set the version, add release notes and upload the installer.') + '</p></div></div>' +
      '<form id="rel-form" class="form-grid" novalidate>' +
      '<div>' +
        '<section class="card panel"><h2>Version details</h2>' +
        '<div class="two">' +
          '<div class="field"><label for="f-version">Version number</label>' +
          '<input class="input mono" id="f-version" placeholder="1.4.0" autocomplete="off" spellcheck="false"' + (locked ? ' readonly' : '') + ' value="' + esc(editing ? editing.version : '') + '">' +
          (locked ? '<div class="hint">The version number can’t change after publishing. To change it, delete this release and publish again.</div>' : '') +
          (bumps.length ? '<div class="bumps" aria-label="Suggested versions">' + bumps.map(function (b) { return '<button class="bump" type="button" data-v="' + b[1] + '"><small>' + b[0] + '</small>' + b[1] + '</button>'; }).join('') + '</div>' : '') +
          '</div>' +
          '<div class="field"><label for="f-date">Release date</label><input class="input" id="f-date" type="date" value="' + esc(editing ? editing.date : today()) + '"></div>' +
        '</div>' +
        '<div class="field"><label for="f-new">What’s new</label><textarea class="textarea" id="f-new" placeholder="Faster analysis for long test runs&#10;Improved reconnect handling">' + esc(editing ? editing.whatsNew.join('\n') : '') + '</textarea><div class="hint">One item per line. Each line becomes a bullet on the website.</div></div>' +
        '<div class="field" style="margin-bottom:0"><label for="f-fix">Bug fixes <span style="font-weight:400;color:var(--muted)">(optional)</span></label><textarea class="textarea" id="f-fix" style="min-height:88px" placeholder="Fixed report export on large files">' + esc(editing ? editing.fixes.join('\n') : '') + '</textarea></div>' +
        '</section>' +
        '<section class="card panel"><h2>How it will look on your website</h2><div class="preview" id="preview"></div></section>' +
      '</div>' +
      '<div>' +
        '<section class="card panel"><h2>Installer</h2>' +
        '<div id="file-area"></div>' +
        '<div class="progress" id="progress" hidden><div class="bar"><i id="bar"></i></div><div class="progress-meta"><span id="p-text">Uploading…</span><span id="p-pct" class="mono">0%</span></div></div>' +
        '<label class="switch"><input type="checkbox" id="f-live"' + ((isLive || !editing) ? ' checked' : '') + '><span class="track"></span>' +
          '<span><b>Make this the live version</b><span class="hint">The website’s version number and download button switch to this release.</span></span></label>' +
        '<div class="alert alert-error" id="form-error" role="alert" hidden></div>' +
        '<div class="form-actions"><button class="btn btn-primary btn-block" id="save" type="submit">' + (editing ? 'Save changes' : 'Publish release') + '</button>' +
        '<a class="btn btn-outline btn-block" href="#/releases">Cancel</a></div>' +
        '</section>' +
      '</div></form>';

    var f = { v: $('#f-version'), date: $('#f-date'), n: $('#f-new'), x: $('#f-fix'), live: $('#f-live'), area: $('#file-area'), err: $('#form-error') };

    function preview() {
      var n = lines(f.n.value), x = lines(f.x.value), v = f.v.value.trim().replace(/^v/i, '');
      var list = function (title, arr) { return arr.length ? '<h3>' + title + '</h3><ul>' + arr.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>' : ''; };
      $('#preview').innerHTML =
        '<div class="preview-top"><span class="v">' + (v ? esc(v) : '—') + '</span>' + (f.live.checked ? '<span class="latest">Latest</span>' : '') +
        '<span class="d">Released on<br>' + fmtDate(f.date.value) + '</span></div>' +
        '<div class="preview-body">' + (list('What’s New', n) + list('Bug Fixes', x) || '<p class="none">Add release notes and they appear here.</p>') + '</div>';
    }

    function paintFile() {
      var cur = editing && editing.file;
      if (chosen) {
        f.area.innerHTML = '<div class="picked"><div class="ficon">' + I.file + '</div><div class="picked-text"><b>' + esc(chosen.name) + '</b><span>' + fmtSize(chosen.size) + ' · ready to upload</span></div>' +
          '<button class="icon-btn" type="button" id="unpick" title="Remove file" aria-label="Remove file">' + I.x + '</button></div>';
        $('#unpick').onclick = function () { chosen = null; paintFile(); };
        return;
      }
      f.area.innerHTML =
        (cur ? '<div class="picked" style="margin-bottom:12px"><div class="ficon">' + I.file + '</div><div class="picked-text"><b>' + esc(cur.name) + '</b><span>Current installer · ' + fmtSize(cur.size) + '</span></div></div>' : '') +
        '<input class="sr" id="file" type="file" accept=".exe,.msi,.zip">' +
        '<label class="drop" id="drop" for="file">' + I.cloud + '<b>' + (cur ? 'Replace installer' : 'Drop the installer here') + '</b>' +
        '<span>or <u>browse files</u></span><span>.exe, .msi or .zip, up to ' + (d.limits.maxUploadMb >= 1024 ? (d.limits.maxUploadMb / 1024) + ' GB' : d.limits.maxUploadMb + ' MB') + '</span></label>';
      var drop = $('#drop'), input = $('#file');
      input.onchange = function () { if (input.files[0]) pick(input.files[0]); };
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
      drop.addEventListener('drop', function (e) { if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]); });
    }

    function pick(file) {
      f.err.hidden = true;
      var okExt = /\.(exe|msi|zip)$/i.test(file.name);
      if (!okExt) { showErr('The installer must be an .exe, .msi or .zip file.'); return; }
      if (file.size > d.limits.maxUploadMb * 1048576) { showErr('That file is ' + fmtSize(file.size) + '. The upload limit is ' + d.limits.maxUploadMb + ' MB.'); return; }
      chosen = file; paintFile();
    }
    function showErr(msg) { f.err.textContent = msg; f.err.hidden = false; f.err.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }

    ['input', 'change'].forEach(function (ev) { [f.v, f.date, f.n, f.x, f.live].forEach(function (el) { el.addEventListener(ev, preview); }); });
    view.querySelectorAll('.bump').forEach(function (b) { b.onclick = function () { f.v.value = b.dataset.v; preview(); f.v.focus(); }; });

    $('#rel-form').addEventListener('submit', function (e) {
      e.preventDefault();
      f.err.hidden = true;
      var version = f.v.value.trim().replace(/^v/i, '');
      if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) { showErr('Enter a version like 1.4.0.'); f.v.focus(); return; }
      if (!f.date.value) { showErr('Choose a release date.'); return; }
      if (!editing && !chosen) { showErr('Choose the installer file to upload.'); return; }

      var fd = new FormData();
      fd.append('product', state.product);
      fd.append('version', version); fd.append('date', f.date.value);
      fd.append('whatsNew', f.n.value); fd.append('fixes', f.x.value);
      fd.append('makeLatest', f.live.checked ? 'true' : 'false');
      if (chosen) fd.append('installer', chosen);

      var save = $('#save'), prog = $('#progress');
      save.disabled = true; save.textContent = chosen ? 'Uploading…' : 'Saving…';
      var start = Date.now();
      var onProgress = function (loaded, total) {
        prog.hidden = false;
        var pct = Math.floor(loaded / total * 100);
        $('#bar').style.width = pct + '%'; $('#p-pct').textContent = pct + '%';
        $('#p-text').textContent = pct >= 100 ? (d.limits.storage === 'github' ? 'Sending to GitHub, this can take a minute…' : 'Verifying checksum…') : fmtSize(loaded) + ' of ' + fmtSize(total);
      };
      var req = chosen
        ? sendWithProgress(editing ? 'PUT' : 'POST', editing ? '/api/admin/releases/' + editing.id : '/api/admin/releases', fd, onProgress)
        : api('PUT', '/api/admin/releases/' + editing.id, fd);

      req.then(function () {
        toast(editing ? 'Saved changes to v' + version : 'Published v' + version + (f.live.checked ? ' and made it live' : ''));
        location.hash = '#/releases';
      }).catch(function (err) {
        prog.hidden = true;
        save.disabled = false; save.textContent = editing ? 'Save changes' : 'Publish release';
        showErr(err.message);
      });
    });

    paintFile(); preview();
  }

  /* ---------- Account ---------- */
  function renderAccount() {
    document.title = 'Account | Analab admin';
    if (state.me.storage === 'github') {
      view.innerHTML =
        '<div class="page-head"><div><h1>Account</h1><p>Signed in as <b>' + esc(state.me.username) + '</b>.</p></div></div>' +
        '<section class="card panel narrow"><h2>Change your login</h2>' +
        '<p class="hint" style="font-size:14px;line-height:1.6">Your username and password are set in Render, so they stay the same when the server restarts. ' +
        'To change them, open your service in Render, go to <b>Environment</b>, edit <span class="mono">ADMIN_USERNAME</span> or <span class="mono">ADMIN_PASSWORD</span>, and save. Render redeploys and the new login works.</p>' +
        '<p class="hint" style="font-size:14px;line-height:1.6;margin-top:14px">Releases are stored as GitHub Releases in <b>' + esc(state.me.repo || '') + '</b>.</p></section>';
      return;
    }
    view.innerHTML =
      '<div class="page-head"><div><h1>Account</h1><p>Change the username or password used to sign in.</p></div></div>' +
      '<section class="card panel narrow"><form id="acct" novalidate autocomplete="off">' +
      '<div class="field"><label for="a-user">Username</label><input class="input" id="a-user" value="' + esc(state.me.username) + '" autocapitalize="none" spellcheck="false" autocomplete="off"></div>' +
      '<div class="field"><label for="a-new">New password</label><input class="input" id="a-new" type="password" autocomplete="new-password"><div class="hint">At least 10 characters. Leave empty to keep your current password.</div></div>' +
      '<div class="field"><label for="a-new2">Confirm new password</label><input class="input" id="a-new2" type="password" autocomplete="new-password"></div>' +
      '<div class="field"><label for="a-cur">Current password</label><input class="input" id="a-cur" type="password" autocomplete="current-password"><div class="hint">Required to save any change. Saving signs you out on other devices.</div></div>' +
      '<div class="alert alert-error" id="a-err" role="alert" hidden></div>' +
      '<button class="btn btn-primary" id="a-save" type="submit">Save changes</button></form></section>';

    $('#acct').addEventListener('submit', function (e) {
      e.preventDefault();
      var err = $('#a-err'), user = $('#a-user').value.trim().toLowerCase(), np = $('#a-new').value;
      err.hidden = true;
      var fail = function (m) { err.textContent = m; err.hidden = false; };
      if (np && np !== $('#a-new2').value) return fail('The new passwords do not match.');
      if (!$('#a-cur').value) return fail('Enter your current password to confirm.');
      var body = { currentPassword: $('#a-cur').value, newPassword: np };
      if (user && user !== state.me.username) body.newUsername = user;
      if (!body.newUsername && !np) return fail('Change the username or enter a new password.');
      var btn = $('#a-save'); btn.disabled = true;
      api('POST', '/api/admin/account', body).then(function (r) {
        state.me.username = r.username; paintMe();
        toast('Account updated'); renderAccount();
      }).catch(function (ex) { fail(ex.message); btn.disabled = false; });
    });
  }

  /* ---------- Actions on the releases list ---------- */
  view.addEventListener('click', function (e) {
    var copy = e.target.closest('[data-copy]');
    if (copy) {
      var text = copy.dataset.copy;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(
        function () { toast('Checksum copied'); },
        function () { toast('Could not copy. Select the checksum manually.', 'err'); });
      return;
    }
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var row = btn.closest('.rel'), id = row.dataset.id;
    var rel = state.data.releases.find(function (r) { return r.id === id; });

    if (btn.dataset.action === 'live') {
      btn.disabled = true;
      api('POST', '/api/admin/releases/' + id + '/latest').then(function () {
        toast('v' + rel.version + ' is now live'); return refresh();
      }).catch(function (ex) { toast(ex.message, 'err'); btn.disabled = false; });
    }
    if (btn.dataset.action === 'delete') {
      confirmDialog({
        title: 'Delete v' + rel.version + '?',
        text: 'This removes the release' + (rel.file ? ' and its installer file' : '') + ' from your website. This can’t be undone.',
        yes: 'Delete release'
      }).then(function (yes) {
        if (!yes) return;
        api('DELETE', '/api/admin/releases/' + id).then(function () { toast('Deleted v' + rel.version); return refresh(); })
          .catch(function (ex) { toast(ex.message, 'err'); });
      });
    }
  });

  /* ---------- Shell ---------- */
  function paintMe() {
    $('#me-name').textContent = state.me.username;
    $('#avatar').textContent = state.me.username.charAt(0);
  }
  function setNav(name) {
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      if (a.dataset.nav === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  function refresh() { return route(); }

  function route() {
    var parts = (location.hash.replace(/^#\/?/, '') || 'releases').split('/');
    var name = parts[0], arg = parts[1];
    setNav(name === 'edit' ? 'releases' : name);
    window.scrollTo(0, 0);
    if (name === 'account') return renderAccount();
    view.innerHTML = '<div class="loading">Loading…</div>';
    return load().then(function () {
      if (name === 'edit' && !state.data.releases.some(function (r) { return r.id === arg; })) {
        // the release may belong to the other product (bookmark, refresh): look there before giving up
        var other = state.product === 'titrator' ? 'decay-analyzer' : 'titrator';
        var keep = state.product;
        state.product = other;
        return load().then(function () {
          if (state.data.releases.some(function (r) { return r.id === arg; })) { setProduct(other); return; }
          state.product = keep; return load();
        });
      }
    }).then(function () {
      if (name === 'new') return renderForm();
      if (name === 'edit') return renderForm(arg);
      renderReleases();
    }).catch(function (ex) { if (ex.message !== 'Signed out') view.innerHTML = '<div class="loading">' + esc(ex.message) + '</div>'; });
  }

  $('#signout').addEventListener('click', function () {
    api('POST', '/api/admin/logout').then(function () { location.href = '/admin/login'; });
  });
  document.querySelector('.product-pick').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-product]');
    if (!b || b.dataset.product === state.product) return;
    setProduct(b.dataset.product);
    var name = (location.hash.replace(/^#\/?/, '') || 'releases').split('/')[0];
    if (name === 'edit') location.hash = '#/releases'; // that release belongs to the other product
    else route();
  });
  window.addEventListener('hashchange', route);

  paintProduct();
  api('GET', '/api/admin/me').then(function (me) { state.me = me; paintMe(); route(); });
})();
