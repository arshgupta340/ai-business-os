/**
 * Issues #125 and #128: no raw error code, server message, fact source or
 * second set of catalog sync labels reaches the owner on Business Knowledge
 * and Prices. Each list is read from the contract.
 */
import {describe, expect, it} from 'vitest';
import {ErrorCodeSchema, FactSourceTypeSchema, SyncJobStateSchema, type ErrorCode} from '@abos/contracts';
import {ApiError, type PriceEditApprovalPayload} from '@/lib/api';
import {expectOwnerLabel, FUTURE_VALUES} from '@/lib/owner-label.test-helpers';
import {statusView} from '@/lib/status';
import {failureText} from '../prices/_lib/price-row';
import {proposeErrorView} from '../prices/_lib/propose-errors';
import {knowledgeErrorText} from './ApiErrorBanner';
import * as model from './knowledge-model';

/** expectOwnerLabel, plus no dotted identifier such as "square.catalog.price.update". A price such as $21.00 is not one. */
function expectPlain(text: unknown, raw: string): void {
  expectOwnerLabel(text, raw);
  expect(text as string, `text for ${raw} has a dotted identifier`).not.toMatch(/[A-Za-z_]\.[A-Za-z_]/);
}

/** The server message the owner could read before (issue #127). */
const SERVER_MESSAGE = 'Operation failed: INVALID_STATE.';

const apiError = (code: ErrorCode, details?: Record<string, unknown>) =>
  new ApiError({code, message: SERVER_MESSAGE, status: 400, retryable: true, details, kind: 'http', correlationId: 'cor_1'});

const payload = {variationId: 'var_1', newPriceMinor: 2100, currency: 'USD'} as PriceEditApprovalPayload;

describe('price row failures (#125)', () => {
  it('says what happened for every error code and never shows the code', () => {
    for (const errorCode of ErrorCodeSchema.options) {
      expectPlain(failureText({kind: 'square_failed', payload, squarePrice: 'unknown', errorCode}), errorCode);
      expectPlain(failureText({kind: 'square_failed', payload, squarePrice: 'unchanged', errorCode}), errorCode);
      expectPlain(failureText({kind: 'sync_failed', payload, errorCode}), errorCode);
    }
  });
});

describe('fact sources (#125)', () => {
  it('names every source and never returns a raw value', () => {
    for (const source of FactSourceTypeSchema.options) expectPlain(model.sourceTypeLabel(source), source);
    for (const value of FUTURE_VALUES) expectPlain(model.sourceTypeLabel(value as never), value);
  });
});

describe('catalog sync (#125)', () => {
  it('keeps no second set of labels: the screen reads statusView', () => {
    expect('CATALOG_SYNC_LABELS' in model).toBe(false);
    for (const state of SyncJobStateSchema.options) expectPlain(statusView('catalogSync', state).label, state);
  });
});

describe('error text on Business Knowledge and Prices (#128)', () => {
  it('shows the sentence for every code, never the server message', () => {
    for (const code of ErrorCodeSchema.options) {
      const banner = knowledgeErrorText(apiError(code));
      expectPlain(banner, code);
      expect(banner).not.toContain(SERVER_MESSAGE);
      const view = proposeErrorView(apiError(code));
      for (const text of [view.title, view.message, view.fieldMessage].filter((t) => t !== undefined)) {
        expectPlain(text, code);
        expect(text).not.toContain(SERVER_MESSAGE);
      }
    }
  });

  it('names a provider in words', () => {
    expect(knowledgeErrorText(apiError('INTEGRATION_UNAVAILABLE', {provider: 'google_sheets'}))).toBe('Google Sheets is not responding.');
    expect(proposeErrorView(apiError('INTEGRATION_UNAVAILABLE', {provider: 'google_sheets'})).title).toBe('Google Sheets is not responding');
  });

  it('never shows the message of an error that did not come from the API', () => {
    expectPlain(knowledgeErrorText(new Error(SERVER_MESSAGE)), 'INVALID_STATE');
    expectPlain(proposeErrorView(new Error(SERVER_MESSAGE)).message, 'INVALID_STATE');
  });
});
