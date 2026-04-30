// NIP-98 HTTP Authorization verifier.
//
// Spec: https://github.com/nostr-protocol/nips/blob/master/98.md
// The client signs a kind 27235 Nostr event whose tags include:
//   ["u", "<absolute URL of the request>"]
//   ["method", "<HTTP method uppercase>"]
//   ["payload", "<sha256 of request body in lowercase hex>"]  (optional)
// and puts the base64-encoded event JSON into `Authorization: Nostr <b64>`.
//
// Attack vectors addressed:
// - Forged signatures: verifyEvent from @noble/secp256k1 (via nostr-tools).
// - Stale events: created_at must be within NIP98_MAX_AGE_SEC.
// - URL/method spoofing: u and method tags must match the request.
// - Body swap: when a body is present, payload tag must match sha256(rawBody).
// - Wrong kind: event.kind must equal 27235.
// - Replay: an in-process LRU caches event.id for the past 60s. A second
//   request carrying the same signed event is rejected as a replay. This
//   provides exactly-once semantics at the verifier level, on top of the
//   per-caller dedup (operator_id idempotence, report bonus dailyCap).
//   The cache is per-process (no cross-instance coordination), which is fine
//   given (1) the 60s window matches NIP98_MAX_AGE_PAST_SEC so a same event
//   can't replay past it anyway, (2) load-balancer affinity on a small fleet,
//   and (3) downstream caller-level dedup catches the residual cross-instance
//   replay surface.
import crypto, { webcrypto } from 'node:crypto';
// nostr-tools expects globalThis.crypto (WebCrypto). Node 20+ has it by
// default, older releases don't — polyfill defensively so the static import
// below cannot throw on cold init.
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
import { logger } from '../logger';
// Static ESM import of nostr-tools/pure (audit L1). Previously a dynamic
// `await import(...)` fired on every NIP-98 verify call — the module cache
// absorbed the second call onwards but the first call per cold worker
// paid a real parse cost. Static import moves the cost to boot time.
// @ts-expect-error — ESM subpath
import { verifyEvent as verifyNostrEvent } from 'nostr-tools/pure';

const NIP98_KIND = 27235;
// Past window: 60s accommodates sane clock skew + in-flight time for the client.
// Future window: 5s — only tolerate a small positive skew if the client clock
// runs slightly ahead. Previous symmetric ±60s let an attacker pre-sign
// events 60s into the future, doubling the replay window (audit M1).
const NIP98_MAX_AGE_PAST_SEC = 60;
const NIP98_MAX_AGE_FUTURE_SEC = 5;

// Audit Tier 2F (2026-04-30) — in-process replay cache. Keys are event.id,
// values are the unix-second expiry. We sweep on every miss so the map can
// never grow unbounded; size is bounded by 60s × max NIP-98 RPS (low for our
// surface, ~10 req/min/IP rate-limited).
const NIP98_REPLAY_CACHE = new Map<string, number>();
const REPLAY_TTL_SEC = NIP98_MAX_AGE_PAST_SEC + NIP98_MAX_AGE_FUTURE_SEC;

function sweepReplayCache(nowSec: number): void {
  // Remove expired entries. JavaScript Map iterates in insertion order, but
  // the inserts here can be out-of-order if events arrive with skewed
  // created_at, so we scan the whole map. Cheap because cache is small.
  for (const [id, expiresAt] of NIP98_REPLAY_CACHE) {
    if (expiresAt <= nowSec) NIP98_REPLAY_CACHE.delete(id);
  }
}

/** TEST-ONLY hook to wipe the in-process replay cache between cases. Not
 *  exposed to production callers; importing it from outside `tests/` is
 *  considered a code smell. */
export function __resetNip98ReplayCacheForTests(): void {
  NIP98_REPLAY_CACHE.clear();
}

/** Public verification result. `reason` is ALWAYS 'invalid' on failure so the
 *  verifier is not an oracle the attacker can use to iterate their forgery
 *  (audit M2). The granular code travels separately on `detail` for server
 *  logs — callers MUST NOT surface `detail` in HTTP responses. */
export interface Nip98VerifyResult {
  valid: boolean;
  pubkey: string | null;
  /** The NIP-01 event id (sha256 of the canonical serialization) of the
   *  signed Authorization envelope. Exposed for audit-log callers that need
   *  to record the exact event used to authorize a request — e.g.
   *  service_register_log. Always populated when the header parsed, even on
   *  signature-invalid results, so failed attempts can be traced too. */
  event_id: string | null;
  reason: 'invalid' | null;
  /** Diagnostic only. Keep OUT of any response body; log to stderr at warn. */
  detail?: string;
}

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Parse the Authorization header; returns the decoded event or null if the
 *  header is missing, malformed, or not a `Nostr` scheme. */
function parseHeader(authHeader: string | undefined): NostrEvent | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Nostr\s+([A-Za-z0-9+/=_-]+)$/);
  if (!match) return null;
  try {
    const base64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed === 'object' && parsed !== null &&
      'id' in parsed && 'pubkey' in parsed && 'created_at' in parsed &&
      'kind' in parsed && 'tags' in parsed && 'sig' in parsed
    ) {
      return parsed as NostrEvent;
    }
  } catch {
    // Malformed base64 or JSON — fail closed.
  }
  return null;
}

