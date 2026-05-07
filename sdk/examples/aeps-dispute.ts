/**
 * AEPS §10 dispute — end-to-end worked example.
 *
 * An agent calls a paid API, gets back a response that does NOT match
 * the published output_schema, and opens a content_correctness dispute
 * (5× multiplier). Three pre-agreed oracles independently fetch the
 * receipt + schema, sign their attestations, and the dispute resolves.
 *
 * This example uses :
 *   @satrank/sdk        — the AEPS surface + canonical-byte helpers
 *   @noble/curves        — BIP-340 Schnorr (oracle attestations)
 *   nostr-tools          — Nostr event finalize (NIP-98 auth)
 *
 * The SDK is zero runtime-dep ; bring your own crypto. This file shows
 * one supported combination — any conformant Schnorr + Nostr lib works.
 *
 * Run with : npx tsx sdk/examples/aeps-dispute.ts
 */
import { randomBytes } from 'node:crypto';
import {
  AepsDisputeNotFoundError,
  AepsOracleNotInSetError,
  AepsSignatureInvalidError,
  buildNip98EventTemplate,
  buildOutcomeMessageHash,
  encodeNip98AuthHeader,
  SatRank,
} from '@satrank/sdk';
import { schnorr } from '@noble/curves/secp256k1.js';
// @ts-expect-error — ESM subpath
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';

const API_BASE = process.env.SATRANK_API_BASE ?? 'https://satrank.dev';

// -- 1. Generate keypairs --------------------------------------------------

interface KeyPair {
  sk: Uint8Array;
  pkHex: string;
}

function newKeyPair(): KeyPair {
  const sk = randomBytes(32);
  const pkHex = Buffer.from(getPublicKey(sk)).toString('hex');
  return { sk, pkHex };
}

const agent = newKeyPair();        // disputant
const operator = newKeyPair();     // respondent (the bond gets slashed)
const oracle1 = newKeyPair();
const oracle2 = newKeyPair();
const oracle3 = newKeyPair();

// -- 2. Helper : NIP-98 sign for a given URL+method+body ------------------

function nip98(
  url: string,
  method: 'GET' | 'POST',
  bodyJson: string,
  signerSk: Uint8Array,
): string {
  const tmpl = buildNip98EventTemplate({ url, method, body: bodyJson });
  const signed = finalizeEvent(tmpl, signerSk);
  return encodeNip98AuthHeader(signed);
}

// -- 3. Open the dispute ---------------------------------------------------

async function main(): Promise<void> {
  const sr = new SatRank({ apiBase: API_BASE });

  console.log('1) Open content_correctness dispute (3 oracles, threshold 2)');
  const openBody = JSON.stringify({
    respondent_pubkey: operator.pkHex,
    dispute_type: 'content_correctness',
    receipt_id: 42, // would be the agent's evidence_receipts.receipt_id
    oracle_pubkeys: [oracle1.pkHex, oracle2.pkHex, oracle3.pkHex],
    oracle_threshold: 2,
  });
  const openAuth = nip98(sr.disputeEndpoint(), 'POST', openBody, agent.sk);
  const dispute = await sr.openDispute(JSON.parse(openBody), openAuth);
  console.log('   dispute_id    :', dispute.dispute_id);
  console.log('   multiplier    :', dispute.multiplier, '×');
  console.log('   threshold     :', dispute.oracle_threshold, 'of', dispute.oracle_pubkeys.length);
  console.log('   expires_at    :', new Date(dispute.expires_at * 1000).toISOString());

  // -- 4. Each oracle independently signs the canonical outcome message hash

  console.log('\n2) Oracles independently fetch evidence + sign attestations');
  const { hashBytes } = buildOutcomeMessageHash(
    dispute.dispute_id,
    'disputant_wins',
  );

  async function attest(oracle: KeyPair, label: string): Promise<void> {
    const sig = Buffer.from(schnorr.sign(hashBytes, oracle.sk)).toString('hex');
    const body = JSON.stringify({
      outcome: 'disputant_wins',
      signature_hex: sig,
    });
    const auth = nip98(
      sr.attestationEndpoint(dispute.dispute_id),
      'POST',
      body,
      oracle.sk,
    );
    try {
      const r = await sr.submitAttestation(
        dispute.dispute_id,
        JSON.parse(body),
        auth,
      );
      console.log(`   ${label} (${oracle.pkHex.slice(0, 12)}…) →`, r.dispute_state);
    } catch (e) {
      // Distinct catch by error subclass — no string-matching needed.
      if (e instanceof AepsOracleNotInSetError) {
        console.error(`   ${label}: oracle not in set (403)`);
      } else if (e instanceof AepsSignatureInvalidError) {
        console.error(`   ${label}: BIP-340 verify failed (400)`);
      } else if (e instanceof AepsDisputeNotFoundError) {
        console.error(`   ${label}: dispute_id unknown (404)`);
      } else {
        throw e;
      }
    }
  }

  await attest(oracle1, 'oracle 1');
  await attest(oracle2, 'oracle 2'); // threshold reached here

  // -- 5. Public read of final state ----------------------------------------

  console.log('\n3) Public read of resolved state');
  const view = await sr.getDispute(dispute.dispute_id);
  console.log('   state                :', view.state);
  console.log('   attestation_counts   :', view.attestation_counts);
  console.log('   resolved_at          :',
    view.resolved_at ? new Date(view.resolved_at * 1000).toISOString() : null);
  console.log('   slashing claim_id    :', view.claim_id);
  // claim_id is non-null on resolved_disputant — the operator's bond is
  // now reserved for the 5× slash. Settlement cron transitions to
  // executed after the 1h grace window per AEPS §7.2 (80% claimant /
  // 15% observer / 5% burned).
}

main().catch((e: unknown) => {
  console.error('Fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
