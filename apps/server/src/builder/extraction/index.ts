import { ENDPOINTS } from '@abos/contracts';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import { requireBusiness, type BuilderAuth } from '../auth';
import type { BuilderEnv } from '../env';
import type { BusinessKnowledge } from '../session/knowledge';
import { checkedResponse } from '../respond';
import { apiError, parseOrThrow } from '../util';
import type { DocumentExtractor } from './model';
import { OpenAiDocumentExtractor } from './openai-extractor';
import { RecordedDocumentExtractor } from './recorded-extractor';
import { ExtractionService } from './service';
import {
  FixtureCatalogReader,
  InMemoryActivityEventSink,
  InMemoryConflictStore,
  InMemoryFileStore,
  InMemoryUploadFactStore,
  type ActivityEventSink,
  type CatalogReader,
  type ConflictStore,
  type FileStore,
  type UploadFactStore,
} from './stores';
import { MAX_UPLOAD_BYTES } from './file-check';

// Files, extraction and conflict resolution routes (task B-21).
//
//   API.md 3.2   POST /api/businesses/:id/files, GET /api/files/:id
//   API.md 3.12  POST /api/conflicts/:id/resolve
//
// Every route calls requireBusiness first. For uploads that happens before a
// single byte of the file is read. The multipart parser is registered in a
// child scope, so it applies to these routes only.

export { assertNoOpenRequiredConflict, hasOpenRequiredConflict, openRequiredConflictIds, withConflicts } from './conflicts';
export type { ActivityEventSink, CatalogReader, ConflictStore, FileStore, UploadFactStore } from './stores';
export type { DocumentExtractor } from './model';

// Everything here has an in-memory or recorded default.
export interface ExtractionOptions {
  files?: FileStore;
  facts?: UploadFactStore;
  conflicts?: ConflictStore;
  catalog?: CatalogReader;
  extractor?: DocumentExtractor;
  events?: ActivityEventSink;
}

export interface ExtractionDeps extends ExtractionOptions {
  auth: BuilderAuth;
  knowledge: BusinessKnowledge;
  env: BuilderEnv;
  now: () => Date;
}

// Params and bodies are parsed with the endpoint schemas of the package.
const E = { upload: ENDPOINTS.uploadFile, getFile: ENDPOINTS.getFile, resolve: ENDPOINTS.resolveConflict };

function uploadRefused(message: string) {
  return apiError('VALIDATION_FAILED', message, { issues: [{ path: 'file', message }] });
}

// The business is in the path for /api/businesses/... (API.md section 1).
// requireBusiness reads it from the query, so the path value is handed over.
function withPathBusiness(request: FastifyRequest): FastifyRequest {
  const { id } = parseOrThrow(E.upload.params, request.params);
  return Object.create(request, { query: { value: { businessId: id } } }) as FastifyRequest;
}

// Reads the one `file` part, counting bytes while the stream is read and
// stopping as soon as the count passes the cap.
async function readUpload(request: FastifyRequest): Promise<{ fileName: string; declaredMime: string; bytes: Buffer }> {
  if (!request.isMultipart()) throw uploadRefused('Send the file as multipart/form-data in a field named file.');
  const part = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, parts: 6 }, throwFileSizeLimit: false });
  if (!part) throw uploadRefused('Send the file as multipart/form-data in a field named file.');
  if (part.fieldname !== 'file') {
    part.file.resume();
    throw uploadRefused('The upload field must be named file.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of part.file) {
    size += (chunk as Buffer).length;
    if (size > MAX_UPLOAD_BYTES) {
      part.file.resume();
      throw uploadRefused('The file is larger than 10 MB.');
    }
    chunks.push(chunk as Buffer);
  }
  if (part.file.truncated) throw uploadRefused('The file is larger than 10 MB.');
  return { fileName: part.filename, declaredMime: part.mimetype, bytes: Buffer.concat(chunks, size) };
}

export function registerExtractionRoutes(app: FastifyInstance, deps: ExtractionDeps) {
  const extractor =
    deps.extractor ??
    (deps.env.mode === 'openai' ? new OpenAiDocumentExtractor({ apiKey: deps.env.apiKey, model: deps.env.model }) : new RecordedDocumentExtractor());
  const resolved = {
    files: deps.files ?? new InMemoryFileStore(),
    facts: deps.facts ?? new InMemoryUploadFactStore(),
    conflicts: deps.conflicts ?? new InMemoryConflictStore(),
    catalog: deps.catalog ?? new FixtureCatalogReader(),
    events: deps.events ?? new InMemoryActivityEventSink(),
    extractor,
  };
  const service = new ExtractionService({ ...resolved, knowledge: deps.knowledge, now: deps.now, log: app.log });

  app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

    // Parser and multipart errors in this scope become VALIDATION_FAILED.
    // Everything else goes on to the app's error handler unchanged.
    scope.setErrorHandler((error: unknown) => {
      if (error instanceof AppError) throw error;
      const code = (error as { code?: unknown }).code;
      const status = (error as { statusCode?: unknown }).statusCode;
      if (typeof code === 'string' && (code.startsWith('FST_REQ_FILE_TOO_LARGE') || code.startsWith('FST_FILES_LIMIT') || code.startsWith('FST_PARTS_LIMIT'))) {
        throw uploadRefused('Send one file of at most 10 MB.');
      }
      if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE' || code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || status === 413 || status === 415) {
        throw uploadRefused('Send the file as multipart/form-data in a field named file.');
      }
      throw error;
    });

    scope.post('/api/businesses/:id/files', async (request, reply) => {
      const business = await requireBusiness(deps.auth, withPathBusiness(request));
      const upload = await readUpload(request);
      const file = await service.upload({ businessId: business.businessId, ownerId: business.owner.userId, ...upload });
      return reply.status(E.upload.successStatus).send(checkedResponse('uploadFile', { file }));
    });

    scope.get('/api/files/:id', async (request) => {
      const business = await requireBusiness(deps.auth, request);
      const { id } = parseOrThrow(E.getFile.params, request.params);
      // The package's getFile response is the FileRecord itself, not { file }.
      return checkedResponse('getFile', await service.get(business.businessId, id));
    });

    scope.post('/api/conflicts/:id/resolve', async (request) => {
      const business = await requireBusiness(deps.auth, request);
      const { id } = parseOrThrow(E.resolve.params, request.params);
      parseOrThrow(E.resolve.body, request.body ?? {});
      const conflict = await service.resolveConflict({ businessId: business.businessId, ownerId: business.owner.userId, conflictId: id });
      return checkedResponse('resolveConflict', { conflict });
    });
  });

  return { service, ...resolved };
}
