// Business logic for attestations
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { Attestation, CreateAttestationInput } from '../types';
import { NotFoundError, ValidationError, ConflictError } from '../errors';

export class AttestationService {
  constructor(
    private attestationRepo: AttestationRepository,
    private agentRepo: AgentRepository,
    private txRepo: TransactionRepository,
    private db?: Database.Database,
  ) {}

  getBySubject(subjectHash: string, limit: number, offset: number) {
    const agent = this.agentRepo.findByHash(subjectHash);
    if (!agent) throw new NotFoundError('Agent', subjectHash);

    const attestations = this.attestationRepo.findBySubject(subjectHash, limit, offset);
    const total = this.attestationRepo.countBySubject(subjectHash);

    return { attestations, total };
  }

  create(input: CreateAttestationInput): Attestation {
    // Verify attester exists
    if (!this.agentRepo.findByHash(input.attesterHash)) {
      throw new NotFoundError('Agent (attester)', input.attesterHash);
    }

    // Verify subject exists — keep the reference for stats update
    const subject = this.agentRepo.findByHash(input.subjectHash);
    if (!subject) {
      throw new NotFoundError('Agent (subject)', input.subjectHash);
    }

    // Verify the referenced transaction exists
    const tx = this.txRepo.findById(input.txId);
    if (!tx) {
      throw new NotFoundError('Transaction', input.txId);
    }

    // The attester must be a party to the transaction (sender or receiver)
    // They assert first-hand knowledge
    const txParties = new Set([tx.sender_hash, tx.receiver_hash]);
    if (!txParties.has(input.attesterHash)) {
      throw new ValidationError('Attester must be a party (sender or receiver) of the referenced transaction');
    }

    // Self-attestation is not allowed
    if (input.attesterHash === input.subjectHash) {
      throw new ValidationError('An agent cannot attest itself');
    }

    const attestation: Attestation = {
      attestation_id: uuid(),
      tx_id: input.txId,
      attester_hash: input.attesterHash,
      subject_hash: input.subjectHash,
      score: input.score,
      tags: input.tags ? JSON.stringify(input.tags) : null,
      evidence_hash: input.evidenceHash ?? null,
      timestamp: Math.floor(Date.now() / 1000),
    };

    // Insert + stats update in an atomic transaction
    const insertAndUpdate = () => {
      try {
        this.attestationRepo.insert(attestation);
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
          throw new ConflictError('Attestation already submitted for this transaction by this attester');
        }
        throw err;
      }

      const newCount = this.attestationRepo.countBySubject(input.subjectHash);
      this.agentRepo.updateStats(
        input.subjectHash,
        subject.total_transactions,
        newCount,
        subject.avg_score,
        subject.last_seen,
      );
    };

    if (this.db) {
      this.db.transaction(insertAndUpdate)();
    } else {
      insertAndUpdate();
    }

    return attestation;
  }
}
