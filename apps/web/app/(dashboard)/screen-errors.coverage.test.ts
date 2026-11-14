/**
 * Part of #128: no screen helper in approvals, overview, integrations, agents,
 * build or telemetry shows the server message or an error code as its main
 * text. Every helper gets every error code from the contract, with the server
 * message the owner once read: "Operation failed: INVALID_STATE.".
 */
import {describe, expect, it} from 'vitest';
import {ErrorCodeSchema} from '@abos/contracts';
import {ApiError} from '@/lib/api';
import {expectOwnerLabel} from '@/lib/owner-label.test-helpers';
import {errorView, type ErrorContext} from './agents/_lib/agents-view';
import {publishErrorView} from './agents/[id]/preview/_lib/preview';
import {rollbackErrorView} from './agents/[id]/versions/_lib/versions';
import {decisionErrorView} from './approvals/_lib/approval-view';
import {builderSendErrorView} from './build/_lib/spec';
import {errorText} from './integrations/_lib/integrations-view';

const SERVER_MESSAGE = 'Operation failed: INVALID_STATE.';

const error = (code: string, retryable = false) =>
  new ApiError({code: code as never, message: SERVER_MESSAGE, status: 500, retryable, kind: 'http'});

/** No underscore, no word in capitals, no dotted identifier, and never the server message. */
function expectNoCode(text: unknown, code: string): void {
  expectOwnerLabel(text, code);
  expect(text as string).not.toContain('Operation failed');
  expect(text as string).not.toMatch(/[a-z]\.[a-z]/);
}

const CONTEXTS: ErrorContext[] = ['load', 'pause', 'liveSwitch', 'change'];
const CODES = [...ErrorCodeSchema.options, 'SOMETHING_NEW'];

describe.each(CODES)('error code %s', (code) => {
  it('reads as a sentence in every screen helper', () => {
    for (const retryable of [true, false]) {
      const e = error(code, retryable);
      const decision = decisionErrorView(e);
      expectNoCode(decision.title, code);
      expectNoCode(decision.message, code);
      expectNoCode(errorText(e), code);
      expectNoCode(builderSendErrorView(e).description, code);
      for (const context of CONTEXTS) expectNoCode(errorView(e, context).message, code);
      const publish = publishErrorView(e, null);
      expectNoCode(publish.title, code);
      expectNoCode(publish.message, code);
      const rollback = rollbackErrorView(e);
      expectNoCode(rollback.title, code);
      expectNoCode(rollback.message, code);
    }
  });
});
