// Phase 5 — vérifie que /api/intent, /api/intent/categories et la
// déprécation de /best-route sont annoncés dans openapi.json.
// Phase 10 — /decide a été retiré (410 Gone, plus dans le spec).
// Smoke test minimal : sert de filet quand on renomme un path ou qu'on
// oublie de déprécier un endpoint remplacé.
import { describe, it, expect } from 'vitest';
import { openapiSpec } from '../openapi';

describe('openapi.json — Phase 5/10', () => {
  it('déclare POST /intent avec schéma de request + response', () => {
    const path = openapiSpec.paths['/intent'];
    expect(path).toBeDefined();
    expect(path.post).toBeDefined();
    expect(path.post.tags).toContain('Discovery');
    expect(path.post.requestBody.content['application/json'].schema.required).toContain('category');
    expect(path.post.responses['200']).toBeDefined();
    expect(path.post.responses['400']).toBeDefined();
  });

  it('déclare GET /intent/categories avec endpoint_count + active_count', () => {
    const path = openapiSpec.paths['/intent/categories'];
    expect(path).toBeDefined();
    expect(path.get).toBeDefined();
    const responseSchema = path.get.responses['200'].content['application/json'].schema;
    const categoryItems = responseSchema.properties.categories.items.properties;
    expect(categoryItems.name).toBeDefined();
    expect(categoryItems.endpoint_count).toBeDefined();
    expect(categoryItems.active_count).toBeDefined();
  });

  it('ne liste plus /decide dans openapi (supprimé en Phase 10, 410 Gone)', () => {
    expect((openapiSpec.paths as Record<string, unknown>)['/decide']).toBeUndefined();
  });

  it('marque /best-route comme deprecated avec pointeur vers /intent', () => {
    expect(openapiSpec.paths['/best-route'].post.deprecated).toBe(true);
    expect(openapiSpec.paths['/best-route'].post.description).toContain('/api/intent');
  });

  it('fourbi strictness enum strict/relaxed/degraded dans meta', () => {
    const responseSchema = openapiSpec.paths['/intent'].post.responses['200'].content['application/json'].schema;
    const strictnessEnum = responseSchema.properties.meta.properties.strictness.enum;
    expect(strictnessEnum).toEqual(['strict', 'relaxed', 'degraded']);
  });
});
