// Phase 8.4 (2026-05-01) — Operator domain attestation crawler.
//
// Verifies that the DNS TXT record `_satrank-operator.<domain>` contains
// `satrank-operator-pubkey=<hex>` matching the operator's registered pubkey.
// Pure DNS lookup — no HTTPS, no LEI for v1. Uses Node's built-in DNS resolver.
//
// Embedded in evidence_receipts via EvidenceService (Phase 8.4.2 follow-up
// will add the operator_attestations row to the receipt payload — for now
// the receipt has operator_pubkey only, which any verifier can join with
// /api/operator/<pubkey>/attestations to fetch the verified domain).
import { promises as dns } from 'node:dns';
import { logger } from '../logger';
import type {
  OperatorAttestationRepository,
  OperatorAttestation,
} from '../repositories/operatorAttestationRepository';

const TXT_PREFIX = 'satrank-operator-pubkey=';
const ATTESTATION_RECHECK_TTL_SEC = 90 * 86400;

export interface OperatorAttestationServiceDeps {
  repo: OperatorAttestationRepository;
  /** Optional override for tests — must satisfy dns.resolveTxt's signature. */
  dnsResolveTxt?: (host: string) => Promise<string[][]>;
  now?: () => number;
}

export class OperatorAttestationService {
  private now: () => number;
  private dnsResolveTxt: (host: string) => Promise<string[][]>;

  constructor(private readonly deps: OperatorAttestationServiceDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.dnsResolveTxt = deps.dnsResolveTxt ?? (host => dns.resolveTxt(host));
  }

  /** Operator-side : declare a new (operator_pubkey, domain) pair. State
   *  starts `pending` ; the crawler will re-check shortly and mark verified
   *  iff the DNS TXT record is published correctly. */
  async declareDomain(operatorPubkey: string, domain: string): Promise<OperatorAttestation> {
    return this.deps.repo.createOrGet({
      operator_pubkey: operatorPubkey,
      domain,
      verification_method: 'dns_txt',
      created_at: this.now(),
    });
  }

  /** Crawler tick : pick re-checkable attestations + verify each. Used by
   *  the reconcile cron in app.ts. */
  async runVerificationCycle(): Promise<{ verified: number; failed: number }> {
    const todo = await this.deps.repo.findRecheckable(this.now());
    let verified = 0;
    let failed = 0;
    for (const a of todo) {
      const ok = await this.verifyOne(a);
      if (ok) verified += 1; else failed += 1;
    }
    if (verified + failed > 0) {
      logger.info({ verified, failed, total: todo.length }, 'OperatorAttestationService: cycle complete');
    }
    return { verified, failed };
  }

  /** Verify a single attestation. Updates the row to `verified` or `failed`. */
  async verifyOne(a: OperatorAttestation): Promise<boolean> {
    const host = `_satrank-operator.${a.domain}`;
    let records: string[][];
    try {
      records = await this.dnsResolveTxt(host);
    } catch (err) {
      logger.info(
        { domain: a.domain, error: err instanceof Error ? err.message : String(err) },
        'OperatorAttestationService: DNS lookup failed',
      );
      await this.deps.repo.markFailed(a.attestation_id, null, this.now());
      return false;
    }
    // Each TXT record is delivered as a string[] (one entry per quoted string).
    // Concatenate inner strings then prefix-check.
    const flat = records.map(parts => parts.join('')).filter(s => s.startsWith(TXT_PREFIX));
    const matched = flat.find(s => s.slice(TXT_PREFIX.length).toLowerCase() === a.operator_pubkey.toLowerCase());
    if (!matched) {
      await this.deps.repo.markFailed(a.attestation_id, flat.join(' | ').slice(0, 500), this.now());
      return false;
    }
    const nowSec = this.now();
    await this.deps.repo.markVerified(
      a.attestation_id,
      matched,
      nowSec,
      nowSec + ATTESTATION_RECHECK_TTL_SEC,
    );
    return true;
  }
}
