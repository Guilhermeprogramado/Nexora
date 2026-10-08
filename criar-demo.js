// Cria usuário demo (idempotente). Uso: node criar-demo.js
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { initDatabase, ensureCompat } = require('./db');

const db = new DatabaseSync(path.join(__dirname, 'nexora.db'));
ensureCompat(db);
initDatabase(db);

// Antes: criava o demo com saldo 1250.50, earnings 320.75, depósito ativo de
// 1000 "ativo" apontando para plan_id=1 / gateway_id=1 (que não existem mais),
// e affiliate_rate 10. Nada disso vinha de operação real — e o dashboard
// exibia "$1.250,50 disponíveis" como se a pessoa tivesse esse dinheiro.
//
// O usuário de teste agora nasce zerado. O rendimento dele é o que estiver
// na carteira dele, lido em /yield.html.

const USER = { username: 'demo', email: 'demo@nexora.local', password: 'Demo123!' };

let user = db.prepare('SELECT * FROM users WHERE username = ?').get(USER.username);
if (!user) {
  const hash = bcrypt.hashSync(USER.password, 10);
  const info = db.prepare(
    `INSERT INTO users (username, email, password_hash, referral_code, referred_by, affiliate_rate, is_admin)
     VALUES (?, ?, ?, ?, NULL, 0, 0)`
  ).run(USER.username, USER.email, hash, USER.username);
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  db.prepare(`INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'signup', 0, 'Conta de teste criada sem saldo')`).run(user.id);
  console.log('[demo] usuário criado (saldo zero):', USER.username, '/', USER.password);
} else {
  console.log('[demo] usuário já existe:', user.username);
  console.log('[demo] id=%s balance=%s active_deposit=%s', user.id, user.balance, user.active_deposit);
}
db.close();
