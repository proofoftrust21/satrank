// Phase 7.1 — oracle peers discovery service.
//
// Subscribe permanent au filter {kinds:[30784], #d:['satrank-oracle-announcement']}
// sur les relays configurés. Chaque event valide → upsert oracle_peers.
//
// Pas de filtering trust côté ingestion : on persiste tout peer qui
// publie un kind 30784 valide. Le filtering (calibration_error >= seuil,
// catalogue_size minimum, etc.) est CLIENT-SIDE — l'agent SDK choisit
// son seuil. Cohérent avec la philosophie SatRank (pas de gatekeeping
// central).
//
// Self-bootstrap : si CETTE instance publie un kind 30784, elle se
// découvre comme peer dans sa propre table. Comportement attendu — un
// agent qui interroge /api/oracle/peers voit l'instance interrogée comme
// un peer valide, ce qui simplifie le bootstrap des clients.
//
// Validation entrée :
//   - kind === 30784
//   - d-tag === 'satrank-oracle-announcement'
//   - oracle_pubkey présent et 64-hex
//   - oracle_pubkey === event.pubkey (l'announcement est self-attesté)
//   - signature Schnorr valide (verifyEvent)
import { logger } from '../logger';
import type { OraclePeerRepository } from '../repositories/oracleFederationRepository';

export interface DiscoveryEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface DiscoveryDeps {
  peerRepo: OraclePeerRepository;
  /** Verify Nostr event signature. Injectable pour tests + isolation
   *  d'import nostr-tools. */
  verifyEvent: (event: DiscoveryEvent) => boolean;
  now?: () => number;
}

const ANNOUNCEMENT_D_TAG = 'satrank-oracle-announcement';

export class OraclePeersDiscovery {
  private readonly now: () => number;

  constructor(private readonly deps: DiscoveryDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Ingest un kind 30784 reçu via subscribe. Pure dispatch côté repo —
   *  validation + UPSERT. Retourne l'outcome pour les tests + logs. */
  async ingestAnnouncement(event: DiscoveryEvent): Promise<{ outcome: 'persisted' | 'rejected'; reason?: string }> {
    if (event.kind !== 30784) {
      return { outcome: 'rejected', reason: 'wrong_kind' };
    }
    const dTag = event.tags.find((t) => t[0] === 'd');
    if (!dTag || dTag[1] !== ANNOUNCEMENT_D_TAG) {
      return { outcome: 'rejected', reason: 'wrong_d_tag' };
    }
    const oraclePubkeyTag = event.tags.find((t) => t[0] === 'oracle_pubkey');
    if (!oraclePubkeyTag || !oraclePubkeyTag[1]) {
      return { outcome: 'rejected', reason: 'missing_oracle_pubkey_tag' };
    }
    if (!/^[a-f0-9]{64}$/.test(oraclePubkeyTag[1])) {
      return { outcome: 'rejected', reason: 'malformed_oracle_pubkey' };
    }
    if (oraclePubkeyTag[1] !== event.pubkey) {
      // L'announcement doit être self-attesté : event.pubkey signe et le
      // tag oracle_pubkey doit matcher. Sinon = tentative de spoofing.
      return { outcome: 'rejected', reason: 'oracle_pubkey_does_not_match_signer' };
    }
    if (!this.deps.verifyEvent(event)) {
      return { outcome: 'rejected', reason: 'signature_invalid' };
    }

    // Extract optional fields. Security H3+H6+M1 — sanitize toutes les
    // valeurs d'attacker-controlled tag avant persistence.
    const lndPubkeyRaw = event.tags.find((t) => t[0] === 'lnd_pubkey')?.[1];
    const lndPubkey = lndPubkeyRaw && /^(02|03)[a-f0-9]{64}$/.test(lndPubkeyRaw) ? lndPubkeyRaw : null;
    const catalogueSizeRaw = event.tags.find((t) => t[0] === 'catalogue_size')?.[1];
    const catalogueSizeParsed = catalogueSizeRaw ? parseInt(catalogueSizeRaw, 10) : 0;
    // Security H6 — clamp à int32 [0, 1M] pour empêcher Postgres integer
    // overflow ET pour éviter l'inflation déraisonnable (1M endpoints =
    // déjà 3× 402index aujourd'hui).
    const catalogueSize = Number.isFinite(catalogueSizeParsed)
      ? Math.max(0, Math.min(catalogueSizeParsed, 1_000_000))
      : 0;
    const calibrationEventIdRaw = event.tags.find((t) => t[0] === 'calibration_event_id')?.[1];
    const calibrationEventId = calibrationEventIdRaw && /^[a-f0-9]{64}$/.test(calibrationEventIdRaw)
      ? calibrationEventIdRaw : null;
    const lastAssertionEventIdRaw = event.tags.find((t) => t[0] === 'last_assertion_event_id')?.[1];
    const lastAssertionEventId = lastAssertionEventIdRaw && /^[a-f0-9]{64}$/.test(lastAssertionEventIdRaw)
      ? lastAssertionEventIdRaw : null;
    // Security M1 — contact max 200 chars (free-text, tronque silencieusement
    // pour éviter du data poisoning sur des payloads géants).
    const contactRaw = event.tags.find((t) => t[0] === 'contact')?.[1];
    const contact = contactRaw ? contactRaw.slice(0, 200) : null;
    // Security H3 — onboarding_url DOIT être https:// valide. Une URL
    // javascript: ou data: ou http:// hostile devient null.
    const onboardingUrlRaw = event.tags.find((t) => t[0] === 'onboarding_url')?.[1];
    const onboardingUrl = (() => {
      if (!onboardingUrlRaw) return null;
      try {
        const u = new URL(onboardingUrlRaw);
        return u.protocol === 'https:' && onboardingUrlRaw.length <= 500
          ? u.toString()
          : null;
      } catch {
        return null;
      }
    })();

    const nowSec = this.now();
    // Pour le first_seen : si le peer existe déjà, on garde l'ancien
    // first_seen (logique côté SQL via UPSERT — mais ici on doit le
    // calculer). Read-then-upsert pour préserver first_seen original.
    const existing = await this.deps.peerRepo.findByPubkey(event.pubkey);
    const firstSeen = existing?.first_seen ?? nowSec;

    await this.deps.peerRepo.upsert({
      oracle_pubkey: event.pubkey,
      lnd_pubkey: lndPubkey,
      catalogue_size: Number.isFinite(catalogueSize) ? catalogueSize : 0,
      calibration_event_id: calibrationEventId,
      last_assertion_event_id: lastAssertionEventId,
      contact,
      onboarding_url: onboardingUrl,
      last_seen: nowSec,
      first_seen: firstSeen,
      latest_announcement_event_id: event.id,
    });

    logger.info(
      {
        oracle_pubkey: event.pubkey.slice(0, 12),
        catalogue_size: catalogueSize,
        first_seen: firstSeen,
        is_new: !existing,
      },
      'OraclePeersDiscovery: peer announcement ingested',
    );

    return { outcome: 'persisted' };
  }
}
