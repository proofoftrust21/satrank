// Observer Protocol types — API response format

// GET /api/v1/health response
export interface ObserverHealthResponse {
  status: string;
  version?: string;
  uptime?: number;
}

// Transaction as returned by GET /observer/trends
export interface ObserverTransaction {
  transaction_id: string;
  timestamp: number;
  payment_rail: string;
  sender_public_key_hash: string;
  receiver_public_key_hash: string;
  amount_bucket: string;
  settlement_reference: string | null;  // Lightning preimage (null if not yet settled)
  receipt_hash: string;
  signature: string;
  status: string;
}

// GET /observer/trends response
export interface ObserverTrendsResponse {
  transactions: ObserverTransaction[];
  total: number;
  page: number;
  has_more: boolean;
}

// Crawl run result
export interface CrawlResult {
  startedAt: number;
  finishedAt: number;
  transactionsFetched: number;
  newTransactions: number;
  newAgents: number;
  errors: string[];
}

// HTTP client interface — allows mock injection for tests
export interface ObserverClient {
  fetchHealth(): Promise<ObserverHealthResponse>;
  fetchTrends(page: number, limit: number): Promise<ObserverTrendsResponse>;
}
