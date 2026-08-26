import { defineConfig } from 'drizzle-kit';

// Migrations werden aus dem Schema generiert (npm run db:generate) und liegen
// in ./drizzle. Angewendet via src/db/migrate.ts (npm run db:migrate).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/app.db',
  },
  casing: 'snake_case',
});
