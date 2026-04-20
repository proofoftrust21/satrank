import { describe, it, expect } from 'vitest';
import { safeJsonForScript } from '../utils/safeJsonForScript';

describe('safeJsonForScript', () => {
  it('escapes </script> via the < and > replacements', () => {
    const out = safeJsonForScript({ alias: '</script><script>alert(1)//' });
    expect(out).not.toContain('</script>');
    expect(out).toContain('\\u003c/script\\u003e');
  });

  it('escapes & so "&amp;" cannot slip through an HTML parser', () => {
    expect(safeJsonForScript({ q: 'a&b' })).toBe('{"q":"a\\u0026b"}');
  });

  it('escapes U+2028 LINE SEPARATOR — F-06 audit fix', () => {
    const out = safeJsonForScript({ alias: 'hello\u2028world' });
    expect(out).not.toContain('\u2028');
    expect(out).toContain('\\u2028');
  });

  it('escapes U+2029 PARAGRAPH SEPARATOR — F-06 audit fix', () => {
    const out = safeJsonForScript({ alias: 'hello\u2029world' });
    expect(out).not.toContain('\u2029');
    expect(out).toContain('\\u2029');
  });

  it('escapes both separators in the same payload', () => {
    const payload = { a: '\u2028', b: '\u2029' };
    const out = safeJsonForScript(payload);
    expect(out).not.toMatch(/[\u2028\u2029]/);
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
  });

  it('round-trips via JSON.parse without data loss', () => {
    const payload = { msg: 'line1\u2028line2\u2029end', tag: '<b>&' };
    expect(JSON.parse(safeJsonForScript(payload))).toEqual(payload);
  });
});
