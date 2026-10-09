// Prepara o banco Supabase Postgres (schema + seeds idempotentes via db.js).
// Uso:
//   npm run init-db              -> garante schema/seeds (nao apaga dados)
//   node init-db.js --reset      -> DROP de todas as tabelas e recria do zero
// Exige DATABASE_URL no ambiente.
const { getDb, initDatabase, closeDb } = require('./db');

const TABLE_ORDER = [
  'accruals',
  'company_results',
  'positions',
  'transactions',
  'withdrawals',
  'deposits',
  'settings',
  'gateways',
  'plans',
  'users'
];

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('[nexora] DATABASE_URL nao definida. Exporte a connection string do Supabase.');
    process.exit(1);
  }
  try {
    const db = await getDb();
    if (process.argv.includes('--reset')) {
      for (const t of TABLE_ORDER) {
        await db.exec(`DROP TABLE IF EXISTS ${t} CASCADE;`);
      }
      console.log('[nexora] Tabelas removidas; recriando schema e seeds...');
      await initDatabase(db);
    } else {
      console.log('[nexora] Schema assegurado (CREATE ... IF NOT EXISTS + seeds idempotentes).');
    }
    console.log('[nexora] Seed admin: username=admin email=admin@nexora.local senha=Admin123!');
    await closeDb();
    console.log('[nexora] Pronto.');
  } catch (err) {
    console.error('[nexora] Falha no init-db:', err.message);
    process.exit(1);
  }
})();