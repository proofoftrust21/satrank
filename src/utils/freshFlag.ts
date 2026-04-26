// Pricing Mix A+D — single source of truth for the `?fresh=true` flag.
//
// The flag may travel as a query string (`?fresh=true`) or in the JSON body
// (`{ "fresh": true }`). Both spellings are accepted so the SDK can pick the
// shape that fits its transport. We treat the flag conservatively — only the
// literal string "true" or boolean true counts; "1", "yes", or anything else
// resolves to false so an agent can't accidentally trigger a paid call by
// passing a truthy non-boolean.

import type { Request } from 'express';

export function isFreshRequest(req: Request): boolean {
  const fromQuery = req.query?.fresh;
  if (typeof fromQuery === 'string' && fromQuery === 'true') return true;
  const body = req.body as { fresh?: unknown } | null | undefined;
  if (body && typeof body === 'object' && body.fresh === true) return true;
  return false;
}