/** Return the first tag value for a given key, or null. */
function getTag(event: NostrEvent, key: string): string | null {
  const tag = event.tags.find(t => Array.isArray(t) && t[0] === key && typeof t[1] === 'string');
  return tag ? tag[1] : null;
}

/** Verify a NIP-98 authorization header against the current request.
 *
 *  @param authHeader    the raw Authorization header
 *  @param method        the HTTP method (POST / GET / etc.)
 *  @param fullUrl       the absolute URL the client hit (scheme + host + path, no query)
 *  @param rawBody       the raw request body bytes, or null when no body
 *  @returns             valid flag, the verified pubkey, and a reason on failure
 *
 *  Failure reasons are intentionally specific so operators can triage the 99%
 *  case (clock drift / wrong URL) from the 1% case (signature forgery). */
export async function verifyNip98(
  authHeader: string | undefined,
  method: string,
  fullUrl: string,
  rawBody: string | Buffer | null,
): Promise<Nip98VerifyResult> {
  // Single external failure reason to close the oracle surface (audit M2).
  // Every branch that returns false builds the granular `detail` code for
  // logging only; the public shape carries `reason: 'invalid'` uniformly.
  const fail = (
    pubkey: string | null,
    eventId: string | null,
    detail: string,
  ): Nip98VerifyResult => ({
    valid: false, pubkey, event_id: eventId, reason: 'invalid', detail,
  });

  const event = parseHeader(authHeader);
  if (!event) return fail(null, null, 'no_or_malformed_header');

  if (event.kind !== NIP98_KIND) {
    return fail(event.pubkey ?? null, event.id ?? null, 'wrong_kind');
  }

  // Asymmetric window (audit M1): allow up to 60s stale past, only 5s future.
  // The asymmetry reflects reality — clocks skew forward rarely; pre-signing
  // is the adversary's interest. Previously `Math.abs(now - created_at) > 60`
  // allowed both ±60s, doubling the replay amplitude.
  const now = Math.floor(Date.now() / 1000);
  const drift = event.created_at - now;
  if (drift > NIP98_MAX_AGE_FUTURE_SEC || drift < -NIP98_MAX_AGE_PAST_SEC) {
    return fail(event.pubkey, event.id ?? null, 'stale_or_future_event');
  }

  const uTag = getTag(event, 'u');
  if (uTag !== fullUrl) return fail(event.pubkey, event.id ?? null, 'url_mismatch');

  const methodTag = getTag(event, 'method');
  if ((methodTag ?? '').toUpperCase() !== method.toUpperCase()) {
    return fail(event.pubkey, event.id ?? null, 'method_mismatch');
  }

  // Body binding (audit C1 closure).
  // For HTTP methods that carry a body (POST/PUT/PATCH), the caller MUST
  // pass a non-null rawBody — otherwise we cannot verify the `payload` tag
  // was bound to the actual request bytes. Previously this block was skipped
  // when rawBody was null, which let one signed envelope authorize arbitrary
  // bodies within the 60s freshness window.
  const bodyCarryingMethod = ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase());
  if (bodyCarryingMethod) {
    if (rawBody === null || rawBody === undefined) {
      return fail(event.pubkey, event.id ?? null, 'rawbody_not_captured');
    }
    const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    const payloadTag = getTag(event, 'payload');
    // SHA256 of the empty string — used as the "canonical" payload hash when
    // the body is legitimately empty and the client chose to tag it.
    const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    if (bodyBuf.length === 0) {
      if (payloadTag !== null && payloadTag.toLowerCase() !== EMPTY_SHA256) {
        return fail(event.pubkey, event.id ?? null, 'payload_mismatch');
      }
    } else {
      if (payloadTag === null) return fail(event.pubkey, event.id ?? null, 'payload_missing');
      const expectedHash = crypto.createHash('sha256').update(bodyBuf).digest('hex');
      if (payloadTag.toLowerCase() !== expectedHash) {
        return fail(event.pubkey, event.id ?? null, 'payload_mismatch');
      }
    }
  }

  // Signature verification via nostr-tools. Import is static (top of file)
  // so the module is loaded once at process start, not on every call.
  try {
    const ok = verifyNostrEvent(event);
    if (!ok) return fail(event.pubkey, event.id ?? null, 'bad_signature');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, 'NIP-98 verify threw — treating as invalid');
    return fail(event.pubkey, event.id ?? null, 'verify_threw');
  }

  // Audit Tier 2F (2026-04-30) — replay protection. Check the cache AFTER
  // every other gate has passed (otherwise we'd cache failed forgeries and
  // waste memory). If the event id has been seen within the TTL window,
  // reject as replayed. Otherwise insert with an expiry = now + TTL.
  sweepReplayCache(now);
  if (NIP98_REPLAY_CACHE.has(event.id)) {
    return fail(event.pubkey, event.id, 'replayed_event');
  }
  NIP98_REPLAY_CACHE.set(event.id, now + REPLAY_TTL_SEC);

  return { valid: true, pubkey: event.pubkey, event_id: event.id, reason: null };
}
