// Accordions (release notes + FAQ). Delegated so dynamically rendered notes work too.
document.addEventListener('click', function (e) {
  var btn = e.target.closest('.note button,.faq-item button');
  if (!btn) return;
  var open = btn.parentElement.classList.toggle('open');
  var mark = btn.querySelector('span');
  if (mark && /^[+−-]$/.test(mark.textContent.trim())) mark.textContent = open ? '−' : '+';
});

document.querySelectorAll('a[href^="#"]').forEach(function (a) {
  a.addEventListener('click', function (e) {
    var id = a.getAttribute('href');
    if (id && id !== '#') {
      var el = document.querySelector(id);
      if (el) { e.preventDefault(); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }
  });
});

// Live release data from the Analab server (managed in /admin).
// If the API is unreachable (e.g. static hosting), the pages keep their built-in content.
(function () {
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function parts(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  }
  var SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  function fmt(iso, month) {
    var d = parts(iso);
    return d ? d.getUTCDate() + ' ' + (month === 'long' ? LONG : SHORT)[d.getUTCMonth()] + ' ' + d.getUTCFullYear() : iso;
  }
  function size(b) {
    var mb = b / 1048576;
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : (mb >= 100 ? Math.round(mb) : mb.toFixed(1)) + ' MB';
  }
  function each(sel, fn) { document.querySelectorAll(sel).forEach(fn); }
  function list(items) { return items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join(''); }

  function apply(data) {
    var latest = data.releases.filter(function (r) { return r.isLatest; })[0];
    if (!latest) return;
    var firstV = document.querySelector('[data-v]');
    var staticVersion = firstV ? firstV.textContent.trim() : '';

    each('[data-v]', function (el) { el.textContent = latest.version; });
    each('[data-date]', function (el) { el.textContent = fmt(latest.date, 'short'); });
    each('[data-whatsnew]', function (el) { if (latest.whatsNew.length) el.innerHTML = list(latest.whatsNew); });

    if (latest.file) {
      var h = latest.file.sha256;
      each('[data-size]', function (el) { el.textContent = size(latest.file.size); });
      each('[data-sha]', function (el) { el.textContent = h ? h.slice(0, 4) + '...' + h.slice(-4) : '—'; el.title = h || ''; });
    } else if (latest.version !== staticVersion) {
      each('[data-size],[data-sha]', function (el) { el.textContent = '—'; });
    }

    each('[data-download]', function (el) {
      if (latest.downloadUrl) {
        el.setAttribute('href', latest.downloadUrl);
      } else {
        el.setAttribute('href', '#');
        el.setAttribute('aria-disabled', 'true');
        el.title = 'The installer for this version has not been uploaded yet.';
        el.style.opacity = '.5'; el.style.pointerEvents = 'none';
      }
    });

    each('[data-previous]', function (el) {
      var older = data.releases.filter(function (r) { return !r.isLatest; }).slice(0, 8);
      el.innerHTML = older.map(function (r) {
        return '<div class="release-row"><div><b>v' + esc(r.version) + '</b><br><small>' + esc(fmt(r.date, 'short')) + '</small></div>' +
          (r.downloadUrl
            ? '<a class="btn outline" style="height:38px;font-size:12px" href="' + esc(r.downloadUrl) + '">Download</a>'
            : '<small>Not available</small>') + '</div>';
      }).join('') || '<p style="color:#557397;margin:0">No earlier releases.</p>';
    });

    each('[data-notes]', function (el) {
      el.innerHTML = data.releases.map(function (r, i) {
        var body = (r.whatsNew.length ? '<b>What\'s New</b><ul>' + list(r.whatsNew) + '</ul>' : '') +
                   (r.fixes.length ? '<b>Bug Fixes</b><ul>' + list(r.fixes) + '</ul>' : '');
        return '<div class="note' + (r.isLatest ? ' open' : '') + ' reveal' + (i > 0 && i < 5 ? ' delay' + i : '') + '">' +
          '<button>Analab v' + esc(r.version) + ' — ' + esc(fmt(r.date, 'long')) + ' <span>' + (r.isLatest ? '−' : '+') + '</span></button>' +
          '<div class="body">' + (body || 'No notes for this release.') + '</div></div>';
      }).join('');
    });
  }

  if (!window.fetch) return;
  fetch('/api/releases', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok && /json/.test(r.headers.get('content-type') || '') ? r.json() : Promise.reject(); })
    .then(apply)
    .catch(function () { /* keep static content */ });
})();
