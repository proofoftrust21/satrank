// Circuit breaker tests
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../utils/circuitBreaker';

describe('CircuitBreaker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts in closed state and allows execution', () => {
    const cb = new CircuitBreaker({ name: 'test' });
    expect(cb.getState()).toBe('closed');
    expect(cb.canExecute()).toBe(true);
  });

  it('stays closed below failure threshold', () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 5 });
    for (let i = 0; i < 4; i++) cb.onFailure();
    expect(cb.getState()).toBe('closed');
    expect(cb.canExecute()).toBe(true);
  });

  it('opens after reaching failure threshold', () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.canExecute()).toBe(false);
  });

  it('transitions to half_open after backoff period', () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 2, initialBackoffMs: 1000 });
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.canExecute()).toBe(false);

    // Advance past backoff
    vi.advanceTimersByTime(1001);
    expect(cb.canExecute()).toBe(true);
    expect(cb.getState()).toBe('half_open');
  });

  it('closes after recoveryThreshold consecutive successes in half_open', () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 2, recoveryThreshold: 3, initialBackoffMs: 1000 });
    cb.onFailure();
    cb.onFailure();
    vi.advanceTimersByTime(1001);
    cb.canExecute(); // triggers half_open

    cb.onSuccess();
    expect(cb.getState()).toBe('half_open'); // not yet — needs 3

    cb.onSuccess();
    expect(cb.getState()).toBe('half_open'); // still needs 1 more

    cb.onSuccess();
    expect(cb.getState()).toBe('closed'); // 3 consecutive successes → closed
    expect(cb.canExecute()).toBe(true);
  });

  it('re-opens with doubled backoff on failed probe', () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 2, initialBackoffMs: 1000 });
    cb.onFailure();
    cb.onFailure();

    // First probe fails
    vi.advanceTimersByTime(1001);
    cb.canExecute();
    cb.onFailure();
    expect(cb.getState()).toBe('open');

    // Should require 2000ms now (doubled backoff)
    vi.advanceTimersByTime(1001);
    expect(cb.canExecute()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(cb.canExecute()).toBe(true);
  });

  it('caps backoff at maxBackoffMs', () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, initialBackoffMs: 1000, maxBackoffMs: 3000 });

    // Open → probe fail → open (2000ms) → probe fail → open (3000ms capped) → probe fail → still 3000ms
    cb.onFailure();
    vi.advanceTimersByTime(1001);
    cb.canExecute();
    cb.onFailure();
    vi.advanceTimersByTime(2001);
    cb.canExecute();
    cb.onFailure();

    // Backoff should be capped at 3000
    vi.advanceTimersByTime(2001);
    expect(cb.canExecute()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(cb.canExecute()).toBe(true);
  });

  it('resets failure count and backoff on success', () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, initialBackoffMs: 1000 });
    cb.onFailure();
    cb.onFailure();
    cb.onSuccess(); // resets
    cb.onFailure();
    cb.onFailure();
    // Should still be closed — only 2 consecutive since reset
    expect(cb.getState()).toBe('closed');
  });
});
