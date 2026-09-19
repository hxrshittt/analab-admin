(function () {
  'use strict';

  /* ---------- Pressure-decay curve (the login page's one animated moment) ---------- */
  var X0 = 48, X1 = 600, YTOP = 46, YBOT = 300, LIMIT = 0.5;
  var yOf = function (v) { return YBOT - v * (YBOT - YTOP); };

  var pts = [], N = 150, i, t, v;
  for (i = 0; i <= N; i++) {
    t = i / N;
    // fast settle, then a slow leak; a little sensor texture that fades out
    v = 0.66 + 0.34 * Math.exp(-t * 6) - t * 0.075 + Math.sin(t * 70) * 0.006 * (1 - t);
    pts.push([X0 + t * (X1 - X0), yOf(v)]);
  }
  var d = pts.map(function (p, k) { return (k ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');

  var curve = document.getElementById('curve');
  var decay = document.getElementById('decay');
  var last = pts[pts.length - 1];
  var ly = yOf(LIMIT);

  curve.setAttribute('d', d);
  var limit = document.getElementById('limit');
  limit.setAttribute('y1', ly); limit.setAttribute('y2', ly);
  document.getElementById('limit-label').setAttribute('y', ly + 18);
  var end = document.getElementById('endmark');
  end.setAttribute('transform', 'translate(' + last[0] + ' ' + last[1] + ')');
  document.getElementById('chip').setAttribute('transform', 'translate(' + (last[0] - 176) + ' ' + (last[1] - 62) + ')');

  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    decay.classList.add('drawn');
  } else {
    var len = curve.getTotalLength();
    curve.style.strokeDasharray = len;
    curve.style.strokeDashoffset = len;
    end.style.opacity = 0;
    curve.getBoundingClientRect(); // commit start state
    curve.style.transition = 'stroke-dashoffset 2.6s cubic-bezier(.22,.7,.25,1)';
    curve.style.strokeDashoffset = 0;
    setTimeout(function () { end.style.opacity = 1; decay.classList.add('drawn'); }, 2500);
  }

  /* ---------- Sign in ---------- */
  var form = document.getElementById('login');
  var errBox = document.getElementById('error');
  var btn = document.getElementById('submit');
  var pw = document.getElementById('password');

  document.getElementById('eye').addEventListener('click', function () {
    var show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    this.setAttribute('aria-pressed', String(show));
    this.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  function showError(msg) { errBox.textContent = msg; errBox.hidden = false; }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errBox.hidden = true;
    var username = form.username.value.trim();
    if (!username || !pw.value) { showError('Enter your username and password.'); return; }

    btn.disabled = true; btn.textContent = 'Signing in…';
    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'analab-admin' },
      body: JSON.stringify({ username: username, password: pw.value, remember: document.getElementById('remember').checked })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (r) {
      if (r.ok) { location.href = '/admin'; return; }
      showError(r.data.error || 'Could not sign in. Try again.');
      pw.select();
    }).catch(function () {
      showError('Cannot reach the server. Check your connection and try again.');
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Sign in';
    });
  });
})();
