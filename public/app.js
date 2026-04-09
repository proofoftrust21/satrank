(function () {
  var API = '/api';

  // -- Helpers --
  function fmt(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  function scoreClass(score) {
    if (score >= 60) return 'score-high';
    if (score >= 35) return 'score-mid';
    return 'score-low';
  }

  function scoreColor(score) {
    if (score >= 60) return '#00c853';
    if (score >= 35) return '#f7931a';
    return '#ff5252';
  }

  function escapeNum(v) {
    var n = Number(v);
    return Number.isFinite(n) ? String(n) : '0';
  }

  function safeColor(c) {
    return /^#[0-9a-f]{3,6}$/i.test(c) ? c : '#888';
  }

  function deltaHtml(delta) {
    if (delta === null || delta === undefined) return '<span class="delta neutral">--</span>';
    var safe = escapeNum(delta);
    if (delta > 0) return '<span class="delta positive">+' + safe + '</span>';
    if (delta < 0) return '<span class="delta negative">' + safe + '</span>';
    return '<span class="delta neutral">0</span>';
  }

  function setStatError() {
    ['stat-probed', 'stat-phantom', 'stat-reachable', 'stat-probes-24h'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) {
        el.textContent = 'API unavailable';
        el.classList.remove('loading');
        el.style.fontSize = '0.9rem';
      }
    });
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

  function escapeHtml(val) {
    var div = document.createElement('div');
    div.textContent = String(val ?? '');
    return div.innerHTML;
  }

  function safeUrl(url) {
    try {
      var u = new URL(String(url));
      return u.protocol === 'https:' ? url : '#';
    } catch (e) { return '#'; }
  }

  // Fade-update: fade out element, change content, fade back in
  function fadeUpdate(el, newContent) {
    if (!el || el.textContent === newContent) return;
    el.classList.add('fade-out');
    setTimeout(function () {
      el.textContent = newContent;
      el.classList.remove('fade-out');
      el.classList.add('fade-in');
      setTimeout(function () { el.classList.remove('fade-in'); }, 200);
    }, 200);
  }

  // Fade-update innerHTML (for tables)
  function fadeUpdateHtml(el, newHtml) {
    if (!el) return;
    el.classList.add('fade-out');
    setTimeout(function () {
      el.innerHTML = newHtml;
      el.classList.remove('fade-out');
      el.classList.add('fade-in');
      setTimeout(function () { el.classList.remove('fade-in'); }, 200);
    }, 200);
  }

  // -- Copy buttons --
  function setupCopyBtn(btnId, codeId) {
    var btn = document.getElementById(btnId);
    if (btn) {
      btn.addEventListener('click', function () {
        var code = document.getElementById(codeId);
        if (code) {
          navigator.clipboard.writeText(code.textContent).then(function () {
            btn.textContent = 'Copied!';
            setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
          });
        }
      });
    }
  }
  setupCopyBtn('copy-decide', 'decide-curl');
  setupCopyBtn('copy-sdk', 'sdk-code');

  // -- Stats + Leaderboard in parallel --
  var totalAgentsHint = null; // active agent count, used for rank copy in detail panel
  fetchWithRetry(API + '/stats', 1)
    .then(function (d) {
      var s = d.data;
      totalAgentsHint = s.totalAgents;
      fadeUpdate(document.getElementById('stat-probed'), fmt(s.nodesProbed));
      fadeUpdate(document.getElementById('stat-phantom'), s.phantomRate + '%');
      fadeUpdate(document.getElementById('stat-reachable'), fmt(s.verifiedReachable));
      fadeUpdate(document.getElementById('stat-probes-24h'), fmt(s.probes24h));
      ['stat-probed', 'stat-phantom', 'stat-reachable', 'stat-probes-24h'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.classList.remove('loading');
      });
    })
    .catch(setStatError);

  // Leaderboard loads in parallel with stats (not sequentially)
  loadTopAgents();

  // -- Agent table rendering --
  var tbody = document.getElementById('top-agents');
  var heading = document.getElementById('agents-heading');
  var detailPanel = document.getElementById('agent-detail');

  function miniBar(value, color) {
    var pct = Math.min(100, Math.max(0, Number(value) || 0));
    return '<div class="mini-bar-track"><div class="mini-bar-fill" style="width:' + pct + '%;background:' + safeColor(color) + '"></div></div><span class="mini-bar-val">' + Math.round(pct) + '</span>';
  }

  // Track first render so the initial skeleton → data transition snaps directly
  // instead of doing a 400ms fade-out-then-fade-in on top of the API fetch.
  var firstAgentRender = true;

  function renderAgentRows(agents, isSearch) {
    if (firstAgentRender) {
      // Skeleton → data: instant replacement so the leaderboard appears as soon
      // as the API responds. Subsequent renders (e.g. search) still use the fade.
      firstAgentRender = false;
      tbody.innerHTML = '';
      renderAgentRowsInner(agents, isSearch);
      return;
    }
    // Fade out old content, replace, fade in — used for search / re-renders
    tbody.classList.add('fade-out');
    setTimeout(function () {
      tbody.innerHTML = '';
      renderAgentRowsInner(agents, isSearch);
      tbody.classList.remove('fade-out');
      tbody.classList.add('fade-in');
      setTimeout(function () { tbody.classList.remove('fade-in'); }, 200);
    }, 200);
  }

  function renderAgentRowsInner(agents, isSearch) {
    if (agents.length === 0) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 7;
      td.style.textAlign = 'center';
      td.style.color = '#555570';
      td.textContent = isSearch ? 'No agents found' : 'No agents yet';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    agents.forEach(function (a, i) {
      var tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.setAttribute('data-hash', a.publicKeyHash);
      var hash = a.publicKeyHash.slice(0, 8) + '...' + a.publicKeyHash.slice(-6);

      var rankCell = tr.insertCell();
      rankCell.textContent = a.rank ? String(a.rank) : '--';

      var aliasCell = tr.insertCell();
      if (a.alias) {
        aliasCell.textContent = a.alias;
      } else {
        var span = document.createElement('span');
        span.className = 'mono';
        span.textContent = hash;
        aliasCell.appendChild(span);
      }

      var scoreCell = tr.insertCell();
      var badge = document.createElement('span');
      badge.className = 'score-badge ' + scoreClass(a.score);
      badge.textContent = String(a.score);
      scoreCell.appendChild(badge);

      // Volume mini-bar
      var volCell = tr.insertCell();
      volCell.className = 'component-cell';
      var vol = (a.components && a.components.volume) || 0;
      volCell.innerHTML = miniBar(vol, '#f7931a');

      // Reputation mini-bar
      var repCell = tr.insertCell();
      repCell.className = 'component-cell';
      var rep = (a.components && a.components.reputation) || 0;
      repCell.innerHTML = miniBar(rep, '#00c853');

      // Delta column — use delta7d from API (enriched by backend), fallback to movers cross-ref
      var deltaCell = tr.insertCell();
      deltaCell.className = 'delta-cell';
      var d7 = a.delta7d !== undefined && a.delta7d !== null ? a.delta7d : a._delta7d;
      if (d7 !== undefined && d7 !== null) {
        deltaCell.innerHTML = deltaHtml(d7);
      } else {
        deltaCell.innerHTML = '<span class="delta neutral">--</span>';
      }

      var sourceCell = tr.insertCell();
      sourceCell.className = 'mono';
      sourceCell.textContent = a.source;

      tr.addEventListener('click', function () {
        showAgentDetail(a);
      });

      tbody.appendChild(tr);
    });
  }

  // -- Load top agents (delta7d comes from the API directly, no movers fetch needed) --
  function loadTopAgents() {
    fetchWithRetry(API + '/agents/top?limit=10', 1)
      .then(function (result) {
        renderAgentRows(result.data, false);
      })
      .catch(function () {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#ff5252">API unavailable</td></tr>';
      });
  }

  // -- Search --
  var searchInput = document.getElementById('search-input');
  var clearBtn = document.getElementById('search-clear');
  var debounceTimer = null;

  searchInput.addEventListener('input', function () {
    var query = searchInput.value.trim();
    clearBtn.style.display = query ? 'block' : 'none';

    clearTimeout(debounceTimer);

    if (!query) {
      heading.textContent = 'Leaderboard';
      loadTopAgents();
      return;
    }

    debounceTimer = setTimeout(function () {
      heading.textContent = 'Search Results';
      fetchJSON(API + '/agents/search?alias=' + encodeURIComponent(query) + '&limit=20')
        .then(function (d) {
          renderAgentRows(d.data, true);
        })
        .catch(function () {
          tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#ff5252">Search failed</td></tr>';
        });
    }, 300);
  });

  clearBtn.addEventListener('click', function () {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    heading.textContent = 'Leaderboard';
    detailPanel.classList.remove('visible');
    loadTopAgents();
  });

  // -- Agent detail (built from leaderboard/search data — no extra API call) --
  function showAgentDetail(agent) {
    detailPanel.classList.add('visible');

    var alias = agent.alias ? escapeHtml(agent.alias) : '<span class="mono">' + escapeHtml(agent.publicKeyHash.slice(0, 16) + '...') + '</span>';
    var comp = agent.components || {};
    var d7 = agent.delta7d !== undefined && agent.delta7d !== null ? agent.delta7d : agent._delta7d;

    var html = '';
    html += '<div class="detail-header">';
    html += '  <div>';
    html += '    <div class="agent-name">' + alias + '</div>';
    html += '    <div class="agent-hash">' + escapeHtml(agent.publicKeyHash) + '</div>';
    html += '  </div>';
    html += '  <button class="detail-close" id="detail-close-btn">Close</button>';
    html += '</div>';

    // Score + rank + delta
    html += '<div class="detail-score-big" style="color:' + scoreColor(agent.score) + '">';
    html += escapeHtml(agent.score);
    if (agent.rank) {
      var totalLabel = totalAgentsHint ? fmt(totalAgentsHint) + ' active agents' : 'active agents';
      html += '<span class="confidence">#' + escapeHtml(agent.rank) + ' of ' + totalLabel + '</span>';
    }
    html += '</div>';

    if (d7 !== undefined && d7 !== null) {
      html += '<div class="delta-badges">';
      html += '  <span class="delta-badge">7d: ' + deltaHtml(d7) + '</span>';
      html += '</div>';
    }

    // Component bars
    var components = ['volume', 'reputation', 'seniority', 'regularity', 'diversity'];
    html += '<div class="component-bars">';
    components.forEach(function (name) {
      var val = comp[name] || 0;
      var pct = Math.min(100, Math.round(val));
      html += '<div class="bar-row">';
      html += '  <span class="bar-label">' + name + '</span>';
      html += '  <div class="bar-track"><div class="bar-fill ' + name + '" style="width:' + pct + '%"></div></div>';
      html += '  <span class="bar-value">' + Math.round(val) + '</span>';
      html += '</div>';
    });
    html += '</div>';

    // Teaser — what the full API returns
    html += '<div class="detail-teaser">';
    html += '  <div class="teaser-title">Full API response includes</div>';
    html += '  <div class="teaser-grid">';
    html += '    <span class="teaser-item">Verdict (SAFE / RISKY / UNKNOWN)</span>';
    html += '    <span class="teaser-item">Survival score &amp; prediction</span>';
    html += '    <span class="teaser-item">Probe reachability &amp; uptime</span>';
    html += '    <span class="teaser-item">Personalized pathfinding</span>';
    html += '    <span class="teaser-item">Risk profile classification</span>';
    html += '    <span class="teaser-item">Channel flow &amp; drain rate</span>';
    html += '    <span class="teaser-item">Evidence (tx samples, LN+ ratings, mempool links)</span>';
    html += '    <span class="teaser-item">24h / 7d / 30d deltas &amp; trend</span>';
    html += '  </div>';
    html += '  <div class="teaser-cta">';
    html += '    <code>curl https://satrank.dev/api/agent/' + escapeHtml(agent.publicKeyHash) + '</code>';
    html += '  </div>';
    html += '  <div class="teaser-links">';
    html += '    <a href="/api/docs">API Explorer</a>';
    html += '    <a href="/methodology.html">Methodology</a>';
    html += '  </div>';
    html += '</div>';

    detailPanel.innerHTML = html;

    // Scroll after content is injected so the browser knows the panel's full height
    requestAnimationFrame(function () {
      detailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    var closeBtn = document.getElementById('detail-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        detailPanel.classList.remove('visible');
      });
    }
  }
})();
