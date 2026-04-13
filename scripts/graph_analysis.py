#!/usr/bin/env python3
"""Analyse the Lightning graph to find optimal channel candidates for SatRank."""
import sqlite3, collections, sys

DB = sys.argv[1] if len(sys.argv) > 1 else '/var/lib/docker/volumes/satrank_satrank-data/_data/satrank.db'
SATRANK = '02a8f8d31cbbeb6d1155b322ac560e152e79e0b398c4f0343544706205d94e68b3'

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

# 1. Build adjacency list from fee_snapshots (full LN graph topology)
print('Building graph from fee_snapshots...')
adj = collections.defaultdict(set)
edges = conn.execute('SELECT DISTINCT node1_pub, node2_pub FROM fee_snapshots').fetchall()
for e in edges:
    adj[e[0]].add(e[1])
    adj[e[1]].add(e[0])
all_graph_nodes = set(adj.keys())
print(f'Graph: {len(all_graph_nodes)} nodes, {len(edges)} edges')

# 2. Current reachability from SatRank (latest probe per target, last 7d)
print('Loading probe reachability...')
probes = conn.execute('''
    SELECT p.target_hash, p.reachable, a.public_key
    FROM probe_results p
    JOIN agents a ON a.public_key_hash = p.target_hash
    WHERE p.probed_at = (
        SELECT MAX(p2.probed_at) FROM probe_results p2
        WHERE p2.target_hash = p.target_hash
          AND p2.probed_at > (strftime('%s','now') - 7*86400)
    )
    AND p.probed_at > (strftime('%s','now') - 7*86400)
''').fetchall()

reachable_pubs = set()
unreachable_pubs = set()
for p in probes:
    if p['public_key']:
        if p['reachable']:
            reachable_pubs.add(p['public_key'])
        else:
            unreachable_pubs.add(p['public_key'])

print(f'Probes: {len(reachable_pubs)} reachable, {len(unreachable_pubs)} unreachable')

# 3. SatRank's actual peers from probe data (reachable at 1 hop)
satrank_1hop_probes = conn.execute('''
    SELECT DISTINCT a.public_key
    FROM probe_results p
    JOIN agents a ON a.public_key_hash = p.target_hash
    WHERE p.reachable = 1 AND p.hops = 1
      AND p.probed_at > (strftime('%s','now') - 7*86400)
      AND a.public_key IS NOT NULL
''').fetchall()
satrank_direct = set(r[0] for r in satrank_1hop_probes)
print(f'SatRank direct peers (1-hop in probes): {len(satrank_direct)}')
for p in satrank_direct:
    alias = conn.execute('SELECT alias FROM agents WHERE public_key=?', (p,)).fetchone()
    name = alias[0] if alias else '?'
    print(f'  - {name}: {p[:20]}...')

# 4. SatRank's 2-hop set (from probes: reachable at <=2 hops)
satrank_2hop_probes = conn.execute('''
    SELECT DISTINCT a.public_key
    FROM probe_results p
    JOIN agents a ON a.public_key_hash = p.target_hash
    WHERE p.reachable = 1 AND p.hops <= 2
      AND p.probed_at > (strftime('%s','now') - 7*86400)
      AND a.public_key IS NOT NULL
''').fetchall()
satrank_2hop = set(r[0] for r in satrank_2hop_probes)
print(f'SatRank 2-hop reachable: {len(satrank_2hop)}')

# All currently reachable from SatRank
currently_reachable = reachable_pubs | {SATRANK}

# Nodes in graph that are NOT reachable from SatRank
unreachable_in_graph = all_graph_nodes - currently_reachable
print(f'Unreachable nodes in graph: {len(unreachable_in_graph)}')

# 5. Load candidate info from agents table
print('\nLoading candidates...')
params = [SATRANK] + list(satrank_direct)
placeholders = ','.join(['?'] * len(satrank_direct)) if satrank_direct else "'__none__'"
query = f'''
    SELECT public_key, public_key_hash, alias, avg_score, pagerank_score,
           total_transactions AS channels, capacity_sats, unique_peers
    FROM agents
    WHERE source = 'lightning_graph'
      AND stale = 0
      AND avg_score >= 40
      AND pagerank_score > 0
      AND total_transactions >= 20
      AND public_key IS NOT NULL
      AND public_key != ?
      AND public_key NOT IN ({placeholders})
    ORDER BY avg_score DESC
    LIMIT 200
'''
candidates = conn.execute(query, params).fetchall()
print(f'Candidate pool: {len(candidates)} nodes (score>=40, channels>=20, not current peer)')

