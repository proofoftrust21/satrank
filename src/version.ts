// Version information injected at build time
// The Dockerfile writes these values; in dev we use fallbacks
// Note: the commit hash is truncated to 7 chars in the public response
// (enough for humans, not enough to reliably target specific commits).
export const VERSION = {
  commit: (process.env.GIT_COMMIT ?? 'dev').slice(0, 7),
  buildDate: process.env.BUILD_DATE ?? 'unknown',
  version: process.env.npm_package_version ?? '0.0.0',
};
