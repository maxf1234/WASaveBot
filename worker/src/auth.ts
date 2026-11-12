/** Verifies the Supabase JWT the web app sends in the Authorization header. */

import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';

export interface AuthedUser {
  id: string;
  email: string | null;
}

export type TokenVerifier = (token: string) => Promise<AuthedUser>;

export function createTokenVerifier(supabaseUrl: string, jwtSecret: string): TokenVerifier {
  const secret = new TextEncoder().encode(jwtSecret);
  // Projects on Supabase's newer asymmetric signing keys publish them here.
  const jwks = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));

  return async (token) => {
    const alg = decodeProtectedHeader(token).alg;
    let payload: JWTPayload;
    if (alg === 'HS256') {
      ({ payload } = await jwtVerify(token, secret, { algorithms: ['HS256'], audience: 'authenticated' }));
    } else {
      ({ payload } = await jwtVerify(token, jwks, {
        algorithms: ['ES256', 'RS256'],
        audience: 'authenticated',
      }));
    }
    if (!payload.sub || payload.role !== 'authenticated') throw new Error('Not a user token');
    return { id: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
  };
}
