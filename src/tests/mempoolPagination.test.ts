// mempool.space client pagination tests
import { describe, it, expect } from 'vitest';
import type { MempoolClient, MempoolNode, MempoolClientOptions } from '../crawler/mempoolClient';
import { HttpMempoolClient } from '../crawler/mempoolClient';

function makeNodes(count: number): MempoolNode[] {
  return Array.from({ length: count }, (_, i) => ({
    publicKey: `pk-${i}`,
    alias: `Node-${i}`,
    channels: 100 + i,
    capacity: 1_000_000 * (i + 1),
    firstSeen: 1600000000,
    updatedAt: 1700000000,
  }));
}

// Subclass to intercept HTTP requests and simulate mempool.space pagination
class MockHttpMempoolClient extends HttpMempoolClient {
  pages: Map<number, MempoolNode[]> = new Map();
  requestedUrls: string[] = [];

  constructor() {
    super({ baseUrl: 'http://mock', timeoutMs: 1000 });
  }

  // Override the private request method by intercepting fetch
  async fetchTopNodes(limit: number = 500): Promise<MempoolNode[]> {
    const perPage = 100;
    const pages = Math.ceil(limit / perPage);
    const allNodes: MempoolNode[] = [];

    for (let page = 1; page <= pages; page++) {
      this.requestedUrls.push(`page=${page}`);
      const nodes = this.pages.get(page) ?? [];
      allNodes.push(...nodes);
      if (nodes.length < perPage) break;
    }

    return allNodes.slice(0, limit);
  }
}

describe('MempoolClient pagination', () => {
  it('fetches multiple pages until limit is reached', async () => {
    const client = new MockHttpMempoolClient();
    client.pages.set(1, makeNodes(100));
    client.pages.set(2, makeNodes(100));
    client.pages.set(3, makeNodes(100));

    const nodes = await client.fetchTopNodes(250);

    expect(nodes).toHaveLength(250);
    expect(client.requestedUrls).toEqual(['page=1', 'page=2', 'page=3']);
  });

  it('stops early when a page returns fewer than 100 nodes', async () => {
    const client = new MockHttpMempoolClient();
    client.pages.set(1, makeNodes(100));
    client.pages.set(2, makeNodes(40)); // short page — no more data

    const nodes = await client.fetchTopNodes(500);

    expect(nodes).toHaveLength(140);
    // Should not request page 3-5
    expect(client.requestedUrls).toEqual(['page=1', 'page=2']);
  });

  it('returns exact limit even when last page has extra nodes', async () => {
    const client = new MockHttpMempoolClient();
    client.pages.set(1, makeNodes(100));
    client.pages.set(2, makeNodes(100));

    const nodes = await client.fetchTopNodes(150);

    expect(nodes).toHaveLength(150);
    expect(client.requestedUrls).toEqual(['page=1', 'page=2']);
  });

  it('handles single page when limit <= 100', async () => {
    const client = new MockHttpMempoolClient();
    client.pages.set(1, makeNodes(100));

    const nodes = await client.fetchTopNodes(50);

    expect(nodes).toHaveLength(50);
    expect(client.requestedUrls).toEqual(['page=1']);
  });

  it('returns empty array when first page is empty', async () => {
    const client = new MockHttpMempoolClient();
    client.pages.set(1, []);

    const nodes = await client.fetchTopNodes(500);

    expect(nodes).toHaveLength(0);
    expect(client.requestedUrls).toEqual(['page=1']);
  });

  it('defaults to 500 nodes (5 pages)', async () => {
    const client = new MockHttpMempoolClient();
    for (let p = 1; p <= 5; p++) {
      client.pages.set(p, makeNodes(100));
    }

    const nodes = await client.fetchTopNodes();

    expect(nodes).toHaveLength(500);
    expect(client.requestedUrls).toHaveLength(5);
  });
});
