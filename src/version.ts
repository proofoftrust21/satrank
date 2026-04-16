// Version information injected at deploy/build time.
// Source of truth is `build-info.json` at the project root, written by the
// `make deploy` target before rsync. When that file is missing (fresh clone,
// local dev), we fall back to env vars (set by the docker-compose build args)
// and then to 'dev' sentinels. The commit hash is truncated to 7 chars.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface BuildInfo {
  commit?: string;
  buildDate?: string;
  version?: string;
}

function loadBuildInfo(): BuildInfo {
  const candidates = [
    resolve(process.cwd(), 'build-info.json'),
    resolve(__dirname, '..', 'build-info.json'),
  ];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as BuildInfo;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* not present — try next candidate */ }
  }
  return {};
}

const info = loadBuildInfo();

export const VERSION = {
  commit: (info.commit ?? process.env.GIT_COMMIT ?? 'dev').slice(0, 7),
  buildDate: info.buildDate ?? process.env.BUILD_DATE ?? 'unknown',
  version: info.version ?? process.env.npm_package_version ?? '0.0.0',
};
