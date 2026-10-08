// Shared DB init logic used by server.js and init-db.js
// Usa node:sqlite nativo (sem compilação, funciona no Windows)
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'nexora.db');

// simulation_mode = '1' marca o ambiente como SIMULACAO. Nenhum valor de
// rendimento aqui vem de investimento: as taxas sao configuracao, nao mercado.
// A UI le este flag e exibe o aviso; enquanto for '1', nada de rendimento
// deve ser apresentado como ganho real.
const DEFAULT_SETTINGS = {
  site_name: 'Nexora',
  primary_color: '#10b981',
  secondary_color: '#8b5cf6',
  hero_title: 'Planos de rendimento',
  support_telegram: 'https://t.me/nexora_suporte',
  simulation_mode: '0'
  // Nao existe "total_invested" / "running_days" aqui: /api/public/stats
  // calcula os totais a partir dos registros reais do banco.
};

// Planos de demonstracao. As taxas sao CHAMADAS DE CONFIGURACAO, nao
// rentabilidad: nenhuma operacao de mercado entrega 2.5% AO DIA de forma
// sustentada. While simulation_mode = '1' a interface rotula todo valor
// derivado daqui como simulacao.
const SEED_PLANS = [
  { name: 'Nexora Start',      daily_rate: 0.5, duration_days: 1,  min_deposit: 10,     max_deposit: 999,    total_return_pct: 100.5, net_profit_pct: 0.5,  active: 1 },
  { name: 'Nexora Momentum',   daily_rate: 0.8, duration_days: 3,  min_deposit: 1000,   max_deposit: 4999,   total_return_pct: 102.4, net_profit_pct: 2.4,  active: 1 },
  { name: 'Nexora Pro',        daily_rate: 1.2, duration_days: 7,  min_deposit: 5000,   max_deposit: 9999,   total_return_pct: 108.4, net_profit_pct: 8.4,  active: 1 },
  { name: 'Nexora Elite',      daily_rate: 1.8, duration_days: 15, min_deposit: 10000,  max_deposit: 49999,  total_return_pct: 127.0, net_profit_pct: 27.0, active: 1 },
  { name: 'Nexora Sovereign',  daily_rate: 2.5, duration_days: 30, min_deposit: 50000,  max_deposit: 500000, total_return_pct: 175.0, net_profit_pct: 75.0, active: 1 }
];

// Gateways de demonstracao. Os enderecos abaixo sao PLACEHOLDER: nao existe
// chave-controls-values que_ixar, entao um deposito real enviado para eles
// seria perdido sem resgate. Isso e aceitavel enquanto simulation_mode = '1'
// (ambiente de teste local). Antes de qualquer uso com dinheiro de terceiro,
// trocar por enderecos que a plataforma realmente controle — ou remover.
//
// Redes abaixo sao apenas o que o schema antigo guardava; o produto nao faz
// saque on-chain em nenhuma delas.
const SEED_GATEWAYS = [
  { symbol: 'USDT', name: 'Tether',        network: 'USDT',   wallet_address: 'SIMULADO-NENHUMA-CARTEIRA-REAL', active: 1 },
  { symbol: 'SOL',  name: 'Solana',        network: 'SOLANA', wallet_address: 'SIMULADO-NENHUMA-CARTEIRA-REAL', active: 1 }
];

function ensureCompat(db) {
  if (!db.pragma) {
    db.pragma = (s) => db.exec(`PRAGMA ${s}`);
  }
  if (!db.transaction) {
    db.transaction = (fn) => (...args) => {
      db.exec('BEGIN');
      try {
        const r = fn(...args);
        db.exec('COMMIT');
        return r;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw e;
      }
    };
  }
  return db;
}

