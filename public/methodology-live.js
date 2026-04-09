/*
 * methodology-live.js — live NIP-85 circuit check, renders directly on
 * public/methodology.html without any build step or external dependency.
 *
 * What it does:
 *   1. Opens a WebSocket to each of the 3 canonical Nostr relays
 *      (damus.io, nos.lol, primal.net).
 *   2. Sends REQ frames for kind 0, kind 30382 and kind 10040 authored by
 *      SatRank's service pubkey.
 *   3. Aggregates the events per kind across relays (deduped by event id),
 *      renders counts and the first sample event into the live-circuit grid.
 *   4. Exits when all 3 relays have sent EOSE or when the 8s watchdog fires.
 *
 * No framework, no transpile — pure ES5 + WebSocket + JSON for maximum
 * compatibility with every browser the jury might use to visit the page.
 */
(function () {
  'use strict';

  var SATRANK_PUBKEY =
    '5d11d46de1ba4d3295a33658df12eebb5384d6d6679f05b65fec3c86707de7d4';
  var RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
  ];
  var KINDS = [0, 30382, 10040];
  var WATCHDOG_MS = 8000;

  var statusEl = document.getElementById('live-circuit-status');
  var refreshBtn = document.getElementById('live-circuit-refresh');

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function shortId(id) {
    if (!id) return '';
    return String(id).slice(0, 16) + '\u2026';
  }

  function fmtDate(unixSec) {
    if (!unixSec) return '';
    try {
      return new Date(unixSec * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    } catch (e) {
      return '';
    }
  }

  function summarizeKind0(ev) {
    try {
      var profile = JSON.parse(ev.content || '{}');
      var name = profile.name || profile.display_name || '(unnamed)';
      var nip05 = profile.nip05 ? ' · nip05=' + profile.nip05 : '';
      return 'name=' + name + nip05;
    } catch (e) {
      return '(invalid JSON content)';
    }
  }

  function summarizeKind30382(ev) {
    var d = '';
    var rank = '';
    var verdict = '';
    var alias = '';
    if (ev && Array.isArray(ev.tags)) {
      for (var i = 0; i < ev.tags.length; i++) {
        var t = ev.tags[i];
        if (!Array.isArray(t) || t.length < 2) continue;
        if (t[0] === 'd') d = t[1];
        if (t[0] === 'rank') rank = t[1];
        if (t[0] === 'verdict') verdict = t[1];
        if (t[0] === 'alias') alias = t[1];
      }
    }
    return (
      'd=' + (d ? d.slice(0, 16) + '\u2026' : '?') +
      ' rank=' + (rank || '?') +
      ' verdict=' + (verdict || '?') +
      (alias ? ' alias=' + alias : '')
    );
  }

  function summarizeKind10040(ev) {
    if (!ev || !Array.isArray(ev.tags)) return '(no tags)';
    var rows = [];
    for (var i = 0; i < ev.tags.length; i++) {
      var t = ev.tags[i];
      if (Array.isArray(t) && typeof t[0] === 'string' && t[0].indexOf('30382:') === 0) {
        var providerShort = t[1] ? t[1].slice(0, 8) + '\u2026' : '?';
        var relay = t[2] || '?';
        rows.push(t[0] + ' → ' + providerShort + ' @ ' + relay.replace('wss://', ''));
      }
    }
    return rows.length ? rows.join(' | ') : '(no 30382 rows)';
  }

  function summarizeEvent(kind, ev) {
    if (kind === 0) return summarizeKind0(ev);
    if (kind === 30382) return summarizeKind30382(ev);
    if (kind === 10040) return summarizeKind10040(ev);
    return '';
  }

  function renderKindResult(kind, events) {
    var countEl = document.getElementById('live-kind-' + kind + '-count');
    var sampleEl = document.getElementById('live-kind-' + kind + '-sample');
    if (countEl) countEl.textContent = String(events.length);
    if (!sampleEl) return;
    sampleEl.innerHTML = '';
    if (events.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'live-circuit-empty';
      if (kind === 10040) {
        empty.textContent =
          'no self-declaration on any relay yet — run scripts/nostr-publish-10040.ts from the repo to populate';
      } else if (kind === 30382) {
        empty.textContent =
          'no trusted assertions found — the publisher may be mid-cycle; reload in a few seconds';
      } else {
        empty.textContent = 'no profile event — the kind 0 script may not have been run';
      }
      sampleEl.appendChild(empty);
      return;
    }
    // Show the most recent event (highest created_at)
    events.sort(function (a, b) {
      return (b.created_at || 0) - (a.created_at || 0);
    });
    var latest = events[0];
    var idLine = document.createElement('div');
    idLine.className = 'live-circuit-event-id';
    idLine.textContent = 'id ' + shortId(latest.id) + ' · ' + fmtDate(latest.created_at);
    sampleEl.appendChild(idLine);

    var dataLine = document.createElement('div');
    dataLine.className = 'live-circuit-event-data';
    dataLine.textContent = summarizeEvent(kind, latest);
    sampleEl.appendChild(dataLine);

    if (events.length > 1) {
      var more = document.createElement('div');
      more.className = 'live-circuit-event-more';
      more.textContent = '+' + (events.length - 1) + ' more across relays';
      sampleEl.appendChild(more);
    }
  }

  function queryRelay(url, collector) {
    return new Promise(function (resolve) {
      var ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        resolve({ url: url, ok: false, error: 'constructor: ' + (e && e.message) });
        return;
      }

      var subIds = KINDS.map(function (k) {
        return 'satrank-' + k + '-' + Math.random().toString(36).slice(2, 8);
      });
      var eoseReceived = {};
      var settled = false;
      var watchdog = null;

      function finish(error) {
        if (settled) return;
        settled = true;
        if (watchdog) clearTimeout(watchdog);
        try {
          ws.close();
        } catch (e) { /* ignore */ }
        resolve({ url: url, ok: !error, error: error || null });
      }

      ws.onopen = function () {
        for (var i = 0; i < KINDS.length; i++) {
          try {
            ws.send(
              JSON.stringify([
                'REQ',
                subIds[i],
                { kinds: [KINDS[i]], authors: [SATRANK_PUBKEY], limit: 3 },
              ]),
            );
          } catch (e) { /* ignore */ }
        }
        watchdog = setTimeout(function () { finish('watchdog'); }, WATCHDOG_MS);
      };

      ws.onerror = function () { finish('error'); };
      ws.onclose = function () { finish(null); };

      ws.onmessage = function (msg) {
        var data;
        try { data = JSON.parse(msg.data); } catch (e) { return; }
        if (!Array.isArray(data) || data.length < 2) return;
        var type = data[0];
        if (type === 'EVENT' && data.length >= 3) {
          var ev = data[2];
          if (!ev || typeof ev.kind !== 'number') return;
          collector(ev);
        } else if (type === 'EOSE' && data.length >= 2) {
          eoseReceived[data[1]] = true;
          var done = true;
          for (var j = 0; j < subIds.length; j++) {
            if (!eoseReceived[subIds[j]]) { done = false; break; }
          }
          if (done) finish(null);
        } else if (type === 'NOTICE') {
          // relays sometimes send NOTICE and close; let the watchdog handle it
        }
      };
    });
  }

  function run() {
    setStatus('querying ' + RELAYS.length + ' relays...');
    for (var i = 0; i < KINDS.length; i++) {
      var countEl = document.getElementById('live-kind-' + KINDS[i] + '-count');
      var sampleEl = document.getElementById('live-kind-' + KINDS[i] + '-sample');
      if (countEl) countEl.textContent = '\u2026';
      if (sampleEl) sampleEl.innerHTML = '';
    }

    var seenIds = {};
    var eventsByKind = { 0: [], 30382: [], 10040: [] };

    function collect(ev) {
      if (!ev || seenIds[ev.id]) return;
      seenIds[ev.id] = true;
      if (eventsByKind[ev.kind]) eventsByKind[ev.kind].push(ev);
    }

    var queries = RELAYS.map(function (url) { return queryRelay(url, collect); });
    Promise.all(queries).then(function (results) {
      var ok = results.filter(function (r) { return r.ok; }).length;
      setStatus(ok + ' / ' + RELAYS.length + ' relays responded · ' +
        new Date().toISOString().replace('T', ' ').slice(11, 19) + ' UTC');
      for (var i = 0; i < KINDS.length; i++) {
        renderKindResult(KINDS[i], eventsByKind[KINDS[i]]);
      }
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () { run(); });
  }

  if (typeof WebSocket === 'undefined') {
    setStatus('WebSocket unavailable in this browser');
    return;
  }

  run();
})();
