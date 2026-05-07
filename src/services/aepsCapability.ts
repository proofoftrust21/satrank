// AEPS §4 (2026-05-08) — Capability descriptor canonical hashing.
//
// Per the whitepaper §4, every endpoint advertises a CapabilityDescriptor
// with operator_pubkey, method, url, input/output JSON schemas, pricing,
// evidence_endpoint, bond_pubkey, dlc_oracles[], dlc_threshold, version.
//
// The endpoint_id is the SHA-256 hex of the canonical-JSON serialization
// of the descriptor with the endpoint_id field stripped. It functions as
// a content address — any change to any field produces a new endpoint_id.
//
// This module provides the pure helpers ; the descriptor itself lives
// inline in capability_descriptors / endpoint_schemas tables. Cross-impl
// conformance is enforced by spec/test-vectors/capability_descriptor.json
// — both TS and Rust impls must produce byte-identical canonical output.
import { createHash } from 'node:crypto';
import { canonicalJson } from './signerService';

export interface AepsCapabilityDescriptor {
  /** Optional during construction ; populated by computeEndpointId. */
  endpoint_id?: string;
  operator_pubkey: string;
  method: string;
  url: string;
  input_schema: unknown;
  output_schema: unknown;
  price_msat: number;
  quote_validity_s: number;
  evidence_endpoint: string;
  bond_pubkey: string;
  dlc_oracles: string[];
  dlc_threshold: number;
  version: string;
}

/** Build the canonical JSON of the descriptor with endpoint_id stripped.
 *  Pure function. Both reference impls produce identical output for the
 *  same input — verified via spec/test-vectors/capability_descriptor.json. */
export function buildCanonicalDescriptor(d: AepsCapabilityDescriptor): string {
  // Strip endpoint_id (it's the output, not part of the input).
  const stripped: Record<string, unknown> = { ...d };
  delete stripped.endpoint_id;
  return canonicalJson(stripped);
}

/** Compute the endpoint_id (SHA-256 hex of canonical bytes).
 *  Deterministic : same descriptor → same id, regardless of field order. */
export function computeEndpointId(d: AepsCapabilityDescriptor): string {
  const canonical = buildCanonicalDescriptor(d);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
