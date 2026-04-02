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
    })
    .catch(setStatError);

  // -- Agent table rendering --
  var tbody = document.getElementById('top-agents');
  var heading = document.getElementById('agents-heading');
  var detailPanel = document.getElementById('agent-detail');

  function renderAgentRows(agents, isSearch) {
    tbody.innerHTML = '';
    if (agents.length === 0) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 5;
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

      var txCell = tr.insertCell();
      txCell.textContent = String(a.totalTransactions || 0);

      var sourceCell = tr.insertCell();
      sourceCell.className = 'mono';
      sourceCell.textContent = a.source;

      tr.addEventListener('click', function () {
        showAgentDetail(a.publicKeyHash);
      });

      tbody.appendChild(tr);
    });
  }

  // -- Load top agents --
  function loadTopAgents() {
    fetchWithRetry(API + '/agents/top?limit=10', 1)
      .then(function (d) {
        renderAgentRows(d.data, false);
      })
      .catch(function () {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ff5252">API unavailable</td></tr>';
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
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ff5252">Search failed</td></tr>';
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

    var alias = agent.alias ? escapeHtml(agent.alias) : '<span class="mono">' + escapeHtml(agent.publicKeyHash) + '</span>';

    // Max possible per component (weighted score is 0-100, each component contributes proportionally)
    // Components are raw 0-100 values
    var maxComp = 100;

    var html = '';
    html += '<div class="detail-header">';
    html += '  <div>';
    html += '    <div class="agent-name">' + alias + '</div>';
    html += '    <div class="agent-hash">' + escapeHtml(agent.publicKeyHash) + '</div>';
    html += '  </div>';
    html += '  <button class="detail-close" id="detail-close-btn">Close</button>';
    html += '</div>';

    // Big score
    html += '<div class="detail-score-big" style="color:' + scoreColor(score.total) + '">';
    html += escapeHtml(score.total);
    html += '<span class="confidence">confidence: ' + escapeHtml(score.confidence) + '</span>';
    html += '</div>';

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
