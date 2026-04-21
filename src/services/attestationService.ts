// Business logic for attestations
import { v4 as uuid } from 'uuid';
import type { Pool } from 'pg';
import { AttestationRepository } from '../repositories/attestationRepository';
import { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import { withTransaction } from '../database/transaction';
import type { Attestation, CreateAttestationInput } from '../types';
import { NotFoundError, ValidationError, DuplicateReportError } from '../errors';

/** Postgres unique_violation code (duplicate primary key / unique index). */
const PG_UNIQUE_VIOLATION = '23505';

export class AttestationService {
  constructor(
    private attestationRepo: AttestationRepository,
    private agentRepo: AgentRepository,
    private txRepo: TransactionRepository,
    private pool?: Pool,
  ) {}

  async getBySubject(subjectHash: string, limit: number, offset: number) {
    const agent = await this.agentRepo.findByHash(subjectHash);
    if (!agent) throw new NotFoundError('Agent', subjectHash);

    const attestations = await this.attestationRepo.findBySubject(subjectHash, limit, offset);
    const total = await this.attestationRepo.countBySubject(subjectHash);

    return { attestations, total };
  }

  async create(input: CreateAttestationInput): Promise<Attestation> {
    // Verify attester exists
    if (!(await this.agentRepo.findByHash(input.attesterHash))) {
      throw new NotFoundError('Agent (attester)', input.attesterHash);
    }

    // Verify subject exists — keep the reference for stats update
    const subject = await this.agentRepo.findByHash(input.subjectHash);
    if (!subject) {
      throw new NotFoundError('Agent (subject)', input.subjectHash);
    }

    // Verify the referenced transaction exists
    const tx = await this.txRepo.findById(input.txId);
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
      category: input.category ?? 'general',
      verified: 0,
      weight: 1.0,
    };

    // Insert + stats update in an atomic transaction.
    const doInsertAndUpdate = async (
      attRepo: AttestationRepository,
      agRepo: AgentRepository,
    ): Promise<void> => {
      try {
        await attRepo.insert(attestation);
      } catch (err: unknown) {
        const code = (err as { code?: string } | null)?.code;
        if (code === PG_UNIQUE_VIOLATION) {
          throw new DuplicateReportError('Attestation already submitted for this transaction by this attester');
        }
        throw err;
      }

      const newCount = await attRepo.countBySubject(input.subjectHash);
      await agRepo.updateStats(
        input.subjectHash,
        subject.total_transactions,
        newCount,
        subject.avg_score,
        subject.first_seen,
        subject.last_seen,
      );
    };

    if (this.pool) {
      await withTransaction(this.pool, async (client) => {
        const attRepo = new AttestationRepository(client);
        const agRepo = new AgentRepository(client);
        await doInsertAndUpdate(attRepo, agRepo);
      });
    } else {
      await doInsertAndUpdate(this.attestationRepo, this.agentRepo);
    }

    return attestation;
  }
}
