import {describe, expect, it} from 'vitest';
import {ApiError} from '@/lib/api';
import {isMissingRoute, proposeErrorView} from './propose-errors';

const notFound = (message: string) =>
  new ApiError({code: 'NOT_FOUND', message, status: 404, retryable: false, kind: 'http', correlationId: 'cor_np_1'});

describe('proposeErrorView NOT_FOUND', () => {
  it('says the price editor is not available when the server has no route for it', () => {
    // apps/server/src/app.ts setNotFoundHandler on origin/arsh/integration.
    const error = notFound('No route for POST /api/businesses/biz_pizza_01/catalog/prices/propose');
    expect(isMissingRoute(error)).toBe(true);
    const view = proposeErrorView(error);
    expect(view.title).toBe('The price editor is not available on this server');
    expect(view.title).not.toMatch(/variation/);
    expect(view.message).toMatch(/Nothing was proposed/);
    expect(view.message).not.toMatch(/No route|\/api\//);
    expect(view.retryable).toBe(false);
  });

  it('still says the variation is not in the catalog for a real not found', () => {
    const view = proposeErrorView(notFound('Catalog variation not found.'));
    expect(view.title).toBe('This variation is not in the catalog');
  });
});
