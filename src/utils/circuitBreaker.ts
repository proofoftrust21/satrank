// Circuit breaker for external HTTP calls (LND, Observer)
// Prevents cascading failures when a dependency is down
import { logger } from '../logger';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Name for logging */
  name: string;
  /** Consecutive failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Initial backoff in ms when circuit opens (default: 30_000) */
  initialBackoffMs?: number;
  /** Maximum backoff in ms (default: 600_000 = 10 min) */
  maxBackoffMs?: number;
}

export class CircuitBreaker {
  readonly name: string;
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private failureThreshold: number;
  private initialBackoffMs: number;
  private maxBackoffMs: number;
  private nextRetryAt = 0;
  private currentBackoffMs: number;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.initialBackoffMs = options.initialBackoffMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 600_000;
    this.currentBackoffMs = this.initialBackoffMs;
  }

  getState(): CircuitState {
    return this.state;
  }

  /** Returns true if the call should be allowed through */
  canExecute(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      if (Date.now() >= this.nextRetryAt) {
        this.state = 'half_open';
        logger.info({ breaker: this.name }, 'Circuit breaker half-open — allowing probe request');
        return true;
      }
      return false;
    }

    // half_open — allow one probe
    return true;
  }

  /** Record a successful call */
  onSuccess(): void {
    if (this.state !== 'closed') {
      logger.info({ breaker: this.name, previousState: this.state }, 'Circuit breaker closed');
    }
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this.currentBackoffMs = this.initialBackoffMs;
  }

  /** Record a failed call */
  onFailure(): void {
    this.consecutiveFailures++;

    if (this.state === 'half_open') {
      // Probe failed — re-open with increased backoff
      this.openCircuit();
      return;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openCircuit();
    }
  }

  private openCircuit(): void {
    this.state = 'open';
    this.nextRetryAt = Date.now() + this.currentBackoffMs;
    logger.warn({
      breaker: this.name,
      failures: this.consecutiveFailures,
      backoffMs: this.currentBackoffMs,
      retryAt: new Date(this.nextRetryAt).toISOString(),
    }, 'Circuit breaker opened');
    // Exponential backoff: 30s → 60s → 120s → ... → max 10min
    this.currentBackoffMs = Math.min(this.maxBackoffMs, this.currentBackoffMs * 2);
  }
}
