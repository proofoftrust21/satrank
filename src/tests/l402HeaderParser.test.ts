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
    expect(r).toEqual({ macaroon: MAC, invoice: INV });
  });

  it('parses the LSAT legacy scheme name', () => {
    const header = `LSAT macaroon="${MAC}", invoice="${INV}"`;
    const r = parseL402Challenge(header);
    expect(r).toEqual({ macaroon: MAC, invoice: INV });
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
    expect(r).toEqual({ macaroon: MAC, invoice: INV });
  });

  it('accepts bare (unquoted) values terminated by comma', () => {
    const header = `L402 macaroon=${MAC}, invoice=${INV}`;
    const r = parseL402Challenge(header);
    expect(r).toEqual({ macaroon: MAC, invoice: INV });
  });

  it('accepts bare values terminated by whitespace', () => {
    const header = `L402 macaroon=${MAC}\tinvoice=${INV}`;
    const r = parseL402Challenge(header);
    expect(r).toEqual({ macaroon: MAC, invoice: INV });
  });

  it('tolerates extra whitespace between pairs', () => {
    const header = `L402  macaroon="${MAC}",   invoice="${INV}"`;
    const r = parseL402Challenge(header);
    expect(r).toEqual({ macaroon: MAC, invoice: INV });
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
    expect(r).toEqual({ macaroon: MAC, invoice: INV });
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
});
