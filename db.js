// Shared DB layer using node-postgres (pg) against Supabase Postgres.
// Expose uma API parecida com a antiga (prepare/get/all/run/exec/transaction),
// mas ASSINCRONA (queries em Postgres sao async). Codigo antigo de SQLite muda
// apenas a fonte dos dados.
//
// Env:
//   DATABASE_URL = connection string Postgres do Supabase (obrigatorio)
//   PGSSL        = 'disable' para desligar SSL (ex.: supabase local via CLI)
//   PGPOOL_MAX   = tamanho do pool (default 5)

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const DATABASE_URL = process.env.DATABASE_URL || '';

// simulation_mode = '1' marca o ambiente como SIMULACAO. Nenhum valor de
// rendimento aqui vem de investimento: as taxas sao configuracao, nao mercado.
const DEFAULT_SETTINGS = {
  site_name: 'Nexora',
  primary_color: '#10b981',
  secondary_color: '#8b5cf6',
  hero_title: 'Planos de rendimento',
  support_telegram: 'https://t.me/nexora_suporte',
  simulation_mode: '0'
};

const SEED_PLANS = [
  { name: 'Nexora Start',      daily_rate: 0.5, duration_days: 1,  min_deposit: 10,     max_deposit: 999,    total_return_pct: 100.5, net_profit_pct: 0.5,  active: 1 },
  { name: 'Nexora Momentum',   daily_rate: 0.8, duration_days: 3,  min_deposit: 1000,   max_deposit: 4999,   total_return_pct: 102.4, net_profit_pct: 2.4,  active: 1 },
  { name: 'Nexora Pro',        daily_rate: 1.2, duration_days: 7,  min_deposit: 5000,   max_deposit: 9999,   total_return_pct: 108.4, net_profit_pct: 8.4,  active: 1 },
  { name: 'Nexora Elite',      daily_rate: 1.8, duration_days: 15, min_deposit: 10000,  max_deposit: 49999,  total_return_pct: 127.0, net_profit_pct: 27.0, active: 1 },
  { name: 'Nexora Sovereign',  daily_rate: 2.5, duration_days: 30, min_deposit: 50000,  max_deposit: 500000, total_return_pct: 175.0, net_profit_pct: 75.0, active: 1 }
];

const SEED_GATEWAYS = [
  { symbol: 'USDT', name: 'Tether',        network: 'USDT',   wallet_address: 'SIMULADO-NENHUMA-CARTEIRA-REAL', active: 1 },
  { symbol: 'SOL',  name: 'Solana',        network: 'SOLANA', wallet_address: 'SIMULADO-NENHUMA-CARTEIRA-REAL', active: 1 }
];

// ---------------------------------------------------------------------------
// Helpers de translacao SQLite -> Postgres
// ---------------------------------------------------------------------------

// Converte `?` em $1..$n respeitando literais de string '...'.
function rewritePlaceholders(sql, args) {
  if (!args || args.length === 0) return { sql, params: [] };
  const params = [];
  let out = '';
  let n = 0;
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inStr) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { out += sql[i + 1]; i++; continue; }
        inStr = false;
      }
      continue;
    }
    if (ch === "'") { inStr = true; out += ch; continue; }
    if (ch === '?') { n++; params.push(args[n - 1]); out += '$' + n; continue; }
    out += ch;
  }
  return { sql: out, params };
}

const normArg = (v) =>
  v === undefined ? null
    : typeof v === 'boolean' ? (v ? 1 : 0)
    : v;

