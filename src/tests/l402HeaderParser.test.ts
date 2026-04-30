// Tests for L402 challenge parser.
import { describe, it, expect } from 'vitest';
import { parseL402Challenge } from '../utils/l402HeaderParser';

describe('parseL402Challenge', () => {
  const MAC = 'AgEEbHNhdAJCAADDlVTDG0EDZ8vAsmJoQEfAKlwhJg8';
  const INV = 'lnbc100n1pj3abcxypp5abc';

  it('returns null for null / empty / whitespace', () => {
    expect(parseL402Challenge(null)).toBeNull();
    expect(parseL402Challenge(undefined)).toBeNull();
    expect(parseL402Challenge('')).toBeNull();
    expect(parseL402Challenge('   ')).toBeNull();
  });

  it('returns null when the scheme is not L402/LSAT', () => {
    expect(parseL402Challenge('Bearer abc')).toBeNull();
    expect(parseL402Challenge('Basic realm="foo"')).toBeNull();
    // "L402-ish" prefix should not match — \b in regex prevents partial matches
    expect(parseL402Challenge('L402Bearer macaroon="x", invoice="y"')).toBeNull();
  });

  it('parses a canonical L402 challenge (double-quoted)', () => {
    const header = `L402 macaroon="${MAC}", invoice="${INV}"`;
    const r = parseL402Challenge(header);
    expect(r).toEqual({ macaroon: MAC, invoice: INV, nostr_pubkey: null });
  });

  it('parses the LSAT legacy scheme name', () => {
    const header = `LSAT macaroon="${MAC}", invoice="${INV}"`;
    const r = parseL402Challenge(header);
    expect(r).toEqual({ macaroon: MAC, invoice: INV, nostr_pubkey: null });
  });

  it('is case-insensitive on the scheme name', () => {
    const lower = parseL402Challenge(`l402 macaroon="${MAC}", invoice="${INV}"`);
    const mixed = parseL402Challenge(`LsAt macaroon="${MAC}", invoice="${INV}"`);
    expect(lower).not.toBeNull();
    expect(mixed).not.toBeNull();
  });

  it('accepts single-quoted values', () => {
    const header = `L402 macaroon='${MAC}', invoice='${INV}'`;
    const r = parseL402Challenge(header);
    expect(r).toEqual({ macaroon: MAC, invoice: INV, nostr_pubkey: null });
  });

  it('accepts bare (unquoted) values terminated by comma', () => {
    const header = `L402 macaroon=${MAC}, invoice=${INV}`;
    const r = parseL402Challenge(header);
    expect(r).toEqual({ macaroon: MAC, invoice: INV, nostr_pubkey: null });
  });

  it('accepts bare values terminated by whitespace', () => {
    const header = `L402 macaroon=${MAC}\tinvoice=${INV}`;
    const r = parseL402Challenge(header);
    expect(r).toEqual({ macaroon: MAC, invoice: INV, nostr_pubkey: null });
  });

  it('tolerates extra whitespace between pairs', () => {
    const header = `L402  macaroon="${MAC}",   invoice="${INV}"`;
    const r = parseL402Challenge(header);
    expect(r).toEqual({ macaroon: MAC, invoice: INV, nostr_pubkey: null });
  });

  it('returns null if only macaroon is present', () => {
    expect(parseL402Challenge(`L402 macaroon="${MAC}"`)).toBeNull();
  });

  it('returns null if only invoice is present', () => {
    expect(parseL402Challenge(`L402 invoice="${INV}"`)).toBeNull();
  });

  it('picks up keys in either order', () => {
    const reversed = `L402 invoice="${INV}", macaroon="${MAC}"`;
    const r = parseL402Challenge(reversed);
    expect(r).toEqual({ macaroon: MAC, invoice: INV, nostr_pubkey: null });
  });

  it('rejects "token=" (non-standard alternative spelling) — strict by design', () => {
    const header = `L402 token="${MAC}", invoice="${INV}"`;
    expect(parseL402Challenge(header)).toBeNull();
  });

  it('preserves non-ASCII in the macaroon as-is (no re-encoding)', () => {
    // Although real base64 has no + or / issues, some servers send URL-safe
    // base64. The parser is a pass-through: the caller is responsible for
    // base64 normalization.
    const unusual = 'AgEEbHNh+t/=';
    const header = `L402 macaroon="${unusual}", invoice="${INV}"`;
    const r = parseL402Challenge(header);
    expect(r?.macaroon).toBe(unusual);
  });

  it('returns the first matching occurrence when duplicates exist', () => {
    // A malformed server sending two macaroon= keys — we take the first.
    const header = `L402 macaroon="first", invoice="${INV}", macaroon="second"`;
    const r = parseL402Challenge(header);
    expect(r?.macaroon).toBe('first');
  });

  // --- audit Tier 4N: nostr-pubkey ownership tag ---
  const VALID_NPUB = 'a'.repeat(64);

  it('Tier 4N: extracts nostr-pubkey when declared (canonical spelling)', () => {
    const header = `L402 macaroon="${MAC}", invoice="${INV}", nostr-pubkey="${VALID_NPUB}"`;
    const r = parseL402Challenge(header);
    expect(r?.nostr_pubkey).toBe(VALID_NPUB);
  });

  it('Tier 4N: accepts nostr_pubkey (underscore alias)', () => {
    const header = `L402 macaroon="${MAC}", invoice="${INV}", nostr_pubkey="${VALID_NPUB}"`;
    const r = parseL402Challenge(header);
    expect(r?.nostr_pubkey).toBe(VALID_NPUB);
  });

  it('Tier 4N: accepts x-nostr-pubkey (vendor-prefix alias)', () => {
    const header = `L402 macaroon="${MAC}", invoice="${INV}", x-nostr-pubkey="${VALID_NPUB}"`;
    const r = parseL402Challenge(header);
    expect(r?.nostr_pubkey).toBe(VALID_NPUB);
  });

  it('Tier 4N: rejects malformed nostr-pubkey values (not strict 64 hex)', () => {
    // Too short
    const r1 = parseL402Challenge(`L402 macaroon="${MAC}", invoice="${INV}", nostr-pubkey="abc123"`);
    expect(r1?.nostr_pubkey).toBeNull();
    // Uppercase hex
    const r2 = parseL402Challenge(`L402 macaroon="${MAC}", invoice="${INV}", nostr-pubkey="${'A'.repeat(64)}"`);
    expect(r2?.nostr_pubkey).toBeNull();
    // npub bech32 form (not accepted; operators must normalize to hex)
    const r3 = parseL402Challenge(`L402 macaroon="${MAC}", invoice="${INV}", nostr-pubkey="npub1${'a'.repeat(58)}"`);
    expect(r3?.nostr_pubkey).toBeNull();
  });

  it('Tier 4N: nostr_pubkey null when tag absent', () => {
    const header = `L402 macaroon="${MAC}", invoice="${INV}"`;
    const r = parseL402Challenge(header);
    expect(r?.nostr_pubkey).toBeNull();
  });
});
