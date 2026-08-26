import type { AuthClaims } from './auth/jwt.ts';

// Typ-Erweiterung für den Hono-Context (c.get('user') / c.set('user', ...)).
export type AppEnv = {
  Variables: {
    user: AuthClaims;
  };
};
