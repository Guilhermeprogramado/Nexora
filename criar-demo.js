// Cria usuário demo (idempotente). Uso: node criar-demo.js
// Exige DATABASE_URL no ambiente (Supabase Postgres).
const bcrypt = require('bcryptjs');
const { getDb, closeDb } = require('./db');

// O usuário de teste nasce zerado. O rendimento dele é o que estiver na
// carteira dele, lido em /yield.html.

const USER = { username: 'demo', email: 'demo@nexora.local', password: 'Demo123!' };

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('[nexora] DATABASE_URL nao definida. Exporte a connection string do Supabase.');
    process.exit(1);
  }
  try {
    const db = await getDb();
    let user = await db.prepare('SELECT * FROM users WHERE username = ?').get(USER.username);
    if (!user) {
      const hash = bcrypt.hashSync(USER.password, 10);
      const info = await db.prepare(
        `INSERT INTO users (username, email, password_hash, referral_code, referred_by, affiliate_rate, is_admin)
         VALUES (?, ?, ?, ?, NULL, 0, 0)`
      ).run(USER.username, USER.email, hash, USER.username);
      user = await db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
      await db.prepare(`INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'signup', 0, 'Conta de teste criada sem saldo')`).run(user.id);
      console.log('[demo] usuário criado (saldo zero):', USER.username, '/', USER.password);
    } else {
      console.log('[demo] usuário já existe:', user.username);
      console.log('[demo] id=%s balance=%s active_deposit=%s', user.id, user.balance, user.active_deposit);
    }
    await closeDb();
  } catch (err) {
    console.error('[nexora] Falha ao criar demo:', err.message);
    process.exit(1);
  }
})();