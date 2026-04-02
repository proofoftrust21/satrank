(function () {
  var API = '/api/v1';

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
    ['stat-agents', 'stat-transactions', 'stat-attestations', 'stat-avg-score'].forEach(function (id) {
      var el = document.getElementById(id);
      el.textContent = 'API unavailable';
      el.classList.remove('loading');
      el.style.fontSize = '0.9rem';
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

  // -- Stats --
  fetchWithRetry(API + '/stats', 1)
    .then(function (d) {
      var s = d.data;
      document.getElementById('stat-agents').textContent = fmt(s.totalAgents);
      document.getElementById('stat-agents').classList.remove('loading');
      document.getElementById('stat-transactions').textContent = fmt(s.totalTransactions);
      document.getElementById('stat-transactions').classList.remove('loading');
      document.getElementById('stat-attestations').textContent = fmt(s.totalAttestations);
      document.getElementById('stat-attestations').classList.remove('loading');
      document.getElementById('stat-avg-score').textContent = s.avgScore;
      document.getElementById('stat-avg-score').classList.remove('loading');

      // Network trend delta
      if (s.trends && s.trends.avgScoreDelta7d !== 0) {
        var deltaEl = document.getElementById('stat-avg-delta');
        if (deltaEl) {
          var val = s.trends.avgScoreDelta7d;
          deltaEl.innerHTML = deltaHtml(val) + ' <span class="delta-period">7d</span>';
        }
      }
    })
    .catch(setStatError);

  // -- Top Movers --
  fetchWithRetry(API + '/agents/movers', 1)
    .then(function (d) {
      renderMovers('movers-up', d.data.up, true);
      renderMovers('movers-down', d.data.down, false);
    })
    .catch(function () {
      document.getElementById('movers-up').innerHTML = '<div style="color:#555570">No data yet</div>';
      document.getElementById('movers-down').innerHTML = '<div style="color:#555570">No data yet</div>';
    });

  function renderMovers(containerId, movers, isUp) {
    var container = document.getElementById(containerId);
    if (!movers || movers.length === 0) {
      container.innerHTML = '<div style="color:#555570">No movers yet</div>';
      return;
    }
    var html = '';
    movers.forEach(function (m) {
      var name = m.alias ? escapeHtml(m.alias) : escapeHtml(m.publicKeyHash.slice(0, 10) + '...');
      var deltaClass = isUp ? 'positive' : 'negative';
      var deltaSign = isUp ? '+' : '';
      html += '<div class="mover-item">';
      html += '  <span class="mover-name">' + name + '</span>';
      html += '  <span class="mover-score">' + escapeHtml(m.score) + '</span>';
      html += '  <span class="delta ' + deltaClass + '">' + deltaSign + escapeHtml(m.delta7d) + '</span>';
      html += '</div>';
    });
    container.innerHTML = html;
  }

  // -- Agent table rendering --
  var tbody = document.getElementById('top-agents');
  var heading = document.getElementById('agents-heading');
  var detailPanel = document.getElementById('agent-detail');

  function miniBar(value, color) {
    var pct = Math.min(100, Math.max(0, Number(value) || 0));
    return '<div class="mini-bar-track"><div class="mini-bar-fill" style="width:' + pct + '%;background:' + safeColor(color) + '"></div></div><span class="mini-bar-val">' + Math.round(pct) + '</span>';
  }

  function renderAgentRows(agents, isSearch) {
    tbody.innerHTML = '';
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
      rankCell.textContent = String(i + 1);

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

      // Delta column
      var deltaCell = tr.insertCell();
      deltaCell.className = 'delta-cell';
      if (a._delta7d !== undefined && a._delta7d !== null) {
        deltaCell.innerHTML = deltaHtml(a._delta7d);
      } else {
        deltaCell.innerHTML = '<span class="delta neutral">--</span>';
      }

      var sourceCell = tr.insertCell();
      sourceCell.className = 'mono';
      sourceCell.textContent = a.source;

      tr.addEventListener('click', function () {
        showAgentDetail(a.publicKeyHash);
      });

      tbody.appendChild(tr);
    });
  }

  // -- Load top agents with delta enrichment --
  function loadTopAgents() {
    Promise.all([
      fetchWithRetry(API + '/agents/top?limit=10', 1),
      fetchWithRetry(API + '/agents/movers', 1).catch(function () { return { data: { up: [], down: [] } }; }),
    ]).then(function (results) {
      var agents = results[0].data;
      var movers = results[1].data;

      // Build delta lookup from movers
      var deltaMap = {};
      (movers.up || []).forEach(function (m) { deltaMap[m.publicKeyHash] = m.delta7d; });
      (movers.down || []).forEach(function (m) { deltaMap[m.publicKeyHash] = m.delta7d; });

      // Enrich agents with delta
      agents.forEach(function (a) {
        if (deltaMap[a.publicKeyHash] !== undefined) {
          a._delta7d = deltaMap[a.publicKeyHash];
        }
      });

      renderAgentRows(agents, false);
    }).catch(function () {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#ff5252">API unavailable</td></tr>';
    });
  }

  loadTopAgents();

  // -- Search --
  var searchInput = document.getElementById('search-input');
  var clearBtn = document.getElementById('search-clear');
  var debounceTimer = null;

  searchInput.addEventListener('input', function () {
    var query = searchInput.value.trim();
    clearBtn.style.display = query ? 'block' : 'none';

    clearTimeout(debounceTimer);

    if (!query) {
      heading.textContent = 'Top Agents';
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
    heading.textContent = 'Top Agents';
    detailPanel.classList.remove('visible');
    loadTopAgents();
  });

  // -- Agent detail --
  function showAgentDetail(hash) {
    detailPanel.classList.add('visible');
    detailPanel.innerHTML = '<div class="detail-loading">Loading agent details...</div>';
    detailPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    fetchJSON(API + '/agent/' + encodeURIComponent(hash))
      .then(function (d) {
        try {
          renderDetail(d.data);
        } catch (e) {
          detailPanel.innerHTML =
            '<div class="detail-loading" style="color:#ff5252">Failed to render agent details</div>';
        }
      })
      .catch(function (err) {
        var code = err.message;
        if (code === '402') {
          detailPanel.innerHTML =
            '<div class="detail-loading">This endpoint requires L402 payment (1 sat). Use the SDK or curl with an L402 token.</div>';
        } else {
          detailPanel.innerHTML =
            '<div class="detail-loading" style="color:#ff5252">Failed to load agent details</div>';
        }
      });
  }

  function renderDetail(r) {
    var agent = r.agent;
    var score = r.score;
    var comp = score.components;
    var ev = r.evidence;
    var delta = r.delta;
    var alerts = r.alerts;

    var alias = agent.alias ? escapeHtml(agent.alias) : '<span class="mono">' + escapeHtml(agent.publicKeyHash) + '</span>';

    var maxComp = 100;

    var html = '';
    html += '<div class="detail-header">';
    html += '  <div>';
    html += '    <div class="agent-name">' + alias + '</div>';
    html += '    <div class="agent-hash">' + escapeHtml(agent.publicKeyHash) + '</div>';
    html += '  </div>';
    html += '  <button class="detail-close" id="detail-close-btn">Close</button>';
    html += '</div>';

    // Big score with deltas
    html += '<div class="detail-score-big" style="color:' + scoreColor(score.total) + '">';
    html += escapeHtml(score.total);
    html += '<span class="confidence">confidence: ' + escapeHtml(score.confidence) + '</span>';
    html += '</div>';

    // Delta badges
    if (delta) {
      html += '<div class="delta-badges">';
      html += '  <span class="delta-badge">24h: ' + deltaHtml(delta.delta24h) + '</span>';
      html += '  <span class="delta-badge">7d: ' + deltaHtml(delta.delta7d) + '</span>';
      html += '  <span class="delta-badge">30d: ' + deltaHtml(delta.delta30d) + '</span>';
      html += '  <span class="trend-badge trend-' + escapeHtml(delta.trend) + '">' + escapeHtml(delta.trend) + '</span>';
      html += '</div>';
    }

    // Alerts
    if (alerts && alerts.length > 0) {
      html += '<div class="alerts-section">';
      alerts.forEach(function (alert) {
        html += '<div class="alert alert-' + escapeHtml(alert.severity) + '">';
        html += escapeHtml(alert.message);
        html += '</div>';
      });
      html += '</div>';
    }

    // Component bars
    var components = ['volume', 'reputation', 'seniority', 'regularity', 'diversity'];
    html += '<div class="component-bars">';
    components.forEach(function (name) {
      var val = comp[name] || 0;
      var pct = Math.min(100, Math.round((val / maxComp) * 100));
      html += '<div class="bar-row">';
      html += '  <span class="bar-label">' + name + '</span>';
      html += '  <div class="bar-track"><div class="bar-fill ' + name + '" style="width:' + pct + '%"></div></div>';
      html += '  <span class="bar-value">' + Math.round(val) + '</span>';
      html += '</div>';
    });
    html += '</div>';

    // Evidence
    html += '<div class="evidence-section"><h3>Evidence</h3><div class="evidence-grid">';

    // Transactions
    html += '<div class="evidence-item">';
    html += '  <div class="ev-label">Transactions</div>';
    html += '  <div class="ev-value">' + escapeHtml(ev.transactions.count) + ' total, ' + escapeHtml(ev.transactions.verifiedCount) + ' verified</div>';
    html += '</div>';

    // Lightning graph
    if (ev.lightningGraph) {
      var lg = ev.lightningGraph;
      html += '<div class="evidence-item">';
      html += '  <div class="ev-label">Public Key</div>';
      html += '  <div class="ev-value mono" style="font-size:0.8rem;word-break:break-all">' + escapeHtml(lg.publicKey) + '</div>';
      html += '  <a href="' + safeUrl(lg.sourceUrl) + '" target="_blank" rel="noopener">View on mempool.space</a>';
      html += '</div>';

      html += '<div class="evidence-item">';
      html += '  <div class="ev-label">Capacity</div>';
      html += '  <div class="ev-value">' + escapeHtml(fmt(lg.capacitySats)) + ' sats (' + escapeHtml(lg.channels) + ' channels)</div>';
      html += '</div>';
    }

    // Reputation
    if (ev.reputation) {
      var rep = ev.reputation;
      html += '<div class="evidence-item">';
      html += '  <div class="ev-label">LN+ Ratings</div>';
      html += '  <div class="ev-value">+' + escapeHtml(rep.positiveRatings) + ' / -' + escapeHtml(rep.negativeRatings) + '</div>';
      html += '  <a href="' + safeUrl(rep.sourceUrl) + '" target="_blank" rel="noopener">View on LN+</a>';
      html += '</div>';

      html += '<div class="evidence-item">';
      html += '  <div class="ev-label">Centrality Ranks</div>';
      html += '  <div class="ev-value">LN+ #' + escapeHtml(rep.lnplusRank) + ' &middot; Hubness #' + escapeHtml(rep.hubnessRank) + ' &middot; Betweenness #' + escapeHtml(rep.betweennessRank) + '</div>';
      html += '</div>';
    }

    // Popularity
    html += '<div class="evidence-item">';
    html += '  <div class="ev-label">Popularity</div>';
    html += '  <div class="ev-value">' + escapeHtml(ev.popularity.queryCount) + ' queries (bonus: +' + escapeHtml(ev.popularity.bonusApplied) + ')</div>';
    html += '</div>';

    html += '</div></div>';

    detailPanel.innerHTML = html;

    var closeBtn = document.getElementById('detail-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        detailPanel.classList.remove('visible');
      });
    }
  }
})();
