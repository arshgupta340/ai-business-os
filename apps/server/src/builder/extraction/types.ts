import type { BusinessFact, FactKind } from '../pending-contracts';

// TEMPORARY transcriptions from docs/CONTRACTS.md (FileRecord, FactConflict,
// ActivityEvent and the two event payloads this module writes). They live here
// because packages/contracts is still empty (task S-02). When S-02 merges,
// import these names from `@abos/contracts` instead. No field name here is new.

// The upload cap (SPEC 2.9) and the accepted types (API.md 3.2, P-12).
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const ACCEPTED_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;
export type FileMime = (typeof ACCEPTED_MIME)[number];

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' satisfies FileMime;

export type ExtractionState = 'PENDING' | 'EXTRACTING' | 'EXTRACTED' | 'FAILED';

export interface FileRecord {
  id: string; // file_
  businessId: string;
  name: string;
  mime: FileMime;
  sizeBytes: number;
  sha256: string; // "sha256:<64 hex>", the format of the files.sha256 column (DATA-MODEL.md 2.5)
  extractionState: ExtractionState;
  draftFactIds?: string[];
  conflictIds?: string[];
  createdAt: string;
}

export interface FactConflictCandidate {
  factId?: string;
  sourceType: BusinessFact['sourceType'];
  sourceRef?: string;
  value: unknown;
}

export interface FactConflict {
  id: string; // cfl_
  businessId: string;
  kind: FactKind;
  key: string;
  required: boolean;
  candidates: FactConflictCandidate[];
  state: 'open' | 'resolved';
  resolvedFactId?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
}

export interface ExtractionCompletedPayload {
  fileId: string;
  mime: FileMime;
  extractionState: 'EXTRACTED' | 'FAILED';
  draftFactCount: number;
  conflictCount: number;
}

export interface FactChangedPayload {
  factId: string;
  kind: FactKind;
  key: string;
  fromVersion: number;
  toVersion: number;
  sourceType: BusinessFact['sourceType'];
}

export type ExtractionActivityEvent = {
  id: string; // evt_
  businessId: string;
  correlationId: string;
  actorType: 'owner' | 'deployed_agent' | 'system' | 'provider';
  occurredAt: string;
} & ({ type: 'extraction.completed'; payload: ExtractionCompletedPayload } | { type: 'fact.changed'; payload: FactChangedPayload });
