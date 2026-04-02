(function() {
  function fmt(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  function scoreClass(score) {
    if (score >= 60) return 'score-high';
    if (score >= 35) return 'score-mid';
    return 'score-low';
  }

  function setStatError() {
    ['stat-agents', 'stat-transactions', 'stat-attestations', 'stat-avg-score'].forEach(function(id) {
      var el = document.getElementById(id);
      el.textContent = 'API unavailable';
      el.classList.remove('loading');
      el.style.fontSize = '0.9rem';
    });
  }

  function fetchWithRetry(url, retries) {
    return fetch(url).then(function(r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).catch(function(err) {
      if (retries > 0) {
        return new Promise(function(resolve) {
          setTimeout(function() { resolve(fetchWithRetry(url, retries - 1)); }, 3000);
        });
      }
      throw err;
    });
  }

  fetchWithRetry('/api/v1/stats', 1)
    .then(function(d) {
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

  fetchWithRetry('/api/v1/agents/top?limit=10', 1)
    .then(function(d) {
      var tbody = document.getElementById('top-agents');
      tbody.innerHTML = '';
      d.data.forEach(function(a, i) {
        var tr = document.createElement('tr');
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
        txCell.textContent = String(a.totalTransactions);

        var sourceCell = tr.insertCell();
        sourceCell.className = 'mono';
        sourceCell.textContent = a.source;

        tbody.appendChild(tr);
      });
    })
    .catch(function() {
      var tbody = document.getElementById('top-agents');
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ff5252">API unavailable</td></tr>';
    });
})();
