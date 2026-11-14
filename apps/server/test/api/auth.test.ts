import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createVerifier } from '../../src/auth/verify';
import { parseEnv } from '../../src/env';

const base = 'https://auth.example.test';
const subject = '00000000-0000-4000-8000-000000000001';

afterEach(() => vi.unstubAllGlobals());

describe('Supabase JWT verifier', () => {
  it('verifies signatures, issuer, audience and expiry, caching the remote JWKS', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'ES256', use: 'sig' };
    const fetcher = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const verifier = createVerifier(parseEnv({ SUPABASE_URL: `${base}/` }));
    async function token(issuer = `${base}/auth/v1`, audience = 'authenticated', expiry = '1h') {
      return new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).setSubject(subject)
        .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expiry).sign(privateKey);
    }
    const valid = await token();
    expect(await verifier.verify(valid)).toEqual({ authUserId: subject });
    expect(await verifier.verify(valid)).toEqual({ authUserId: subject });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${base}/auth/v1/.well-known/jwks.json`);
    await expect(verifier.verify(await token('https://wrong.test'))).rejects.toThrow();
    await expect(verifier.verify(await token(`${base}/auth/v1`, 'anon'))).rejects.toThrow();
    await expect(verifier.verify(await token(`${base}/auth/v1`, 'authenticated', '-1h'))).rejects.toThrow();
    const unsigned = `${valid.split('.')[0]}.${Buffer.from('{"sub":"forged"}').toString('base64url')}.${valid.split('.')[2]}`;
    await expect(verifier.verify(unsigned)).rejects.toThrow();
    const missingSub = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer(`${base}/auth/v1`).setAudience('authenticated').setExpirationTime('1h').sign(privateKey);
    await expect(verifier.verify(missingSub)).rejects.toThrow('Invalid access token');
  });
  it('does not fetch when Supabase is not configured', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(createVerifier(parseEnv({})).verify('token')).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
