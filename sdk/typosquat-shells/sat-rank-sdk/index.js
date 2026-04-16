// Namespace placeholder. The real SatRank SDK lives at @satrank/sdk.
// This package exists to prevent typosquatting and simply redirects users.
const msg = [
  'This package is a namespace placeholder — no functionality is provided here.',
  'Install the real SatRank SDK instead:',
  '',
  '    npm install @satrank/sdk',
  '',
  'Documentation: https://satrank.dev',
].join('\n');
console.warn(msg);
module.exports = {
  __deprecated__: true,
  install: '@satrank/sdk',
  message: msg,
};
