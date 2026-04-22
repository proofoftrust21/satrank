import { describe, it, expect } from 'vitest';

import {
  createSafeLookup,
  isPrivateIp,
  isSafeUrl,
  isUrlBlocked,
  resolveAndPin,
  SafeLookupCb,
  SafeLookupEntry,
  SsrfBlockedError,
  fetchSafeExternal,
} from '../utils/ssrf';

// --- helpers --------------------------------------------------------------

function lookupReturning(entries: SafeLookupEntry[] | Error) {
  return (
    _hostname: string,
    _opts: { all: true; verbatim: true },
    cb: (err: NodeJS.ErrnoException | null, addresses: SafeLookupEntry[]) => void,
  ) => {
    if (entries instanceof Error) {
      cb(entries as NodeJS.ErrnoException, []);
    } else {
      cb(null, entries);
    }
  };
}

// --- isPrivateIp / isSafeUrl / isUrlBlocked -------------------------------

describe('ssrf — pure URL guards', () => {
  it('isPrivateIp flags loopback, RFC1918, CGN, link-local, IPv6', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('169.254.1.1')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });

  it('isSafeUrl blocks loopback and embedded userinfo', () => {
    expect(isSafeUrl('http://localhost/')).toBe(false);
    expect(isSafeUrl('http://127.0.0.1/')).toBe(false);
    expect(isSafeUrl('http://[::1]/')).toBe(false);
    expect(isSafeUrl('http://u:p@example.com/')).toBe(false);
    expect(isSafeUrl('ftp://example.com/')).toBe(false);
    expect(isSafeUrl('https://example.com/')).toBe(true);
  });

  it('isUrlBlocked mirrors isSafeUrl inverse', () => {
    expect(isUrlBlocked('http://127.0.0.1/')).toBe(true);
    expect(isUrlBlocked('http://[::ffff:127.0.0.1]/')).toBe(true);
    expect(isUrlBlocked('https://example.com/')).toBe(false);
    expect(isUrlBlocked('not-a-url')).toBe(true);
  });
});

// --- safeLookup (the undici Agent.connect.lookup hook) --------------------

