// Escape a JSON payload so it can be embedded safely inside a <script> tag.
// Covers:
//  - `</script>` and HTML-sensitive chars (XSS through node aliases, F-06 audit).
//  - U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR — both terminate JS
//    string literals in pre-ES2019 interpreters, which would break the boot
//    script (availability bug) or enable script injection on old clients.
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
