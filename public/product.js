/*
 * Product switcher (Titrator | Decay Analyzer)
 *
 * The two options are real links, so middle-click, copy-link and "open in new tab" all work. On top of that:
 *  - press and hold lifts the glass lens, drag it and it follows your finger, release and it settles on the nearest side
 *  - clicking a side slides the lens across, then opens that product's page
 *  - the lens remembers where it came from, so it finishes the slide on the new page instead of jumping
 */
(function () {
  'use strict';

  var FROM_KEY = 'analab-ps-from';
  var sw = document.querySelector('.pswitch');
  var root = document.documentElement;

  // the tiny inline script in <head> exposes where the lens was on the previous page; play the slide, then clean up
  function releaseFromState() {
    if (!root.hasAttribute('data-ps-from')) return;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { root.removeAttribute('data-ps-from'); });
    });
  }
  if (!sw) { releaseFromState(); return; }

  var opts = Array.prototype.slice.call(sw.querySelectorAll('.pswitch-opt'));
  var own = document.body.getAttribute('data-product');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function indexOfProduct(id) {
    for (var i = 0; i < opts.length; i++) if (opts[i].getAttribute('data-product') === id) return i;
    return 0;
  }
  var current = indexOfProduct(own);

  function paint(i) {
    sw.setAttribute('data-active', opts[i].getAttribute('data-product'));
    opts.forEach(function (o, k) {
      if (k === i) o.setAttribute('aria-current', 'page'); else o.removeAttribute('aria-current');
    });
  }
  function setPos(p) { sw.style.setProperty('--pos', String(p)); }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  paint(current);
  releaseFromState();

  /* ----- choosing a side ----- */
  var leaving = false;
  function choose(i) {
    if (leaving) return;
    if (i === current) { setPos(current); paint(current); return; }
    leaving = true;
    var target = opts[i];
    paint(i); setPos(i);
    try { sessionStorage.setItem(FROM_KEY, opts[current].getAttribute('data-product')); } catch (e) { /* private mode */ }
    current = i;
    var go = function () { window.location.href = target.href; };
    if (reduce) go(); else setTimeout(go, 400);
  }

  opts.forEach(function (o, i) {
    o.setAttribute('draggable', 'false');
    o.addEventListener('click', function (e) {
      if (Date.now() < suppressClickUntil) { e.preventDefault(); return; }
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button > 0) return; // let the browser open a new tab etc.
      e.preventDefault();
      choose(i);
    });
  });

  /* ----- press, drag, release ----- */
  var drag = null, suppressClickUntil = 0;

  sw.addEventListener('pointerdown', function (e) {
    if (leaving || (e.pointerType === 'mouse' && e.button !== 0)) return;
    var r = sw.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX, seg: (r.width - 8) / 2, from: current, moved: false, near: current };
    sw.classList.add('is-pressed');
  });

  window.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < 5) return;
      drag.moved = true;
      sw.classList.add('is-dragging');
    }
    var pos = clamp(drag.from + dx / drag.seg, -0.1, 1.1);   // a little give past either end
    setPos(pos);
    var near = pos > 0.5 ? 1 : 0;
    if (near !== drag.near) {
      drag.near = near;
      sw.setAttribute('data-active', opts[near].getAttribute('data-product'));
    }
    opts.forEach(function (o, k) { o.classList.toggle('hot', k === near); });
  });

  function release(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag; drag = null;
    sw.classList.remove('is-pressed', 'is-dragging');
    opts.forEach(function (o) { o.classList.remove('hot'); });
    if (d.moved) {
      suppressClickUntil = Date.now() + 60;         // the click that follows a drag must not also fire
      if (e.type === 'pointercancel') { paint(current); setPos(current); }
      else choose(d.near);
    }
  }
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);

  /* ----- coming back with the browser's Back button ----- */
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    leaving = false; current = indexOfProduct(own);
    paint(current); setPos(current);
  });
})();