// INSERT OR IGNORE (SQLite) nao existe no Postgres; vira ON CONFLICT DO NOTHING.
// INSERTs ganham RETURNING id SO quando a tabela tem coluna id (as queries que
// usam lastInsertRowid). Em settings a PK e `key`, entao nao ha id — o anexo
// e decidido olhando o `SCHEMA_SQL` definido mais abaixo.
function groomInsert(sql) {
  const trimmed = String(sql).trim();
  const orIgnore = /^INSERT\s+OR\s+IGNORE\s+INTO/i.test(trimmed);
  let s = orIgnore ? trimmed.replace(/^INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO') : trimmed;
  const isInsert = /^INSERT\s+INTO/i.test(s);
  if (isInsert && !/RETURNING/i.test(s)) {
    const tm = s.match(/^INSERT\s+INTO\s+(\w+)/i);
    const hasId = tm ? IDENTITY_TABLES.has(tm[1]) : true;
    if (hasId) {
      s = s + (orIgnore ? ' ON CONFLICT DO NOTHING' : '') + ' RETURNING id';
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function makeAdapter(poolOrClient) {
  async function query(sql, params) {
    return poolOrClient.query(sql, params || []);
  }
  return {
    async exec(sql) {
      if (sql == null || String(sql).trim() === '') return { changes: 0 };
      const r = await query(String(sql));
      return { changes: r && r.rowCount ? r.rowCount : 0 };
    },

    prepare(sql) {
      const gsql = groomInsert(sql);
      return {
        async get(...args) {
          const { sql: q, params } = rewritePlaceholders(gsql, args);
          const r = await query(q, params);
          return r.rows[0];
        },
        async all(...args) {
          const { sql: q, params } = rewritePlaceholders(gsql, args);
          const r = await query(q, params);
          return r.rows;
        },
        async run(...args) {
          const { sql: q, params } = rewritePlaceholders(gsql, args.map(normArg));
          const r = await query(q, params);
          return {
            lastInsertRowid: r.rows && r.rows[0] ? Number(r.rows[0].id) : 0,
            changes: r.rowCount || 0
          };
        }
      };
    },

    async transaction(fn) {
      if (typeof poolOrClient.connect !== 'function') {
        throw new Error('transaction requer um pool dedicado');
      }
      const client = await poolOrClient.connect();
      const tdb = makeAdapter({ query: (sql, params) => client.query(sql, params || []) });
      try {
        await client.query('BEGIN');
        const res = await fn(tdb);
        await client.query('COMMIT');
        return res;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw err;
      } finally {
        client.release();
      }
    }
  };
}

function buildPool() {
  if (!DATABASE_URL) {
    throw new Error('Defina DATABASE_URL (Supabase Postgres) para rodar o Nexora.');
  }
  const ssl = process.env.PGSSL === 'disable'
    ? false
    : { rejectUnauthorized: false };
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl,
    max: Number(process.env.PGPOOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000
  });
  pool.on('error', (err) => console.error('[pg] idle client error:', err.message));
  return pool;
}

// ---------------------------------------------------------------------------
// Schema + seeds
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  balance DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_earnings DOUBLE PRECISION NOT NULL DEFAULT 0,
  active_deposit DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_withdrawn DOUBLE PRECISION NOT NULL DEFAULT 0,
  pending_withdraw DOUBLE PRECISION NOT NULL DEFAULT 0,
  referral_code TEXT UNIQUE,
  referred_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  affiliate_rate DOUBLE PRECISION NOT NULL DEFAULT 10,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE TABLE IF NOT EXISTS plans (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  daily_rate DOUBLE PRECISION NOT NULL,
  duration_days INTEGER NOT NULL,
  min_deposit DOUBLE PRECISION NOT NULL,
  max_deposit DOUBLE PRECISION NOT NULL,
  total_return_pct DOUBLE PRECISION NOT NULL,
  net_profit_pct DOUBLE PRECISION NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS gateways (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  network TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS deposits (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id BIGINT REFERENCES plans(id) ON DELETE SET NULL,
  amount DOUBLE PRECISION NOT NULL,
  gateway_id BIGINT REFERENCES gateways(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','rejected')),
  tx_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DOUBLE PRECISION NOT NULL,
  gateway_id BIGINT REFERENCES gateways(id) ON DELETE SET NULL,
  wallet_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE TABLE IF NOT EXISTS transactions (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE TABLE IF NOT EXISTS positions (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deposit_id BIGINT REFERENCES deposits(id) ON DELETE SET NULL,
  plan_id BIGINT REFERENCES plans(id) ON DELETE SET NULL,
  plan_name TEXT NOT NULL,
  principal DOUBLE PRECISION NOT NULL,
  daily_rate DOUBLE PRECISION NOT NULL,
  duration_days INTEGER NOT NULL,
  days_paid INTEGER NOT NULL DEFAULT 0,
  accrued DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
  started_on TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD')),
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accruals (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  position_id BIGINT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  accrual_date TEXT NOT NULL,
  day_number INTEGER NOT NULL,
  principal DOUBLE PRECISION NOT NULL,
  rate DOUBLE PRECISION NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE(position_id, accrual_date)
);
CREATE TABLE IF NOT EXISTS company_results (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  result_date TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_referred ON users(referred_by);
CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_accruals_position ON accruals(position_id);
CREATE INDEX IF NOT EXISTS idx_company_results_date ON company_results(result_date);
`;

// Tabelas do SCHEMA_SQL que tem coluna `id` (identity) — unicas em que o
// groomInsert anexa RETURNING id.
const IDENTITY_TABLES = new Set();
for (const chunk of SCHEMA_SQL.split('CREATE TABLE').slice(1)) {
  const m = chunk.match(/^\s*(?:IF NOT EXISTS\s+)?(\w+)/);
  if (m && /\bid\s+BIGINT\s+GENERATED\s+BY\s+DEFAULT\s+AS\s+IDENTITY/i.test(chunk)) {
    IDENTITY_TABLES.add(m[1]);
  }
}

async function initDatabase(db) {
  await db.exec(SCHEMA_SQL);

  // Settings defaults (insert if missing)
  const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await setSetting.run(k, String(v));
  }

  // Seed plans if empty
  const planRow = await db.prepare('SELECT COUNT(*) AS c FROM plans').get();
  if (Number(planRow.c) === 0) {
    const ins = db.prepare(`INSERT INTO plans
      (name, daily_rate, duration_days, min_deposit, max_deposit, total_return_pct, net_profit_pct, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of SEED_PLANS) {
      await ins.run(p.name, p.daily_rate, p.duration_days, p.min_deposit, p.max_deposit, p.total_return_pct, p.net_profit_pct, p.active);
    }
  }

  // Seed gateways if empty
  const gwRow = await db.prepare('SELECT COUNT(*) AS c FROM gateways').get();
  if (Number(gwRow.c) === 0) {
    const ins = db.prepare('INSERT INTO gateways (symbol, name, network, wallet_address, active) VALUES (?, ?, ?, ?, ?)');
    for (const g of SEED_GATEWAYS) {
      await ins.run(g.symbol, g.name, g.network, g.wallet_address, g.active);
    }
  }

  // Seed admin if missing
  const admin = await db
    .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .get('admin', 'admin@nexora.local');
  if (!admin) {
    const hash = bcrypt.hashSync('Admin123!', 10);
    await db.prepare(`INSERT INTO users
      (username, email, password_hash, balance, total_earnings, active_deposit, total_withdrawn, pending_withdraw, referral_code, referred_by, affiliate_rate, is_admin)
      VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?, NULL, 10, 1)
      ON CONFLICT (username) DO NOTHING`)
      .run('admin', 'admin@nexora.local', hash, 'admin');
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _db = null;
let _pool = null;

async function getDb() {
  if (_db) return _db;
  if (!_pool) _pool = buildPool();
  const db = makeAdapter(_pool);
  await initDatabase(db);
  _db = db;
  return db;
}

async function closeDb() {
  if (_pool) await _pool.end();
  _db = null;
  _pool = null;
}

module.exports = {
  DATABASE_URL,
  DEFAULT_SETTINGS,
  initDatabase,
  getDb,
  closeDb
};