describe('safeLookup — undici v6+ compat', () => {
  it('returns array-form when opts.all === true (autoSelectFamily path)', async () => {
    const safeLookup = createSafeLookup(
      lookupReturning([
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ]),
    );
    const result = await new Promise<{
      err: NodeJS.ErrnoException | null;
      addresses?: ReadonlyArray<SafeLookupEntry>;
    }>((resolve) => {
      safeLookup(
        'example.com',
        { all: true, family: 0 },
        ((err: NodeJS.ErrnoException | null, addresses: unknown) => {
          resolve({ err, addresses: addresses as ReadonlyArray<SafeLookupEntry> });
        }) as SafeLookupCb,
      );
    });
    expect(result.err).toBeNull();
    expect(result.addresses).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
  });

  it('returns tri-arg form when opts.all is falsy (legacy path)', async () => {
    const safeLookup = createSafeLookup(
      lookupReturning([{ address: '93.184.216.34', family: 4 }]),
    );
    const result = await new Promise<{
      err: NodeJS.ErrnoException | null;
      address: string;
      family: number;
    }>((resolve) => {
      safeLookup(
        'example.com',
        { family: 0 },
        ((err: NodeJS.ErrnoException | null, address: unknown, family: unknown) => {
          resolve({ err, address: address as string, family: family as number });
        }) as SafeLookupCb,
      );
    });
    expect(result.err).toBeNull();
    expect(result.address).toBe('93.184.216.34');
    expect(result.family).toBe(4);
  });

  it('rejects when resolved IP is private (URL_NOT_ALLOWED)', async () => {
    const safeLookup = createSafeLookup(
      lookupReturning([{ address: '10.0.0.5', family: 4 }]),
    );
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      safeLookup(
        'internal.example.com',
        { all: true },
        ((e: NodeJS.ErrnoException | null) => resolve(e)) as SafeLookupCb,
      );
    });
    expect(err).not.toBeNull();
    expect(err?.code).toBe('URL_NOT_ALLOWED');
    expect(err?.message).toMatch(/10\.0\.0\.5/);
  });

  it('rejects dual-stack when any resolved IP is private (all:true)', async () => {
    const safeLookup = createSafeLookup(
      lookupReturning([
        { address: '8.8.8.8', family: 4 },
        { address: '::1', family: 6 },
      ]),
    );
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      safeLookup(
        'mixed.example.com',
        { all: true },
        ((e: NodeJS.ErrnoException | null) => resolve(e)) as SafeLookupCb,
      );
    });
    expect(err?.code).toBe('URL_NOT_ALLOWED');
  });

  it('propagates DNS failure as empty array when opts.all', async () => {
    const dnsErr = Object.assign(new Error('DNS fail'), {
      code: 'ENOTFOUND',
    }) as NodeJS.ErrnoException;
    const safeLookup = createSafeLookup(lookupReturning(dnsErr));
    const { err, addresses } = await new Promise<{
      err: NodeJS.ErrnoException | null;
      addresses: unknown;
    }>((resolve) => {
      safeLookup(
        'does-not-exist',
        { all: true },
        ((e: NodeJS.ErrnoException | null, a: unknown) =>
          resolve({ err: e, addresses: a })) as SafeLookupCb,
      );
    });
    expect(err?.code).toBe('ENOTFOUND');
    expect(Array.isArray(addresses)).toBe(true);
    expect((addresses as unknown[]).length).toBe(0);
  });

  it('propagates DNS failure as empty values when legacy', async () => {
    const dnsErr = Object.assign(new Error('DNS fail'), {
      code: 'ENOTFOUND',
    }) as NodeJS.ErrnoException;
    const safeLookup = createSafeLookup(lookupReturning(dnsErr));
    const { err, address, family } = await new Promise<{
      err: NodeJS.ErrnoException | null;
      address: string;
      family: number;
    }>((resolve) => {
      safeLookup(
        'does-not-exist',
        { family: 0 },
        ((e: NodeJS.ErrnoException | null, a: unknown, f: unknown) =>
          resolve({
            err: e,
            address: a as string,
            family: f as number,
          })) as SafeLookupCb,
      );
    });
    expect(err?.code).toBe('ENOTFOUND');
    expect(address).toBe('');
    expect(family).toBe(0);
  });

  it('returns ENOTFOUND when DNS resolves to empty list', async () => {
    const safeLookup = createSafeLookup(lookupReturning([]));
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      safeLookup(
        'empty.example.com',
        { all: true },
        ((e: NodeJS.ErrnoException | null) => resolve(e)) as SafeLookupCb,
      );
    });
    expect(err?.code).toBe('ENOTFOUND');
  });
});

// --- resolveAndPin --------------------------------------------------------

describe('resolveAndPin', () => {
  it('returns the hostname for raw IPv4 input', async () => {
    await expect(resolveAndPin('https://8.8.8.8/')).resolves.toBe('8.8.8.8');
  });

  it('returns null for blocked URL shapes', async () => {
    await expect(resolveAndPin('http://127.0.0.1/')).resolves.toBeNull();
    await expect(resolveAndPin('http://u:p@example.com/')).resolves.toBeNull();
    await expect(resolveAndPin('ftp://example.com/')).resolves.toBeNull();
  });
});

// --- fetchSafeExternal — integration --------------------------------------

describe('fetchSafeExternal — integration', () => {
  it('throws SsrfBlockedError for literal loopback URL (static pre-check)', async () => {
    await expect(fetchSafeExternal('http://127.0.0.1/')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it('throws SsrfBlockedError for URL with userinfo', async () => {
    await expect(
      fetchSafeExternal('http://user:pw@example.com/'),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('throws SsrfBlockedError for IPv6 loopback', async () => {
    await expect(fetchSafeExternal('http://[::1]/')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });
});
