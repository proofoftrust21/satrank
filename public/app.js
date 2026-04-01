(function() {
  function fmt(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  function scoreClass(score) {
    if (score >= 60) return 'score-high';
    if (score >= 35) return 'score-mid';
    return 'score-low';
  }

  fetch('/api/v1/stats')
    .then(function(r) { return r.json(); })
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
    .catch(function() {});

  fetch('/api/v1/agents/top?limit=10')
    .then(function(r) { return r.json(); })
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
    .catch(function() {});
})();
