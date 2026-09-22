/*
 * Live titration demo for the Titrator page.
 *
 * It simulates 25.00 mL of 0.1000 mol/L acetic acid being titrated with 0.1000 mol/L NaOH. The pH values come from the
 * real charge-balance equation (no hand-drawn curve). The "instrument" adds titrant in big steps far from the endpoint and
 * tiny steps close to it, records each reading, then finds the endpoint the same way titration software does: the
 * steepest point of the curve, located from the readings it took.
 */
(function () {
  'use strict';

  var root = document.querySelector('[data-titration-demo]');
  if (!root) return;

  /* ---------- chemistry ---------- */
  var VA = 25, CA = 0.1, CB = 0.1, KA = 1.8e-5, KW = 1e-14;

  // pH after adding V mL of titrant. Solves  [H+] + [Na+] = [OH-] + [A-]  by bisection on log10[H+].
  function pH(V) {
    var total = VA + V, c = CA * VA / total, na = CB * V / total;
    var lo = -14, hi = 0, mid, h, f, i;
    for (i = 0; i < 60; i++) {
      mid = (lo + hi) / 2; h = Math.pow(10, mid);
      f = h + na - KW / h - c * KA / (KA + h);
      if (f > 0) hi = mid; else lo = mid;
    }
    return -(lo + hi) / 2;
  }

  /* ---------- the run: where the instrument takes a reading ---------- */
  var volumes = [];
  function dose(from, to, step) { for (var v = from; v < to - 1e-9; v += step) volumes.push(Math.round(v * 1000) / 1000); }
  dose(0, 10, 2.5); dose(10, 20, 2); dose(20, 23, 1); dose(23, 24.4, 0.35);
  dose(24.4, 25.6, 0.1);                                   // fine dosing around the endpoint
  dose(25.6, 27, 0.35); dose(27, 30, 1); dose(30, 50, 4); volumes.push(50);
  var readings = volumes.map(function (v) { return [v, pH(v)]; });

  // endpoint = peak of the first derivative, refined with a parabola through the three points around the peak
  var rate = [], k, best = 0;
  for (k = 1; k < readings.length; k++) {
    rate.push([(readings[k][0] + readings[k - 1][0]) / 2, (readings[k][1] - readings[k - 1][1]) / (readings[k][0] - readings[k - 1][0])]);
    if (rate[rate.length - 1][1] > rate[best][1]) best = rate.length - 1;
  }
  var a = rate[best - 1], b = rate[best], c = rate[best + 1];
  var den = (a[0] - b[0]) * (a[0] - c[0]) * (b[0] - c[0]);
  var qa = (c[0] * (b[1] - a[1]) + b[0] * (a[1] - c[1]) + a[0] * (c[1] - b[1])) / den;
  var qb = (c[0] * c[0] * (a[1] - b[1]) + b[0] * b[0] * (c[1] - a[1]) + a[0] * a[0] * (b[1] - c[1])) / den;
  var endpoint = -qb / (2 * qa);
  var concentration = CB * endpoint / VA;
  var maxRate = rate[best][1];

  /* ---------- chart geometry ---------- */
  var W = 520, H = 298, L = 40, R = 506, T = 22, BOT = 256;
  var xOf = function (v) { return L + v / 50 * (R - L); };
  var yOf = function (p) { return BOT - p / 14 * (BOT - T); };
  var pt = function (x, y) { return x.toFixed(1) + ' ' + y.toFixed(1); };

  // smooth curve: dense samples, extra dense where it is steep
  var dense = [], v;
  for (v = 0; v <= 50 + 1e-9; v += 0.25) if (v < 23.5 || v > 26.5) dense.push(v);
  for (v = 23.5; v <= 26.5 + 1e-9; v += 0.04) dense.push(v);
  dense.sort(function (p, q) { return p - q; });
  var curvePts = dense.map(function (d) { return [d, pt(xOf(d), yOf(pH(d)))]; });
  // the curve as far as the titration has got (ends exactly on the latest reading, so a steep curve never leaks past it)
  function curveTo(vol) {
    var out = [], j;
    for (j = 0; j < curvePts.length && curvePts[j][0] < vol - 1e-9; j++) out.push(curvePts[j][1]);
    out.push(pt(xOf(vol), yOf(pH(vol))));
    return 'M' + out.join(' L');
  }

  // first-derivative trace, drawn from the same readings the instrument took
  var ratePts = rate.map(function (r) { return pt(xOf(r[0]), BOT - (r[1] / maxRate) * 0.55 * (BOT - T)); });
  function rateTo(count) { return count > 0 ? 'M' + ratePts.slice(0, count).join(' L') : ''; }

  var xEnd = xOf(endpoint), yEnd = yOf(pH(endpoint));
  var endText = 'Endpoint at ' + endpoint.toFixed(2) + ' mL';

  var grid = '', labels = '', p;
  for (p = 0; p <= 14; p += 2) {
    grid += '<line class="' + (p === 0 ? 'axis' : 'grid') + '" x1="' + L + '" x2="' + R + '" y1="' + yOf(p).toFixed(1) + '" y2="' + yOf(p).toFixed(1) + '"/>';
    labels += '<text x="' + (L - 8) + '" y="' + (yOf(p) + 3.5).toFixed(1) + '" text-anchor="end">' + p + '</text>';
  }
  for (v = 0; v <= 50; v += 10) labels += '<text x="' + xOf(v).toFixed(1) + '" y="' + (BOT + 17) + '" text-anchor="middle">' + v + '</text>';
  labels += '<text x="' + L + '" y="11">pH</text><text x="' + ((L + R) / 2) + '" y="' + (H - 3) + '" text-anchor="middle">Volume added (mL)</text>';

  var dots = readings.map(function (r) {
    return '<circle class="dot" r="2.5" cx="' + xOf(r[0]).toFixed(1) + '" cy="' + yOf(r[1]).toFixed(1) + '" visibility="hidden"/>';
  }).join('');

  var svg =
    '<svg class="tw-chart" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true" focusable="false">' +
    grid + labels +
    '<path class="rate" d=""/><path class="curve" d=""/>' +
    '<g class="dots">' + dots + '</g>' +
    '<path class="end-mark" d="M' + (xEnd - 5.5).toFixed(1) + ' ' + (BOT + 6) + ' L' + (xEnd + 5.5).toFixed(1) + ' ' + (BOT + 6) + ' L' + xEnd.toFixed(1) + ' ' + (BOT - 3) + ' Z"/>' +
    '<circle class="end-ring" cx="' + xEnd.toFixed(1) + '" cy="' + yEnd.toFixed(1) + '" r="4"/>' +
    '<circle class="end-dot" cx="' + xEnd.toFixed(1) + '" cy="' + yEnd.toFixed(1) + '" r="5"/>' +
    '<g class="end-tag"><rect x="' + (xEnd + 12).toFixed(1) + '" y="' + (yEnd - 13).toFixed(1) + '" width="152" height="25" rx="12.5"/>' +
    '<text x="' + (xEnd + 25).toFixed(1) + '" y="' + (yEnd + 3.8).toFixed(1) + '">' + endText + '</text></g>' +
    '</svg>';

  root.querySelector('[data-tw-chart]').innerHTML = svg;

  /* ---------- playback ---------- */
  var curveEl = root.querySelector('.curve'), rateEl = root.querySelector('.rate');
  var dotEls = root.querySelectorAll('.dot');
  var volEl = root.querySelector('[data-tw-vol]'), phEl = root.querySelector('[data-tw-ph]');
  var statusEl = root.querySelector('[data-tw-status]');
  var endEl = root.querySelector('[data-tw-end]'), concEl = root.querySelector('[data-tw-conc]');
  var replay = root.querySelector('[data-tw-replay]');
  var timer = null, index = 0, started = false;

  function show(i) {
    curveEl.setAttribute('d', curveTo(readings[i][0]));
    rateEl.setAttribute('d', rateTo(i));
    dotEls[i].setAttribute('visibility', 'visible');
    volEl.textContent = readings[i][0].toFixed(2);
    phEl.textContent = readings[i][1].toFixed(2);
  }
  function finish() {
    statusEl.textContent = 'Endpoint found';
    endEl.textContent = endpoint.toFixed(2);
    concEl.textContent = concentration.toFixed(4);
    root.classList.add('is-done');
    replay.disabled = false;
  }
  function reset() {
    clearTimeout(timer);
    root.classList.remove('is-done');
    curveEl.setAttribute('d', ''); rateEl.setAttribute('d', '');
    for (var i = 0; i < dotEls.length; i++) dotEls[i].setAttribute('visibility', 'hidden');
    volEl.textContent = '0.00'; phEl.textContent = readings[0][1].toFixed(2);
    statusEl.textContent = 'Titrating';
    endEl.textContent = '\u2014'; concEl.textContent = '\u2014';
    replay.disabled = true;
    index = 0;
  }
  function step() {
    show(index);
    if (index >= readings.length - 1) { timer = setTimeout(finish, 350); return; }
    index++;
    // slow down through the endpoint, where the instrument dispenses the smallest amounts
    timer = setTimeout(step, Math.abs(readings[index][0] - endpoint) < 0.7 ? 135 : 72);
  }
  function play() { reset(); step(); }

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function firstRun() {
    if (started) return; started = true;
    if (reduce) { reset(); for (var i = 0; i < readings.length; i++) show(i); finish(); }
    else setTimeout(play, 600);
  }

  reset();
  replay.addEventListener('click', function () { if (!replay.disabled) play(); });

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) { io.disconnect(); firstRun(); }
    }, { threshold: 0.5 });
    io.observe(root);
  } else firstRun();
})();
