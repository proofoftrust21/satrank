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

/** Audit H2 (2026-05-01) — domain validation before DNS lookup.
 *  The crawler queries `_satrank-operator.<a.domain>` ; without validation an
 *  attacker can register `localhost` (or a private-IP literal in CNAME form)
 *  to make our resolver hit internal infra, or stuff label-injection like
 *  `evil.com\n_satrank-operator.victim.com` to cross-write records. We
 *  enforce: (a) RFC 1035/3696 LDH labels, (b) ≥2 labels, (c) public TLD shape,
 *  (d) reject reserved/internal/loopback names + RFC 1918 / ULA / link-local
 *  literals, (e) total length cap. */
export class InvalidDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDomainError';
  }
}

const DOMAIN_MAX_LEN = 253;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const TLD_RE = /^[a-z]{2,63}$/i;
const RESERVED_TLDS = new Set([
  'local',
  'localhost',
  'internal',
  'intranet',
  'lan',
  'corp',
  'home',
  'private',
  'test',
  'example',
  'invalid',
  'onion',
]);
const RESERVED_DOMAINS = new Set([
  'localhost',
  'localhost.localdomain',
  'broadcasthost',
]);
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export function validateOperatorDomain(input: string): string {
  if (typeof input !== 'string') {
    throw new InvalidDomainError('domain must be a string');
  }
  const domain = input.trim().toLowerCase();
  if (domain.length === 0) {
    throw new InvalidDomainError('domain cannot be empty');
  }
  if (domain.length > DOMAIN_MAX_LEN) {
    throw new InvalidDomainError(`domain exceeds ${DOMAIN_MAX_LEN} chars`);
  }
  // Reject any whitespace / control / DNS-illegal characters before split
  // (catches CR/LF injection, tabs, NUL). LDH check on each label below would
  // also reject these but explicit guard is clearer.
  if (/[\s\x00-\x1f\x7f]/.test(domain)) {
    throw new InvalidDomainError('domain contains whitespace or control char');
  }
  // Reject brackets / colons / slashes / @ — common in URLs, IPv6 literals,
  // and userinfo injection. Only LDH + dot are valid here.
  if (/[:/@\[\]?#]/.test(domain)) {
    throw new InvalidDomainError('domain contains URL or IPv6 syntax');
  }
  if (RESERVED_DOMAINS.has(domain)) {
    throw new InvalidDomainError(`domain ${domain} is reserved`);
  }
  if (IPV4_RE.test(domain)) {
    throw new InvalidDomainError('IPv4 literals are not allowed');
  }
  const labels = domain.split('.');
  if (labels.length < 2) {
    throw new InvalidDomainError('domain must have ≥ 2 labels (sub.tld)');
  }
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      throw new InvalidDomainError(`invalid label length: "${label.slice(0, 64)}"`);
    }
    if (!LABEL_RE.test(label)) {
      throw new InvalidDomainError(`invalid label chars: "${label.slice(0, 64)}"`);
    }
  }
  const tld = labels[labels.length - 1];
  if (!TLD_RE.test(tld)) {
    throw new InvalidDomainError(`TLD must be alpha-only: "${tld}"`);
  }
  if (RESERVED_TLDS.has(tld)) {
    throw new InvalidDomainError(`reserved TLD: ".${tld}"`);
  }
  // Block RFC 1918 / 100.64/10 / link-local / loopback patterns expressed as
  // sub-labels (e.g. `10-0-0-1.attacker.com` is fine ; `10.0.0.1.attacker.com`
  // is just a domain — but `localhost.attacker.com` is suspicious yet legal,
  // so we only block when the LAST label set is reserved, handled above).
  return domain;
}

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
   *  iff the DNS TXT record is published correctly. Audit H2 — validate
   *  domain shape + reject reserved/loopback/IPv4 literal before persisting. */
  async declareDomain(operatorPubkey: string, domain: string): Promise<OperatorAttestation> {
    const safeDomain = validateOperatorDomain(domain);
    return this.deps.repo.createOrGet({
      operator_pubkey: operatorPubkey,
      domain: safeDomain,
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
