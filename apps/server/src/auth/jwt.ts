import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../config/env.ts';

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ALG = 'HS256';

export interface AuthClaims extends JWTPayload {
  id: number;
  username: string;
  email: string | null;
  role: string;
  provider: 'local' | 'ad';
}

export async function signToken(claims: Omit<AuthClaims, keyof JWTPayload>): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(env.JWT_TTL)
    .sign(secret);
}

export async function verifyToken(token: string): Promise<AuthClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] });
    return payload as AuthClaims;
  } catch {
    return null;
  }
}
