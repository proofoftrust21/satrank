# infra/nginx

Source of truth for the nginx config that fronts `satrank.dev` /
`api.satrank.dev` in prod.

## Files

- `satrank.conf` — the full server block, deployed to
  `/etc/nginx/sites-enabled/satrank` on the prod host.

## Why this directory exists

nginx lives outside the Docker Compose stack on the prod host
(it terminates TLS and routes to Express `:3000`). The L402 gate is
native Express (see `src/middleware/l402Native.ts`); nginx is just a
reverse proxy. Historically this file was edited directly on the
server and never tracked — a redeploy from a clean nginx install
would silently drop host-side patches.

## Deploy

```bash
scp infra/nginx/satrank.conf root@<host>:/etc/nginx/sites-enabled/satrank
ssh root@<host> 'nginx -t && systemctl reload nginx'
```

`nginx -t` validates the config; only reload after it returns ok.

## Drift check

If you suspect prod has drifted from this file:

```bash
ssh root@<host> 'cat /etc/nginx/sites-enabled/satrank' | diff - infra/nginx/satrank.conf
```

A non-empty diff means either the host was hand-edited (fold the
change back here) or this file advanced (redeploy). Either way, the
two must converge before the next change goes out.
