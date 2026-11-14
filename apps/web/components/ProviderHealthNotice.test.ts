import {describe, expect, it} from 'vitest';
import {integrationHealth, integrationHealthDisconnected} from '@abos/contracts/fixtures';
import {providerProblems, providersForSteps} from './ProviderHealthNotice';

describe('providersForSteps', () => {
  it('maps each external step to its provider and leaves local steps out', () => {
    expect(providersForSteps(['square.checkout.create', 'message.checkout.send', 'local.order.record', 'sheets.order.append'])).toEqual([
      'square',
      'message_channel',
      'google_sheets',
    ]);
    expect(providersForSteps(['local.fact.update'])).toEqual([]);
  });
});

describe('providerProblems', () => {
  it('names a disconnected Sheets with what the owner will notice, and says nothing for connected providers', () => {
    const problems = providerProblems(integrationHealthDisconnected, ['square', 'google_sheets']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({provider: 'google_sheets', state: 'disconnected', tone: 'danger', title: 'Google Sheets is disconnected'});
    expect(problems[0].description).toMatch(/report sheet is not updated/);
  });

  it('reports the degraded calendar for a booking, as a warning, never green', () => {
    const problems = providerProblems(integrationHealth, ['google_calendar', 'message_channel']);
    expect(problems.map((p) => [p.provider, p.tone])).toEqual([['google_calendar', 'warning']]);
    expect(providerProblems(undefined, ['square'])).toEqual([]);
  });
});
