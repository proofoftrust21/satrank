// Observer Protocol types — real API response format

// GET /api/v1/health response
export interface ObserverHealthResponse {
  status: string;
  version?: string;
  uptime?: number;
}

// Event as returned by GET /observer/transactions
export interface ObserverEvent {
  event_id: string;
  event_type: string;
  protocol: string;
  transaction_hash: string;
  time_window: string;
  amount_bucket: string;
  amount_sats: number;
  direction: 'inbound' | 'outbound';
  service_description: string | null;
  preimage: string | null;
  counterparty_id: string | null;
  verified: boolean;
  created_at: string;
  agent_alias: string | null;
}

// GET /observer/transactions response
export interface ObserverTransactionsResponse {
  transactions: ObserverEvent[];
  events: ObserverEvent[];
  total: number;
}

// Crawl run result
export interface CrawlResult {
  startedAt: number;
  finishedAt: number;
  eventsFetched: number;
  newTransactions: number;
  newAgents: number;
  errors: string[];
}

// HTTP client interface — allows mock injection for tests
export interface ObserverClient {
  fetchHealth(): Promise<ObserverHealthResponse>;
  fetchTransactions(): Promise<ObserverTransactionsResponse>;
}