function initDatabase(db) {
  ensureCompat(db);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      total_earnings REAL NOT NULL DEFAULT 0,
      active_deposit REAL NOT NULL DEFAULT 0,
      total_withdrawn REAL NOT NULL DEFAULT 0,
      pending_withdraw REAL NOT NULL DEFAULT 0,
      referral_code TEXT UNIQUE,
      referred_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      affiliate_rate REAL NOT NULL DEFAULT 10,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      daily_rate REAL NOT NULL,
      duration_days INTEGER NOT NULL,
      min_deposit REAL NOT NULL,
      max_deposit REAL NOT NULL,
      total_return_pct REAL NOT NULL,
      net_profit_pct REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS gateways (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      network TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
      amount REAL NOT NULL,
      gateway_id INTEGER REFERENCES gateways(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','rejected')),
      tx_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      gateway_id INTEGER REFERENCES gateways(id) ON DELETE SET NULL,
      wallet_to TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Posicao aberta por um deposito ativo. daily_rate e duration_days sao
    -- COPIADOS do plano no momento da ativacao, para que editar o plano
    -- depois nao reescreva o historico de quem ja investiu.
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      deposit_id INTEGER REFERENCES deposits(id) ON DELETE SET NULL,
      plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
      plan_name TEXT NOT NULL,
      principal REAL NOT NULL,
      daily_rate REAL NOT NULL,
      duration_days INTEGER NOT NULL,
      days_paid INTEGER NOT NULL DEFAULT 0,
      accrued REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
      started_on TEXT NOT NULL DEFAULT (date('now')),
      closed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Registro dia a dia do que foi creditado por posicao.
    -- Um accrue por (position_id, accrual_date) torna o motor idempotente:
    -- reexecutar no mesmo dia nao credita duas vezes.
    CREATE TABLE IF NOT EXISTS accruals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
      accrual_date TEXT NOT NULL,
      day_number INTEGER NOT NULL,
      principal REAL NOT NULL,
      rate REAL NOT NULL,
      amount REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(position_id, accrual_date)
    );
    -- Resultado que a PROPRIA plataforma lanca das aplicacoes dela (stake,
    -- pool, vault etc). E Lancamento manual do admin: nao e calculado e nao
    -- representa rendimento do usuario.
    CREATE TABLE IF NOT EXISTS company_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      result_date TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id);
    CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
    CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_referred ON users(referred_by);
    CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_accruals_position ON accruals(position_id);
    CREATE INDEX IF NOT EXISTS idx_company_results_date ON company_results(result_date);
  `);

  // Settings defaults (insert if missing)
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING');
  const txnSettings = db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      if (!getSetting.get(k)) setSetting.run(k, String(v));
    }
  });
  txnSettings();

  // Seed plans if empty
  const planCount = db.prepare('SELECT COUNT(*) AS c FROM plans').get().c;
  if (planCount === 0) {
    const ins = db.prepare(`INSERT INTO plans
      (name, daily_rate, duration_days, min_deposit, max_deposit, total_return_pct, net_profit_pct, active)
      VALUES (@name, @daily_rate, @duration_days, @min_deposit, @max_deposit, @total_return_pct, @net_profit_pct, @active)`);
    const t = db.transaction(() => { for (const p of SEED_PLANS) ins.run(p); });
    t();
  }

  // Seed gateways if empty
  const gwCount = db.prepare('SELECT COUNT(*) AS c FROM gateways').get().c;
  if (gwCount === 0) {
    const ins = db.prepare(`INSERT INTO gateways (symbol, name, network, wallet_address, active)
      VALUES (@symbol, @name, @network, @wallet_address, @active)`);
    const t = db.transaction(() => { for (const g of SEED_GATEWAYS) ins.run(g); });
    t();
  }

  // Seed admin if missing
  const admin = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get('admin', 'admin@nexora.local');
  if (!admin) {
    const hash = bcrypt.hashSync('Admin123!', 10);
    db.prepare(`INSERT INTO users
      (username, email, password_hash, balance, total_earnings, active_deposit, total_withdrawn, pending_withdraw, referral_code, referred_by, affiliate_rate, is_admin)
      VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?, NULL, 10, 1)`).run('admin', 'admin@nexora.local', hash, 'admin');
  }
}

module.exports = { DB_PATH, DEFAULT_SETTINGS, initDatabase, ensureCompat };
