// Phase 12.9 (2026-05-06) — operator replay-state service tests.
import { describe, it, expect } from 'vitest';
import { OperatorReplayStateService } from '../services/operatorReplayStateService';

const PUBKEY = 'a'.repeat(66);
const PUBKEY_2 = 'b'.repeat(66);

describe('Phase 12.9 — OperatorReplayStateService', () => {
  it('isLockedOut is false for unknown pubkey', () => {
    const svc = new OperatorReplayStateService();
    expect(svc.isLockedOut(PUBKEY)).toBe(false);
    expect(svc.isLockedOut('')).toBe(false);
  });

  it('1 replay does NOT lock out (threshold strictly > 2)', () => {
    const svc = new OperatorReplayStateService();
    svc.recordReplay(PUBKEY);
    expect(svc.isLockedOut(PUBKEY)).toBe(false);
  });

  it('2 replays still under threshold (must be > 2)', () => {
    const svc = new OperatorReplayStateService();
    svc.recordReplay(PUBKEY);
    svc.recordReplay(PUBKEY);
    expect(svc.isLockedOut(PUBKEY)).toBe(false);
  });

  it('3 replays cross threshold and lock out', () => {
    const svc = new OperatorReplayStateService();
    svc.recordReplay(PUBKEY);
    svc.recordReplay(PUBKEY);
    svc.recordReplay(PUBKEY);
    expect(svc.isLockedOut(PUBKEY)).toBe(true);
  });

  it('decay window of 5 min : after 6 min, count resets', () => {
    let now = 1_000_000;
    const svc = new OperatorReplayStateService({ nowMs: () => now });
    svc.recordReplay(PUBKEY);
    svc.recordReplay(PUBKEY);
    svc.recordReplay(PUBKEY);
    expect(svc.isLockedOut(PUBKEY)).toBe(true);
    now += 6 * 60 * 1000;
    expect(svc.isLockedOut(PUBKEY)).toBe(false);
    // First record after decay starts fresh count=1
    svc.recordReplay(PUBKEY);
    expect(svc.getState(PUBKEY)?.count).toBe(1);
  });

  it('within window count accumulates', () => {
    let now = 1_000_000;
    const svc = new OperatorReplayStateService({ nowMs: () => now });
    svc.recordReplay(PUBKEY);
    now += 60 * 1000; // +1 min
    svc.recordReplay(PUBKEY);
    now += 60 * 1000; // +1 min
    svc.recordReplay(PUBKEY);
    expect(svc.getState(PUBKEY)?.count).toBe(3);
    expect(svc.isLockedOut(PUBKEY)).toBe(true);
  });

  it('lockout per-pubkey is isolated', () => {
    const svc = new OperatorReplayStateService();
    svc.recordReplay(PUBKEY);
    svc.recordReplay(PUBKEY);
    svc.recordReplay(PUBKEY);
    expect(svc.isLockedOut(PUBKEY)).toBe(true);
    expect(svc.isLockedOut(PUBKEY_2)).toBe(false);
  });

  it('empty pubkey is no-op for record / lookup', () => {
    const svc = new OperatorReplayStateService();
    svc.recordReplay('');
    expect(svc.isLockedOut('')).toBe(false);
    expect(svc.getState('')).toBeUndefined();
  });

  it('_resetForTests clears all state', () => {
    const svc = new OperatorReplayStateService();
    svc.recordReplay(PUBKEY);
    svc.recordReplay(PUBKEY);
    svc.recordReplay(PUBKEY);
    expect(svc.isLockedOut(PUBKEY)).toBe(true);
    svc._resetForTests();
    expect(svc.isLockedOut(PUBKEY)).toBe(false);
  });
});
