# infra/nginx

Source of truth for the nginx config that fronts `satrank.dev` /
`api.satrank.dev` in prod.

## Files

- `satrank.conf` — the full server block, deployed to
  `/etc/nginx/sites-enabled/satrank` on the prod host.

## Why this directory exists

nginx lives outside the Docker Compose stack on the prod host (it
terminates TLS and routes to either Aperture `:8082` for L402-gated
paths or Express `:3000` for free / Phase 10 retired paths).
Historically this file was edited directly on the server and never
tracked — a redeploy from a clean nginx install would silently drop
host-side patches.

In Phase 10 we added a host-side patch to route `/api/decide` and
`/api/best-route` direct to Express so the 410 Gone handler is
reached instead of Aperture's 402 gate. The patch is committed here
as the authoritative copy; any future edit must land here first and
be pushed to the host, never the other way around.

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
