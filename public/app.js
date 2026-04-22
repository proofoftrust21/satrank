(function () {
  var API = '/api';

  function fmt(n) {
    return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
  }

  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }

  function fetchWithRetry(url, retries) {
    return fetchJSON(url).catch(function () {
      if (retries > 0) {
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(fetchWithRetry(url, retries - 1)); }, 3000);
        });
      }
      throw new Error('Failed after retries');
    });
  }

  function setStatError() {
    ['stat-endpoints', 'stat-probed', 'stat-reachable', 'stat-probes-24h'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) {
        el.textContent = 'API unavailable';
        el.classList.remove('loading');
        el.style.fontSize = '0.9rem';
      }
    });
  }

  function endpointCount(s) {
    if (s.serviceSources && typeof s.serviceSources === 'object') {
      var sum = 0;
      Object.keys(s.serviceSources).forEach(function (k) {
        var v = Number(s.serviceSources[k]);
        if (Number.isFinite(v)) sum += v;
      });
      if (sum > 0) return sum;
    }
    return Number(s.totalEndpoints) || 0;
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) {
      el.textContent = value;
      el.classList.remove('loading');
    }
  }

  function applyStats(s) {
    setText('stat-endpoints', fmt(endpointCount(s)));
    setText('stat-probed', fmt(s.nodesProbed));
    setText('stat-reachable', fmt(s.verifiedReachable));
    setText('stat-probes-24h', fmt(s.probes24h));

    var heroEndpoints = document.getElementById('hero-endpoints');
    if (heroEndpoints) heroEndpoints.textContent = endpointCount(s).toLocaleString('en-US');
    var heroNodes = document.getElementById('hero-nodes');
    if (heroNodes && typeof s.nodesProbed === 'number') heroNodes.textContent = s.nodesProbed.toLocaleString('en-US');
    var heroProbes = document.getElementById('hero-probes');
    if (heroProbes && typeof s.probes24h === 'number') heroProbes.textContent = fmt(s.probes24h);
    var heroReachable = document.getElementById('hero-reachable');
    if (heroReachable && typeof s.verifiedReachable === 'number') heroReachable.textContent = s.verifiedReachable.toLocaleString('en-US');
  }

  var boot = window.__SATRANK_BOOT__ || null;
  if (boot && boot.stats) {
    applyStats(boot.stats);
  } else {
    fetchWithRetry(API + '/stats', 1)
      .then(function (d) { applyStats(d.data); })
      .catch(setStatError);
  }

  function wireCopy(btnId, getText) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', function () {
      var text = getText();
      if (!text) return;
      navigator.clipboard.writeText(text).then(function () {
        var prev = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = prev; }, 1500);
      });
    });
  }

  function copyFromElement(id) {
    return function () {
      var el = document.getElementById(id);
      return el ? el.textContent : '';
    };
  }

  wireCopy('copy-install', function () { return 'npm install @satrank/sdk'; });
  wireCopy('copy-install-2', function () { return 'npm install @satrank/sdk'; });
  wireCopy('copy-sdk-ts', copyFromElement('sdk-ts'));
  wireCopy('copy-sdk-py', copyFromElement('sdk-py'));
  wireCopy('copy-intent-req', copyFromElement('intent-req'));
  wireCopy('copy-l402', copyFromElement('l402-req'));
  wireCopy('copy-top', copyFromElement('top-resp'));
})();
