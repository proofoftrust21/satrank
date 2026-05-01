// Phase 9.2 (2026-05-01) — Capability/session tokens for fulfill bypass.
//
// NIP-98 verification per fulfill call costs an extra round-trip + crypto
// validation. For high-frequency / low-latency agents (Sim 10 a05/a06/a07
// SLA personas), one NIP-98 ~10-50ms can saturate budgets. This service
// issues a short-lived Bearer session token after a single NIP-98
// verification ; the token authorises N subsequent fulfill calls within a
// time window without re-signing.
//
// Storage : in-memory Map (single-process). Tokens are not persisted —
// process restart invalidates all sessions, agents re-auth on first call
// with NIP-98 then resume Bearer. This is intentional v1 simplicity ;
// horizontal scale to N processes will need Redis (Phase 9.2.1).
//
// Lifecycle :
//   POST /api/fulfill/session (NIP-98) → issue { token, expires_at, max_calls }
//   subsequent /api/fulfill calls : Authorization: Bearer <token>
//   capability service decrements remaining_calls + checks expiry
//   token exhausted or expired → controller returns 401 + invites re-auth

import { randomBytes } from 'node:crypto';

const DEFAULT_TTL_SEC = 300;        // 5 min default
const DEFAULT_MAX_CALLS = 50;       // 50 calls per token default
const HARD_TTL_SEC = 1800;          // 30 min absolute cap
const HARD_MAX_CALLS = 500;         // 500 calls absolute cap

export interface CapabilityToken {
  token: string;
  agent_pubkey: string;
  issued_at: number;
  expires_at: number;
  max_calls: number;
  remaining_calls: number;
}

export interface IssueOptions {
  agent_pubkey: string;
  ttl_sec?: number;
  max_calls?: number;
  now_sec?: number;
}

export class CapabilityTokenService {
  private readonly tokens = new Map<string, CapabilityToken>();

  issue(opts: IssueOptions): CapabilityToken {
    const ttl = Math.min(opts.ttl_sec ?? DEFAULT_TTL_SEC, HARD_TTL_SEC);
    const max = Math.min(opts.max_calls ?? DEFAULT_MAX_CALLS, HARD_MAX_CALLS);
    const now = opts.now_sec ?? Math.floor(Date.now() / 1000);
    const token = randomBytes(32).toString('hex');
    const cap: CapabilityToken = {
      token,
      agent_pubkey: opts.agent_pubkey,
      issued_at: now,
      expires_at: now + ttl,
      max_calls: max,
      remaining_calls: max,
    };
    this.tokens.set(token, cap);
    return cap;
  }

  /** Atomic consume : if the token is valid AND has remaining_calls > 0
   *  AND not expired, decrement and return the token (caller can read
   *  agent_pubkey). Otherwise return null (controller treats as 401). */
  consume(token: string, nowSec?: number): CapabilityToken | null {
    const now = nowSec ?? Math.floor(Date.now() / 1000);
    const cap = this.tokens.get(token);
    if (!cap) return null;
    if (cap.expires_at <= now) {
      this.tokens.delete(token);
      return null;
    }
    if (cap.remaining_calls <= 0) {
      this.tokens.delete(token);
      return null;
    }
    cap.remaining_calls -= 1;
    if (cap.remaining_calls <= 0) {
      // Last call : token was used to its limit. Keep it for one more
      // peek if needed but mark expired-on-next-consume.
      cap.expires_at = now;  // effectively immediate expiry on next read
    }
    return { ...cap };  // return a copy so callers can't mutate live state
  }

  /** Cron : evict expired tokens. Called from app.ts reconcile loop. */
  pruneExpired(nowSec?: number): number {
    const now = nowSec ?? Math.floor(Date.now() / 1000);
    let n = 0;
    for (const [tok, cap] of this.tokens.entries()) {
      if (cap.expires_at <= now || cap.remaining_calls <= 0) {
        this.tokens.delete(tok);
        n += 1;
      }
    }
    return n;
  }

  size(): number {
    return this.tokens.size;
  }
}
