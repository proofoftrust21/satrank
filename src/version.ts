// Version information injected at build time
// The Dockerfile writes these values; in dev we use fallbacks
export const VERSION = {
  commit: process.env.GIT_COMMIT ?? 'dev',
  buildDate: process.env.BUILD_DATE ?? new Date().toISOString(),
  version: process.env.npm_package_version ?? '0.0.0',
};