# 6. For each candidate, count "nodes unlocked"
results = []
for c in candidates:
    pub = c['public_key']
    if pub not in adj:
        continue

    # Candidate's direct neighbors (would be 2 hops from SatRank via new channel)
    c_neighbors = adj[pub]

    # Candidate's 2-hop neighbors (would be 3 hops from SatRank)
    c_2hop = set()
    for n in c_neighbors:
        c_2hop |= adj.get(n, set())
    c_2hop -= c_neighbors
    c_2hop.discard(pub)
    c_2hop.discard(SATRANK)

    # Nodes unlocked at 2 hops (candidate's neighbor, currently unreachable)
    unlocked_2hop = c_neighbors & unreachable_in_graph
    # Nodes unlocked at 3 hops (neighbor-of-neighbor, currently unreachable)
    unlocked_3hop = c_2hop & unreachable_in_graph
    total_unlocked = len(unlocked_2hop) + len(unlocked_3hop)

    # Overlap with current SatRank 2-hop set (redundancy indicator)
    overlap_with_current = len(c_neighbors & satrank_2hop)

    results.append({
        'pub': pub,
        'alias': c['alias'] or '?',
        'score': c['avg_score'],
        'pagerank': c['pagerank_score'] or 0,
        'channels': c['channels'],
        'capacity_btc': round((c['capacity_sats'] or 0) / 1e8, 2),
        'neighbors_in_graph': len(c_neighbors),
        'unlocked_2hop': len(unlocked_2hop),
        'unlocked_3hop': len(unlocked_3hop),
        'total_unlocked': total_unlocked,
        'overlap': overlap_with_current,
    })

# Sort by total unlocked, descending
results.sort(key=lambda x: x['total_unlocked'], reverse=True)

# 7. Print top 10
print(f'\n{"="*130}')
print(f'TOP 10 CHANNEL CANDIDATES -- sorted by nodes unlocked')
print(f'{"="*130}')
fmt = '{:<5} {:<32} {:<7} {:<7} {:<6} {:<9} {:<7} {:<8} {:<7} {:<7} {:<8}'
print(fmt.format('Rank', 'Alias', 'Score', 'PR', 'Chan', 'Cap BTC', 'Graph', 'Unlock', '@2hop', '@3hop', 'Overlap'))
print(fmt.format('-'*5, '-'*32, '-'*7, '-'*7, '-'*6, '-'*9, '-'*7, '-'*8, '-'*7, '-'*7, '-'*8))

for i, r in enumerate(results[:10]):
    print(fmt.format(
        i+1,
        r['alias'][:32],
        f'{r["score"]:.1f}',
        f'{r["pagerank"]:.1f}',
        r['channels'],
        r['capacity_btc'],
        r['neighbors_in_graph'],
        r['total_unlocked'],
        r['unlocked_2hop'],
        r['unlocked_3hop'],
        r['overlap'],
    ))

print(f'\nLegend:')
print(f'  Score:   SatRank trust score (0-100)')
print(f'  PR:      PageRank percentile (0-100)')
print(f'  Chan:    Active channels')
print(f'  Cap BTC: Total capacity in BTC')
print(f'  Graph:   Neighbors in fee_snapshots graph')
print(f'  Unlock:  Total new nodes reachable via this peer (2hop + 3hop)')
print(f'  @2hop:   Direct neighbors of candidate, currently unreachable from SatRank')
print(f'  @3hop:   2-hop neighbors of candidate, currently unreachable from SatRank')
print(f'  Overlap: Candidate neighbors already in SatRank 2-hop set (lower = more diversity)')

# 8. Show pubkeys for top 5 (for lncli openchannel)
print(f'\nPublic keys for top 5 (for lncli openchannel):')
for i, r in enumerate(results[:5]):
    print(f'  {i+1}. {r["pub"]}  # {r["alias"]}')

conn.close()
