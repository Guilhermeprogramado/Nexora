const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { getDb } = require('./db');
const accrual = require('./accrual');
const solana = require('./solana');

const JWT_SECRET = process.env.JWT_SECRET || 'nexora-dev-secret-change-me';
const PORT = process.env.PORT || 3000;
const CMC_API_KEY = process.env.CMC_API_KEY || '';
const CMC_BASE_URL = 'https://pro-api.coinmarketcap.com/v1';
const CMC_CACHE_TTL = 60000;

let cmcCache = { data: null, timestamp: 0 };

// Conexao com o banco e lazy: em serverless, cada instancia so conecta
// quando a primeira requisicao chega (ver ensureDb no middleware abaixo).
let db = null;
async function ensureDb() {
  if (!db) db = await getDb();
  return db;
}

const app = express();

// Test endpoint at very top (before any middleware)
app.get('/api/ping', async (req, res) => res.json({ ok: true, time: Date.now() }));

// Diagnostico rapido do banco (antes do middleware que devolve 500 generico).
// Devolve SEMPRE 200 com ok:false em caso de erro, para o corpo ser legivel.
app.get('/api/-/db-check', async (req, res) => {
  try {
    await ensureDb();
    const row = await db.prepare('SELECT 1 AS ok').get();
    let host = 'n/a';
    const m = String(process.env.DATABASE_URL || '').match(/@([^/:]+)/);
    if (m) host = m[1];
    return res.json({ ok: true, env_set: !!process.env.DATABASE_URL, host, select: row.ok });
  } catch (err) {
    return res.json({
      ok: false,
      env_set: !!process.env.DATABASE_URL,
      error: String(err && err.message || err),
      first_lines: String(err && err.stack || '').split('\n').slice(0, 4).join(' | ')
    });
  }
});

app.use(cors());
app.use(express.json({ limit: '256kb' }));

// Garante que o banco esta pronto antes de qualquer rota usar `db`.
app.use(async (req, res, next) => {
  try {
    await ensureDb();
    next();
  } catch (err) {
    console.error('[db] falha ao inicializar:', err);
    return res.status(500).json({
      error: 'Falha ao inicializar o banco de dados.',
      detail: String(err && err.message || err)
    });
  }
});

// Static
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
app.use(express.static(publicDir));

// Simple request log
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// Rate limit for auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' }
});

// ---------- helpers ----------
function sanitizeUser(u) {
  if (!u) return null;
  const {
    password_hash, // eslint-disable-line no-unused-vars
    ...safe
  } = u;
  return safe;
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, is_admin: user.is_admin ? 1 : 0 },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
    return res.status(401).json({ error: 'Token ausente. Faca login.' });
  }
  try {
    const payload = jwt.verify(parts[1], JWT_SECRET);
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.status(401).json({ error: 'Usuario nao encontrado.' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token invalido ou expirado.' });
  }
}

function adminRequired(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  }
  next();
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isValidUsername(username) {
  return typeof username === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(username.trim());
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// simulation_mode = '1' -> os planos e o accrue sao demonstracao.
// Enquanto for '1', nenhuma resposta de rendimento pode ser lida como lucro.
async function isSimulation() {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'simulation_mode'").get();
    if (!row) return false;
    const v = String(row.value).trim();
    return v === '1' || v.toLowerCase() === 'true' || v === 'on';
  } catch (err) {
    return false;
  }
}

function maskUsername(name) {
  if (!name || typeof name !== 'string') return 'Us***o';
  if (name.length <= 3) return name[0] + '***';
  return name.slice(0, 2) + '***' + name.slice(-1);
}

async function getSettingsObject() {
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return obj;
}

// ---------- public auth ----------
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try {
    const { username, email, password, ref } = req.body || {};
    const u = (username || '').trim();
    const e = (email || '').trim().toLowerCase();
    const p = password || '';

    if (!isValidUsername(u)) {
      return res.status(400).json({ error: 'Username invalido (3-20 chars, letras/numeros/_).' });
    }
    if (!isValidEmail(e)) {
      return res.status(400).json({ error: 'Email invalido.' });
    }
    if (typeof p !== 'string' || p.length < 6) {
      return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres.' });
    }

    const exists = await db
      .prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)')
      .get(u, e);
    if (exists) {
      return res.status(400).json({ error: 'Username ou email ja cadastrado.' });
    }

    let referredBy = null;
    if (ref) {
      const refCode = String(ref).trim();
      if (refCode) {
        const referrer = await db.prepare('SELECT id FROM users WHERE referral_code = ?').get(refCode);
        if (!referrer) {
          return res.status(400).json({ error: 'Codigo de indicacao invalido.' });
        }
        referredBy = referrer.id;
      }
    }

    const hash = bcrypt.hashSync(p, 10);
    const info = await db
      .prepare(`INSERT INTO users (username, email, password_hash, referral_code, referred_by, affiliate_rate)
                VALUES (?, ?, ?, ?, ?, 10)`)
      .run(u, e, hash, u, referredBy);
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    await db.prepare(`INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'signup', 0, 'Conta criada')`)
      .run(user.id);

    const token = signToken(user);
    return res.status(201).json({ token, user: sanitizeUser(user) });
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'Username ou email ja cadastrado.' });
    }
    console.error('signup error:', err);
    return res.status(500).json({ error: 'Erro interno ao criar conta.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { login, password } = req.body || {};
    if (!login || !password) {
      return res.status(400).json({ error: 'Informe login e senha.' });
    }
    const l = String(login).trim();
    const user = await db
      .prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)')
      .get(l, l.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: 'Credenciais invalidas.' });
    }
    const ok = bcrypt.compareSync(String(password), user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Credenciais invalidas.' });
    }
    const token = signToken(user);
    return res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ error: 'Erro interno ao autenticar.' });
  }
});

// ---------- public data ----------
app.get('/api/public/settings', async (req, res) => {
  try {
    return res.json(await getSettingsObject());
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao carregar configuracoes.' });
  }
});

// Planos em modo simulacao. Cada item ganha `simulated: true` e a taxa
// efetiva do periodo para o front poder rotular em vez de prometer.
app.get('/api/public/plans', async (req, res) => {
  try {
    const sim = await isSimulation();
    const rows = await db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY min_deposit ASC').all();
    return res.json(rows.map((p) => {
      const daily = Number(p.daily_rate) || 0;
      const days = parseInt(p.duration_days, 10) || 0;
      const perDayMin = accrual.round2(Number(p.min_deposit) * (daily / 100));
      const perDayMax = accrual.round2(Number(p.max_deposit) * (daily / 100));
      return {
        ...p,
        simulated: sim,
        daily_amount_at_min: perDayMin,
        gross_at_min: accrual.round2(perDayMin * days),
        daily_amount_at_max: perDayMax,
        gross_at_max: accrual.round2(perDayMax * days),
        interest: 'simples (sem capitalizacao)'
      };
    }));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao carregar planos.' });
  }
});

app.get('/api/public/gateways', async (req, res) => {
  try {
    const rows = await db.prepare('SELECT * FROM gateways WHERE active = 1 ORDER BY id ASC').all();
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao carregar gateways.' });
  }
});

app.get('/api/public/stats', async (req, res) => {
  try {
    // Totais CALCULADOS do banco. As versoes anteriores liam
    // settings.total_invested / running_days, que eram valores fixos inventados
    // publicados como prova social ("$4.2M investidos, 63 dias").
    const agg = await db
      .prepare(`SELECT
                  (SELECT COALESCE(SUM(amount), 0) FROM deposits WHERE status = 'active') AS total_active,
                  (SELECT COALESCE(SUM(amount), 0) FROM withdrawals WHERE status = 'approved') AS total_paid,
                  (SELECT COUNT(*) FROM users) AS user_count`)
      .get();
    const first = await db
      .prepare(`SELECT MIN(t) AS t FROM (
                  SELECT MIN(created_at) AS t FROM deposits
                  UNION ALL SELECT MIN(created_at) FROM withdrawals
                  UNION ALL SELECT MIN(created_at) FROM users)`)
      .get();
    const running_days = first && first.t
      ? Math.max(0, Math.floor((Date.now() - new Date(first.t).getTime()) / 86400000))
      : 0;

    const realDeps = await db
      .prepare(`SELECT d.amount, d.created_at, u.username
                FROM deposits d JOIN users u ON u.id = d.user_id
                WHERE d.status = 'active' ORDER BY d.id DESC LIMIT 5`)
      .all();
    const realWds = await db
      .prepare(`SELECT w.amount, w.created_at, u.username
                FROM withdrawals w JOIN users u ON u.id = w.user_id
                WHERE w.status = 'approved' ORDER BY w.id DESC LIMIT 5`)
      .all();

    // Somente movimento real do banco. Nada e gerado ou preenchido com
    // nomes/valores ficticios: se nao houve deposito, a lista fica vazia.
    const recent_deposits = realDeps.map((d) => ({
      user: maskUsername(d.username),
      amount: d.amount,
      time: d.created_at
    }));
    const recent_withdrawals = realWds.map((w) => ({
      user: maskUsername(w.username),
      amount: w.amount,
      time: w.created_at
    }));

    return res.json({
      simulated: await isSimulation(),
      total_invested: agg.total_active,
      total_paid: agg.total_paid,
      user_count: agg.user_count,
      running_days,
      recent_deposits,
      recent_withdrawals
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao carregar estatisticas.' });
  }
});

async function fetchCMCData() {
  const now = Date.now();
  if (cmcCache.data && (now - cmcCache.timestamp) < CMC_CACHE_TTL) {
    return cmcCache.data;
  }

  try {
    const symbols = 'BTC,ETH,SOL,XRP,BCH,BNB,LTC,DOGE,TRX,USDT';
    const url = `${CMC_BASE_URL}/cryptocurrency/quotes/latest?symbol=${symbols}&convert=USD`;
    const response = await fetch(url, {
      headers: {
        'X-CMC_PRO_API_KEY': CMC_API_KEY,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`CMC API error: ${response.status}`);
    }

    const data = await response.json();
    cmcCache = { data, timestamp: now };
    return data;
  } catch (err) {
    console.error('CoinMarketCap API error:', err.message);
    return null;
  }
}

function normalizeCMCData(data) {
  if (!data || !data.data) return null;
  
  const symbolMap = {
    'BTC': { name: 'Bitcoin', color: '#f7931a' },
    'ETH': { name: 'Ethereum', color: '#627eea' },
    'SOL': { name: 'Solana', color: '#9945ff' },
    'XRP': { name: 'Ripple', color: '#25a4e8' },
    'BCH': { name: 'Bitcoin Cash', color: '#8dc351' },
    'BNB': { name: 'BNB', color: '#f3ba2f' },
    'LTC': { name: 'Litecoin', color: '#bfbbbb' },
    'DOGE': { name: 'Dogecoin', color: '#c2a633' },
    'TRX': { name: 'Tron', color: '#ff060a' },
    'USDT': { name: 'Tether', color: '#26a17b' }
  };

  const results = [];
  for (const [symbol, info] of Object.entries(data.data)) {
    const quote = info.quote?.USD;
    if (!quote) continue;
    
    const meta = symbolMap[symbol] || { name: symbol, color: '#8b5cf6' };
    const logoUrl = `https://s2.coinmarketcap.com/static/img/coins/64x64/${info.id}.png`;
    
    results.push({
      symbol,
      name: meta.name,
      price: quote.price,
      change24h: quote.percent_change_24h,
      color: meta.color,
      logo: logoUrl,
      updated_at: new Date().toISOString()
    });
  }
  return results;
}

app.get('/api/crypto/prices', async (req, res) => {
  try {
    const cmcData = await fetchCMCData();
    const prices = cmcData ? normalizeCMCData(cmcData) : null;

    // Sem API key / sem resposta, devolvemos lista vazia em vez de preco inventado.
    // O front exibe "preco indisponivel" -- nunca um numero fixo com variação aleatoria.
    return res.json({
      prices: prices || [],
      stale: !prices || !prices.length,
      updated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error in /api/crypto/prices:', err);
    return res.status(500).json({ prices: [], stale: true, error: 'Erro ao buscar preços.' });
  }
});

// ---------- user (auth) ----------
app.get('/api/me', authRequired, async (req, res) => {
  try {
    const out = sanitizeUser(req.user);
    out.simulated = await isSimulation();
    // Saca so quem ja investiu em um plano. O flag viaja na resposta para a
    // UI mostrar o bloqueio antes do usuario preencher o formulario.
    out.has_investment = !!(await db
      .prepare('SELECT 1 AS ok FROM positions WHERE user_id = ? LIMIT 1')
      .get(req.user.id));
    return res.json(out);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao carregar perfil.' });
  }
});

// Posicoes do usuario com projecao ate hoje. `simulated` viaja junto para a
// UI rotular cada valor.
app.get('/api/my/positions', authRequired, async (req, res) => {
  try {
    const rows = await db.prepare('SELECT * FROM positions WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
    const sim = await isSimulation();
    return res.json({
      simulated: sim,
      positions: rows.map((p) => ({ ...p, ...accrual.projectPosition(p) }))
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao carregar posicoes.' });
  }
});

// Extrato dia a dia do accrue. `earned_until` e a soma dos creditos da conta
// ate aquela linha (janela sobre TODAS as linhas, depois limita a 200) —
// a coluna "saldo depois" antes viria undefined e renderizava $0.00.
app.get('/api/my/accruals', authRequired, async (req, res) => {
  try {
    const rows = await db
      .prepare(`SELECT * FROM (
                  SELECT a.*, p.plan_name,
                         SUM(a.amount) OVER (
                           PARTITION BY p.user_id
                           ORDER BY a.accrual_date, a.id
                           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                         ) AS earned_until
                  FROM accruals a
                  JOIN positions p ON p.id = a.position_id
                  WHERE p.user_id = ?
                ) ORDER BY accrual_date DESC, id DESC LIMIT 200`)
      .all(req.user.id);
    return res.json({ simulated: await isSimulation(), accruals: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao carregar extrato.' });
  }
});

app.put('/api/me', authRequired, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Informe o email.' });
    const e = String(email).trim().toLowerCase();
    if (!isValidEmail(e)) return res.status(400).json({ error: 'Email invalido.' });
    const exists = await db
      .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?')
      .get(e, req.user.id);
    if (exists) return res.status(400).json({ error: 'Email ja em uso.' });
    await db.prepare('UPDATE users SET email = ? WHERE id = ?').run(e, req.user.id);
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    return res.json(sanitizeUser(user));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao atualizar perfil.' });
  }
});

app.post('/api/me/change-password', authRequired, async (req, res) => {
  try {
    const body = req.body || {};
    const current = body.currentPassword || body.current_password || body.current || '';
    const next = body.newPassword || body.new_password || body.password || '';
    if (!current || !next) {
      return res.status(400).json({ error: 'Informe senha atual e nova senha.' });
    }
    if (String(next).length < 6) {
      return res.status(400).json({ error: 'Nova senha deve ter ao menos 6 caracteres.' });
    }
    const fresh = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(String(current), fresh.password_hash)) {
      return res.status(400).json({ error: 'Senha atual incorreta.' });
    }
    const hash = bcrypt.hashSync(String(next), 10);
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao trocar senha.' });
  }
});

app.get('/api/my/deposits', authRequired, async (req, res) => {
  try {
    const rows = await db
      .prepare(`SELECT d.*, p.name AS plan_name, g.symbol AS gateway_symbol
                FROM deposits d
                LEFT JOIN plans p ON p.id = d.plan_id
                LEFT JOIN gateways g ON g.id = d.gateway_id
                WHERE d.user_id = ? ORDER BY d.id DESC LIMIT 200`)
      .all(req.user.id);
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao listar depositos.' });
  }
});

app.post('/api/my/deposits', authRequired, async (req, res) => {
  try {
    const { plan_id, amount, gateway_id, tx_hash } = req.body || {};
    const gwId = parseInt(gateway_id, 10);
    const amt = toNum(amount);
    // plan_id opcional: COM plano = depósito para investir; SEM plano = adição de saldo (top-up via Carteira)
    let plan = null;
    let planId = null;
    if (plan_id !== undefined && plan_id !== null && String(plan_id).trim() !== '') {
      planId = parseInt(plan_id, 10);
      if (!Number.isInteger(planId) || planId <= 0) {
        return res.status(400).json({ error: 'Plano invalido.' });
      }
      plan = await db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
      if (!plan || !plan.active) {
        return res.status(400).json({ error: 'Plano indisponivel.' });
      }
      if (amt < plan.min_deposit || amt > plan.max_deposit) {
        return res.status(400).json({
          error: `Valor deve estar entre ${plan.min_deposit} e ${plan.max_deposit}.`
        });
      }
    }
    if (!Number.isInteger(gwId) || gwId <= 0) {
      return res.status(400).json({ error: 'Gateway invalido.' });
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Valor invalido.' });
    }
    const gw = await db.prepare('SELECT * FROM gateways WHERE id = ?').get(gwId);
    if (!gw || !gw.active) {
      return res.status(400).json({ error: 'Gateway indisponivel.' });
    }
    const tx = tx_hash ? String(tx_hash).trim().slice(0, 200) : null;
    if (!plan && !tx) {
      return res.status(400).json({ error: 'Informe o hash da transferência para validação do saldo.' });
    }

    const info = await db
      .prepare(`INSERT INTO deposits (user_id, plan_id, amount, gateway_id, status, tx_hash)
                VALUES (?, ?, ?, ?, 'pending', ?)`)
      .run(req.user.id, planId, amt, gwId, tx);
    await db.prepare(`INSERT INTO transactions (user_id, type, amount, detail)
                VALUES (?, 'deposit_pending', ?, ?)`)
      .run(req.user.id, amt, plan
        ? `Deposito #${info.lastInsertRowid} pendente (${plan.name}/${gw.symbol})`
        : `Adicao de saldo #${info.lastInsertRowid} pendente (${gw.symbol}) — hash ${tx}`);
    const dep = await db.prepare('SELECT * FROM deposits WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json(dep);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao criar deposito.' });
  }
});

// "Investir" em um plano foi removido.
//
// O endpoint debitava o saldo interno do usuário e marcava o valor como
// "active_deposit" contra uma linha de `plans` — sem nenhuma transferência on-chain
// e sem nenhum contrato que pagasse rendimento. Era um número se movendo no banco.
//
// Rendimento real exige assinar a transação na própria carteira, direto no
// protocolo. Até isso existir, a rota recusa explicitamente em vez de simular.
app.post('/api/my/invest', authRequired, async (req, res) => {
  return res.status(410).json({
    error:
      'Investimento em plano nao existe mais. A Nexora nao opera planos nem recebe deposito. ' +
      'Para rendimento real, use o painel on-chain (/yield.html) e assine a transacao no Jito ou na Kamino com sua carteira.'
  });
});

app.get('/api/my/withdrawals', authRequired, async (req, res) => {
  try {
    const rows = await db
      .prepare(`SELECT w.*, g.symbol AS gateway_symbol
                FROM withdrawals w LEFT JOIN gateways g ON g.id = w.gateway_id
                WHERE w.user_id = ? ORDER BY w.id DESC LIMIT 200`)
      .all(req.user.id);
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao listar saques.' });
  }
});

app.post('/api/my/withdrawals', authRequired, async (req, res) => {
  try {
    const { amount, gateway_id, wallet_to } = req.body || {};
    const amt = toNum(amount);
    const gwId = parseInt(gateway_id, 10);
    const wallet = wallet_to ? String(wallet_to).trim() : '';
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Valor invalido.' });
    }
    if (amt < 10) {
      return res.status(400).json({ error: 'Saque minimo de 10.' });
    }
    if (!Number.isInteger(gwId) || gwId <= 0) {
      return res.status(400).json({ error: 'Gateway invalido.' });
    }
    if (!wallet || wallet.length < 5 || wallet.length > 200) {
      return res.status(400).json({ error: 'Carteira de destino invalida.' });
    }
    const gw = await db.prepare('SELECT * FROM gateways WHERE id = ?').get(gwId);
    if (!gw || !gw.active) {
      return res.status(400).json({ error: 'Gateway indisponivel.' });
    }
    const fresh = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const available = (fresh.balance || 0) - (fresh.pending_withdraw || 0);
    if (amt > available) {
      return res.status(400).json({ error: 'Saldo insuficiente.' });
    }
    // Regra do produto: so saca quem ja investiu em um plano. Sem posicao
    // (aberta ou encerrada) nao ha origem de rendimento para resgatar.
    const invested = await db
      .prepare('SELECT 1 AS ok FROM positions WHERE user_id = ? LIMIT 1')
      .get(req.user.id);
    if (!invested) {
      return res.status(403).json({
        error: 'Saque liberado apos investir em um plano. Invista primeiro em "Investir em Plano".'
      });
    }
    const doTx = db.transaction(async (tdb) => {
      const info = await tdb
        .prepare(`INSERT INTO withdrawals (user_id, amount, gateway_id, wallet_to, status)
                  VALUES (?, ?, ?, ?, 'pending')`)
        .run(req.user.id, amt, gwId, wallet);
      await tdb.prepare('UPDATE users SET pending_withdraw = pending_withdraw + ? WHERE id = ?')
        .run(amt, req.user.id);
      await tdb.prepare(`INSERT INTO transactions (user_id, type, amount, detail)
                  VALUES (?, 'withdraw_pending', ?, ?)`)
        .run(req.user.id, amt, `Saque #${info.lastInsertRowid} solicitado (${gw.symbol})`);
      return info.lastInsertRowid;
    });
    const id = await doTx;
    const wd = await db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    return res.status(201).json(wd);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao solicitar saque.' });
  }
});

app.get('/api/my/transactions', authRequired, async (req, res) => {
  try {
    const rows = await db
      .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100')
      .all(req.user.id);
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao listar transacoes.' });
  }
});

app.get('/api/my/referrals', authRequired, async (req, res) => {
  try {
    const me = await db.prepare('SELECT referral_code FROM users WHERE id = ?').get(req.user.id);
    const list = await db
      .prepare('SELECT id, username, email, created_at FROM users WHERE referred_by = ? ORDER BY id DESC')
      .all(req.user.id);
    const host = req.get('host');
    const proto = req.protocol;
    const link = `${proto}://${host}/?ref=${me.referral_code}`;
    // total_rewards = 0: o bônus por recrutar depósito foi removido (pirâmide).
    // O campo permanece no contrato da API para o front não quebrar.
    return res.json({
      referral_code: me.referral_code,
      referral_link: link,
      total_referrals: list.length,
      total_rewards: 0,
      referrals: list
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao listar indicacoes.' });
  }
});

// ---------- admin ----------
app.get('/api/admin/users', authRequired, adminRequired, async (req, res) => {
  try {
    const rows = await db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 500').all();
    return res.json(rows.map(sanitizeUser));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao listar usuarios.' });
  }
});

app.put('/api/admin/users/:id', authRequired, adminRequired, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID invalido.' });
    const target = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'Usuario nao encontrado.' });
    const b = req.body || {};
    const fields = {};
    if (b.balance !== undefined) {
      const n = toNum(b.balance);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'balance invalido.' });
      fields.balance = n;
    }
    if (b.total_earnings !== undefined) {
      const n = toNum(b.total_earnings);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'total_earnings invalido.' });
      fields.total_earnings = n;
    }
    if (b.active_deposit !== undefined) {
      const n = toNum(b.active_deposit);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'active_deposit invalido.' });
      fields.active_deposit = n;
    }
    if (b.total_withdrawn !== undefined) {
      const n = toNum(b.total_withdrawn);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'total_withdrawn invalido.' });
      fields.total_withdrawn = n;
    }
    if (b.pending_withdraw !== undefined) {
      const n = toNum(b.pending_withdraw);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'pending_withdraw invalido.' });
      fields.pending_withdraw = n;
    }
    if (b.is_admin !== undefined) {
      const n = Number(b.is_admin) ? 1 : 0;
      fields.is_admin = n;
    }
    if (b.affiliate_rate !== undefined) {
      const n = toNum(b.affiliate_rate);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({ error: 'affiliate_rate deve estar entre 0 e 100.' });
      }
      fields.affiliate_rate = n;
    }
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.status(400).json({ error: 'Nenhum campo valido para atualizar.' });
    const setClause = keys.map((k) => `${k} = ?`).join(', ');
    await db.prepare(`UPDATE users SET ${setClause} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return res.json(sanitizeUser(updated));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao atualizar usuario.' });
  }
});

app.delete('/api/admin/users/:id', authRequired, adminRequired, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID invalido.' });
    if (id === req.user.id) return res.status(400).json({ error: 'Você não pode excluir sua própria conta de administrador.' });
    const target = await db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'Usuario nao encontrado.' });
    // CASCADE limpa deposits/withdrawals/transactions; referred_by vira NULL
    await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return res.json({ ok: true, deleted: target.username });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao excluir usuario.' });
  }
});

app.get('/api/admin/deposits', authRequired, adminRequired, async (req, res) => {
  try {
    const rows = await db
      .prepare(`SELECT d.*, u.username, p.name AS plan_name, g.symbol AS gateway_symbol
                FROM deposits d
                LEFT JOIN users u ON u.id = d.user_id
                LEFT JOIN plans p ON p.id = d.plan_id
                LEFT JOIN gateways g ON g.id = d.gateway_id
                ORDER BY d.id DESC LIMIT 200`)
      .all();
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao listar depositos.' });
  }
});

app.put('/api/admin/deposits/:id', authRequired, adminRequired, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body || {};
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID invalido.' });
    if (!['pending', 'active', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status invalido (pending/active/rejected).' });
    }
    const dep = await db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
    if (!dep) return res.status(404).json({ error: 'Deposito nao encontrado.' });
    if (dep.status === status) {
      return res.json(await db.prepare('SELECT * FROM deposits WHERE id = ?').get(id));
    }
    const prev = dep.status;
const apply = db.transaction(async (tdb) => {
      await tdb.prepare('UPDATE deposits SET status = ? WHERE id = ?').run(status, id);
      const user = await tdb.prepare('SELECT * FROM users WHERE id = ?').get(dep.user_id);
      if (!user) return;
      if (prev !== 'active' && status === 'active') {
        if (dep.plan_id) {
          await tdb.prepare('UPDATE users SET active_deposit = active_deposit + ? WHERE id = ?')
            .run(dep.amount, dep.user_id);
          await tdb.prepare(`INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'deposit_approved', ?, ?)`)
            .run(dep.user_id, dep.amount, `Deposito #${id} ativado`);
          // Abre a posicao: e ela que o accrue.js credita todo dia.
          // A taxa e a duracao sao copiadas daqui, entao editar o plano depois
          // nao muda o que ja foi prometido a quem investiu.
          const plan = await tdb.prepare('SELECT * FROM plans WHERE id = ?').get(dep.plan_id);
          if (plan) {
            try {
              await accrual.openPosition(tdb, {
                userId: dep.user_id,
                depositId: id,
                planId: plan.id,
                principal: dep.amount,
                rate: plan.daily_rate,
                durationDays: plan.duration_days,
                planName: plan.name
              });
            } catch (e) {
              // Falha ao abrir posicao nao pode perder o deposito aprovado:
              // reverte tudo para o estado anterior.
              throw new Error('Falha ao abrir posicao: ' + e.message);
            }
          } else {
            console.warn('[deposit #' + id + '] plan_id ' + dep.plan_id + ' nao existe; sem accrue.');
          }
        } else {
          // Top-up (sem plano): hash validado -> credita SALDO (não depósito ativo)
          await tdb.prepare('UPDATE users SET balance = balance + ? WHERE id = ?')
            .run(dep.amount, dep.user_id);
          await tdb.prepare(`INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'topup_approved', ?, ?)`)
            .run(dep.user_id, dep.amount, `Adicao de saldo #${id} validada (hash confirmado)`);
        }

        // Comissão de afiliado: 5% do PRIMEIRO depósito do usuário indicado
        // Só paga se o usuário foi indicado (referred_by) e este é seu primeiro depósito aprovado
        const referred = await tdb.prepare('SELECT * FROM users WHERE id = ?').get(dep.user_id);
        if (referred && referred.referred_by) {
          const firstDeposit = await tdb.prepare(`
            SELECT COUNT(*) as cnt FROM deposits
            WHERE user_id = ? AND status = 'active'
          `).get(dep.user_id);
          if (firstDeposit && Number(firstDeposit.cnt) === 1) {
            const referrer = await tdb.prepare('SELECT * FROM users WHERE id = ?').get(referred.referred_by);
            if (referrer) {
              const commission = Number(dep.amount) * 0.05;
              await tdb.prepare('UPDATE users SET balance = balance + ? WHERE id = ?')
                .run(commission, referrer.id);
              await tdb.prepare(`INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'referral_commission', ?, ?)`)
                .run(referrer.id, commission, `Comissão 5% do 1º depósito do usuário #${dep.user_id} (${referred.username})`);
            }
          }
        }
      } else if (prev === 'active' && status !== 'active') {
        if (dep.plan_id) {
          await tdb.prepare(`UPDATE users SET active_deposit = CASE WHEN active_deposit - ? < 0 THEN 0 ELSE active_deposit - ? END WHERE id = ?`)
            .run(dep.amount, dep.amount, dep.user_id);
          // Fecha a posicao e estorna o que ja foi creditado: reverter um
          // deposito ativo sem reverter o accumulate deixaria lucro orfao.
          const open = await tdb.prepare("SELECT * FROM positions WHERE deposit_id = ? AND status = 'active'").all(id);
          for (const pos of open) {
            const paid = (await tdb.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM accruals WHERE position_id = ?').get(pos.id)).s;
            if (Number(paid) > 0) {
              await tdb.prepare('UPDATE users SET balance = CASE WHEN balance - ? < 0 THEN 0 ELSE balance - ? END, total_earnings = CASE WHEN total_earnings - ? < 0 THEN 0 ELSE total_earnings - ? END WHERE id = ?')
                .run(paid, paid, paid, paid, dep.user_id);
              await tdb.prepare(`INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'accrual_reversal', ?, ?)`)
                .run(dep.user_id, -paid, 'Rendimento (SIMULADO) estornado — deposito #' + id + ' revertido');
            }
            await tdb.prepare("UPDATE positions SET status = 'closed', closed_at = to_char(now(), 'YYYY-MM-DD') WHERE id = ?").run(pos.id);
          }
          await tdb.prepare(`INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'deposit_reversed', ?, ?)`)
            .run(dep.user_id, dep.amount, `Deposito #${id} movido de active para ${status}`);
        } else {
          await tdb.prepare(`UPDATE users SET balance = CASE WHEN balance - ? < 0 THEN 0 ELSE balance - ? END WHERE id = ?`)
            .run(dep.amount, dep.amount, dep.user_id);
          await tdb.prepare(`INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'topup_reversed', ?, ?)`)
            .run(dep.user_id, dep.amount, `Adicao de saldo #${id} revertida (active para ${status})`);
        }
      } else if (status === 'rejected') {
        await tdb.prepare(`INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'deposit_rejected', ?, ?)`)
          .run(dep.user_id, dep.amount, `Deposito #${id} rejeitado`);
      }
    });
    await apply;
    return res.json(await db.prepare('SELECT * FROM deposits WHERE id = ?').get(id));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao atualizar deposito.' });
  }
});

app.get('/api/admin/withdrawals', authRequired, adminRequired, async (req, res) => {
  try {
    const rows = await db
      .prepare(`SELECT w.*, u.username, g.symbol AS gateway_symbol
                FROM withdrawals w
                LEFT JOIN users u ON u.id = w.user_id
                LEFT JOIN gateways g ON g.id = w.gateway_id
                ORDER BY w.id DESC LIMIT 200`)
      .all();
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao listar saques.' });
  }
});

app.put('/api/admin/withdrawals/:id', authRequired, adminRequired, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body || {};
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID invalido.' });
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status invalido (pending/approved/rejected).' });
    }
    const wd = await db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!wd) return res.status(404).json({ error: 'Saque nao encontrado.' });
    if (wd.status === status) {
      return res.json(await db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id));
    }
    if (wd.status !== 'pending') {
      return res.status(400).json({ error: 'Somente saques pendentes podem ser atualizados.' });
    }
    const apply = db.transaction(async (tdb) => {
      const user = await tdb.prepare('SELECT * FROM users WHERE id = ?').get(wd.user_id);
      if (!user) throw new Error('user-missing');
      if (status === 'approved') {
        if ((user.pending_withdraw || 0) < wd.amount) throw new Error('pending-insuficiente');
        if ((user.balance || 0) < wd.amount) throw new Error('saldo-insuficiente');
        await tdb.prepare('UPDATE withdrawals SET status = ? WHERE id = ?').run(status, id);
        await tdb.prepare(`UPDATE users SET pending_withdraw = pending_withdraw - ?,
                    balance = balance - ?, total_withdrawn = total_withdrawn + ? WHERE id = ?`)
          .run(wd.amount, wd.amount, wd.amount, wd.user_id);
        await tdb.prepare(`INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'withdraw_approved', ?, ?)`)
          .run(wd.user_id, wd.amount, `Saque #${id} aprovado`);
      } else if (status === 'rejected') {
        await tdb.prepare('UPDATE withdrawals SET status = ? WHERE id = ?').run(status, id);
        await tdb.prepare(`UPDATE users SET pending_withdraw = CASE WHEN pending_withdraw - ? < 0 THEN 0 ELSE pending_withdraw - ? END WHERE id = ?`)
          .run(wd.amount, wd.amount, wd.user_id);
        await tdb.prepare(`INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'withdraw_rejected', ?, ?)`)
          .run(wd.user_id, wd.amount, `Saque #${id} rejeitado (valor liberado)`);
      } else {
        await tdb.prepare('UPDATE withdrawals SET status = ? WHERE id = ?').run(status, id);
      }
    });
    try {
      await apply;
    } catch (e) {
      if (e.message === 'saldo-insuficiente' || e.message === 'pending-insuficiente') {
        return res.status(400).json({ error: 'Saldo/pendente insuficiente para aprovar.' });
      }
      throw e;
    }
    return res.json(await db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao atualizar saque.' });
  }
});

// validatePlanBody foi removida junto com o CRUD de planos (POST/PUT nao
// gravam mais nada), entao nao ha mais o que validar.

// ==== PLANOS: CRUD REMOVIDO ====
//
// Um plano aqui promete "X% ao dia por N dias". Nada no sistema investe o
// dinheiro do usuário, portanto esse retorno não existe — ele só apareceria
// enquanto pessoas mais novas depositassem.
//
// COMO ESTA AGORA: os planos voltaram como AMBIENTE DE SIMULACAO. A taxa e
// uma chamada de configuracao (db.js SEED_PLANS), nao rentabilidade de
// mercado. Enquanto settings.simulation_mode = '1':
//   - accrue.js credita daily_rate ao usuario;
//   - toda transacao criada diz "Rendimento (SIMULADO)";
//   - /api/public/plans marca cada plano com simulated: true;
//   - a UI exibe o aviso e rotula cada valor.
//
// Para sair da simulacao seria preciso uma taxa vinda de mercado
// (/api/solana/*) e lastro real. Ver README.

function validatePlanBody(b) {
  const errors = [];
  if (!b.name || !String(b.name).trim()) errors.push('name obrigatorio');
  const daily = Number(b.daily_rate);
  if (!Number.isFinite(daily) || daily <= 0) errors.push('daily_rate invalido (deve ser maior que 0)');
  const dur = parseInt(b.duration_days, 10);
  if (!Number.isInteger(dur) || dur <= 0) errors.push('duration_days invalido');
  const min = Number(b.min_deposit);
  const max = Number(b.max_deposit);
  if (!Number.isFinite(min) || min < 0) errors.push('min_deposit invalido');
  if (!Number.isFinite(max) || max <= 0) errors.push('max_deposit invalido');
  if (Number.isFinite(min) && Number.isFinite(max) && max <= min) errors.push('max_deposit deve ser maior que min_deposit');
  const tr = Number(b.total_return_pct);
  if (!Number.isFinite(tr) || tr < 0) errors.push('total_return_pct invalido');
  return errors;
}

app.get('/api/admin/plans', authRequired, adminRequired, async (req, res) => {
  try {
    return res.json(await db.prepare('SELECT * FROM plans ORDER BY id ASC').all());
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao listar planos.' });
  }
});

app.post('/api/admin/plans', authRequired, adminRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const errors = validatePlanBody(b);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    const totalReturn = Number(b.total_return_pct);
    const netProfit = Math.round((totalReturn - 100) * 10) / 10;
    const info = await db
      .prepare(`INSERT INTO plans (name, daily_rate, duration_days, min_deposit, max_deposit, total_return_pct, net_profit_pct, active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        String(b.name).trim(),
        Number(b.daily_rate),
        parseInt(b.duration_days, 10),
        Number(b.min_deposit),
        Number(b.max_deposit),
        totalReturn,
        netProfit,
        b.active === undefined ? 1 : Number(b.active) ? 1 : 0
      );
    return res.status(201).json(await db.prepare('SELECT * FROM plans WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao criar plano.' });
  }
});

app.put('/api/admin/plans/:id', authRequired, adminRequired, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID invalido.' });
    const cur = await db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'Plano nao encontrado.' });
    const b = req.body || {};
    const merged = { ...cur, ...b };
    const errors = validatePlanBody(merged);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    const totalReturn = Number(merged.total_return_pct);
    const netProfit = Math.round((totalReturn - 100) * 10) / 10;
    await db.prepare(`UPDATE plans SET name=?, daily_rate=?, duration_days=?, min_deposit=?, max_deposit=?,
                total_return_pct=?, net_profit_pct=?, active=? WHERE id=?`)
      .run(
        String(merged.name).trim(),
        Number(merged.daily_rate),
        parseInt(merged.duration_days, 10),
        Number(merged.min_deposit),
        Number(merged.max_deposit),
        totalReturn,
        netProfit,
        Number(merged.active) ? 1 : 0,
        id
      );
    // Editar um plano nao toca em positions ja abertas: a taxa foi copiada
    // para a posicao no momento da ativacao.
    return res.json(await db.prepare('SELECT * FROM plans WHERE id = ?').get(id));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao atualizar plano.' });
  }
});

app.delete('/api/admin/plans/:id', authRequired, adminRequired, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID invalido.' });
    const open = (await db.prepare("SELECT COUNT(*) c FROM positions WHERE plan_id = ? AND status = 'active'").get(id)).c;
    if (Number(open) > 0) return res.status(409).json({ error: 'Plano tem ' + open + ' posicao(oes) ativa(s). Desabilite em vez de excluir.' });
    const r = await db.prepare('DELETE FROM plans WHERE id = ?').run(id);
    if (r.changes === 0) return res.status(404).json({ error: 'Plano nao encontrado.' });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao excluir plano.' });
  }
});

function validateGatewayBody(b) {
  const errors = [];
  if (!b.symbol || !String(b.symbol).trim()) errors.push('symbol obrigatorio');
  if (!b.name || !String(b.name).trim()) errors.push('name obrigatorio');
  if (!b.network || !String(b.network).trim()) errors.push('network obrigatorio');
  if (!b.wallet_address || !String(b.wallet_address).trim()) errors.push('wallet_address obrigatorio');
  return errors;
}

app.get('/api/admin/gateways', authRequired, adminRequired, async (req, res) => {
  try {
    return res.json(await db.prepare('SELECT * FROM gateways ORDER BY id ASC').all());
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao listar gateways.' });
  }
});

app.post('/api/admin/gateways', authRequired, adminRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const errors = validateGatewayBody(b);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    const info = await db
      .prepare('INSERT INTO gateways (symbol, name, network, wallet_address, active) VALUES (?, ?, ?, ?, ?)')
      .run(
        String(b.symbol).trim(),
        String(b.name).trim(),
        String(b.network).trim(),
        String(b.wallet_address).trim(),
        b.active === undefined ? 1 : Number(b.active) ? 1 : 0
      );
    return res.status(201).json(await db.prepare('SELECT * FROM gateways WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao criar gateway.' });
  }
});

app.put('/api/admin/gateways/:id', authRequired, adminRequired, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID invalido.' });
    const cur = await db.prepare('SELECT * FROM gateways WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'Gateway nao encontrado.' });
    const b = req.body || {};
    const merged = { ...cur, ...b };
    const errors = validateGatewayBody(merged);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    await db.prepare('UPDATE gateways SET symbol=?, name=?, network=?, wallet_address=?, active=? WHERE id=?')
      .run(
        String(merged.symbol).trim(),
        String(merged.name).trim(),
        String(merged.network).trim(),
        String(merged.wallet_address).trim(),
        Number(merged.active) ? 1 : 0,
        id
      );
    return res.json(await db.prepare('SELECT * FROM gateways WHERE id = ?').get(id));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao atualizar gateway.' });
  }
});

app.delete('/api/admin/gateways/:id', authRequired, adminRequired, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID invalido.' });
    const r = await db.prepare('DELETE FROM gateways WHERE id = ?').run(id);
    if (r.changes === 0) return res.status(404).json({ error: 'Gateway nao encontrado.' });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao excluir gateway.' });
  }
});

app.get('/api/admin/settings', authRequired, adminRequired, async (req, res) => {
  try {
    return res.json(await getSettingsObject());
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao carregar configuracoes.' });
  }
});

app.put('/api/admin/settings', authRequired, adminRequired, async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
      return res.status(400).json({ error: 'Envie um objeto {key: value}.' });
    }
    const t = db.transaction(async (tdb) => {
      const upsert = tdb.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      );
      for (const [k, v] of Object.entries(body)) {
        if (!k || typeof k !== 'string') continue;
        await upsert.run(k.trim(), String(v));
      }
    });
    await t;
    return res.json(await getSettingsObject());
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao salvar configuracoes.' });
  }
});

// ---------- Visao Geral do admin: caixa, exposicao e evolucao ----------
// Agregacoes do PROPRIO banco, sem numero inventado:
//   caixa a guardar = saldo ja creditado aos usuarios + o que as posicoes
//   ativas ainda vao creditar ate o fim do contrato.
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

app.get('/api/admin/overview', authRequired, adminRequired, async (req, res) => {
  try {
    const pos = await db.prepare(`
      SELECT COUNT(*) AS positions_active,
             COALESCE(SUM(principal), 0) AS invested_active,
             COALESCE(SUM(principal * daily_rate / 100.0), 0) AS daily_yield
      FROM positions WHERE status = 'active'`).get();
    const proj = await db.prepare(`
      SELECT COALESCE(SUM((duration_days - days_paid) * principal * daily_rate / 100.0), 0) AS pending
      FROM positions WHERE status = 'active' AND days_paid < duration_days`).get();
    const gen = await db.prepare('SELECT COALESCE(SUM(amount), 0) AS paid FROM accruals').get();
    const us = await db.prepare(`
      SELECT COUNT(*) AS users_total,
             COALESCE(SUM(balance), 0) AS balance_total,
             COALESCE(SUM(pending_withdraw), 0) AS pending_withdraw,
             COALESCE(SUM(total_withdrawn), 0) AS total_withdrawn
      FROM users`).get();
    const withPos = await db.prepare("SELECT COUNT(DISTINCT user_id) AS c FROM positions WHERE status = 'active'").get();

    const balanceTotal = r2(us.balance_total);
    const projected = r2(proj.pending);
    return res.json({
      users_total: Number(us.users_total) || 0,
      users_active_positions: Number(withPos.c) || 0,
      positions_active: Number(pos.positions_active) || 0,
      invested_active: r2(pos.invested_active),
      daily_yield: r2(pos.daily_yield),
      generated_paid: r2(gen.paid),
      projected_pending: projected,
      balance_total: balanceTotal,
      pending_withdraw: r2(us.pending_withdraw),
      total_withdrawn: r2(us.total_withdrawn),
      cash_needed: r2(balanceTotal + projected)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao montar o resumo do caixa.' });
  }
});

// Acumulado de uma serie diaria, incluindo o que ja existia ANTES da janela
// (assim a linha mostra o total da empresa, nao so o recorte).
function dailyCumulative(rows, dates) {
  const map = Object.create(null);
  for (const r of rows) {
    const k = String(r.d || '').slice(0, 10);
    if (!k) continue;
    map[k] = (map[k] || 0) + Number(r.a || 0);
  }
  const keys = Object.keys(map).sort();
  let ki = 0, run = 0;
  while (ki < keys.length && keys[ki] < dates[0]) { run += map[keys[ki]]; ki++; }
  const out = [];
  for (const dt of dates) {
    while (ki < keys.length && keys[ki] <= dt) { run += map[keys[ki]]; ki++; }
    out.push(r2(run));
  }
  return out;
}

app.get('/api/admin/evolution', authRequired, adminRequired, async (req, res) => {
  try {
    let days = parseInt(req.query.days, 10);
    if (!Number.isFinite(days) || days < 7) days = 7;
    if (days > 730) days = 730;
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const dates = [];
    for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) {
      dates.push(new Date(t).toISOString().slice(0, 10));
    }
    const dep = await db.prepare("SELECT left(created_at, 10) AS d, COALESCE(SUM(amount), 0) AS a FROM deposits WHERE status = 'active' GROUP BY d").all();
    const acc = await db.prepare('SELECT accrual_date AS d, COALESCE(SUM(amount), 0) AS a FROM accruals GROUP BY d').all();
    const resu = await db.prepare('SELECT result_date AS d, COALESCE(SUM(amount), 0) AS a FROM company_results GROUP BY d').all();
    const settings = await getSettingsObject();
    // Meta DINAMICA: cobre o lucro ja gerado aos usuarios e um extra para a
    // empresa (fator padrao 1.30 = lucro + 30%). Linha por dia, nao um valor fixo.
    const rawFactor = Number(settings.meta_factor);
    const metaFactor = Number.isFinite(rawFactor) && rawFactor > 0 ? rawFactor : 1.3;
    const investedCum = dailyCumulative(dep, dates);
    const generatedCum = dailyCumulative(acc, dates);
    const resultCum = dailyCumulative(resu, dates);
    return res.json({
      days,
      from: dates[0],
      to: dates[dates.length - 1],
      dates,
      invested_cum: investedCum,
      generated_cum: generatedCum,
      result_cum: resultCum,
      meta_factor: metaFactor,
      goal_series: generatedCum.map((v) => r2(v * metaFactor)),
      goal: r2((generatedCum[generatedCum.length - 1] || 0) * metaFactor)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao montar a evolucao.' });
  }
});

// Lancamento manual do resultado das APLICACOES da plataforma.
app.get('/api/admin/results', authRequired, adminRequired, async (req, res) => {
  try {
    const items = await db.prepare(
      'SELECT id, result_date, amount, note, created_at FROM company_results ORDER BY result_date DESC, id DESC LIMIT 200'
    ).all();
    const settings = await getSettingsObject();
    const raw = Number(settings.meta_factor);
    return res.json({ meta_factor: Number.isFinite(raw) && raw > 0 ? raw : 1.3, items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao carregar resultados.' });
  }
});

app.post('/api/admin/results', authRequired, adminRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const date = String(b.result_date || '').trim();
    const amount = Number(b.amount);
    const note = b.note == null ? null : String(b.note).trim().slice(0, 200) || null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'result_date deve ser AAAA-MM-DD.' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Informe um valor maior que zero.' });
    const info = await db.prepare('INSERT INTO company_results (result_date, amount, note) VALUES (?, ?, ?)').run(date, r2(amount), note);
    const row = await db.prepare('SELECT id, result_date, amount, note, created_at FROM company_results WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json(row);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao lancar resultado.' });
  }
});

app.delete('/api/admin/results/:id', authRequired, adminRequired, async (req, res) => {
  try {
    const info = await db.prepare('DELETE FROM company_results WHERE id = ?').run(Number(req.params.id));
    if (!info.changes) return res.status(404).json({ error: 'Lancamento nao encontrado.' });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao excluir resultado.' });
  }
});

// ---------- Solana (leitura on-chain, sem numero inventado) ----------
// Estes endpoints apenas LEEM a chain / APIs oficiais. Nao movem fundo e nao
// exigem assinatura. Erro de leitura vira campo null, nunca valor estimado.

const solLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas consultas. Tente em instantes.' }
});

let jitoCache = { value: null, ts: 0 };
let vaultsCache = { value: null, ts: 0 };

// Taxa de cambio jitoSOL <-> SOL lida direto do stake pool.
app.get('/api/solana/jito', solLimiter, async (req, res) => {
  const fresh = jitoCache.value && Date.now() - jitoCache.ts < 30000;
  try {
    if (fresh) return res.json(jitoCache.value);
    const pool = await solana.readJitoPool();
    if (pool.ok) jitoCache = { value: pool, ts: Date.now() };
    return res.json(pool);
  } catch (err) {
    console.error('jito read:', err.message);
    return res.json({ ok: false, error: 'Falha ao ler o stake pool na chain.' });
  }
});

// Vaults da Kamino que aceitam USDT, com APY real por janela.
app.get('/api/solana/usdt-vaults', solLimiter, async (req, res) => {
  const fresh = vaultsCache.value && Date.now() - vaultsCache.ts < 60000;
  try {
    if (fresh) return res.json(vaultsCache.value);
    const vaults = await solana.readUsdtVaults();
    vaultsCache = { value: vaults, ts: Date.now() };
    return res.json({ vaults, note: 'APYs da Kamino sao medias retroativas, nao taxas garantidas.' });
  } catch (err) {
    console.error('kamino read:', err.message);
    return res.json({ vaults: [], error: 'Falha ao consultar a API da Kamino.' });
  }
});

// Balancas do usuario. Endereco invalido -> 400, sem tentativas adivinhadas.
app.get('/api/solana/portfolio', solLimiter, async (req, res) => {
  const addr = String(req.query.address || '').trim();
  if (!addr) return res.status(400).json({ error: 'Informe o endereco da carteira.' });
  try {
    // Valida o formato antes de bater na chain.
    new solana.PublicKey(addr);
  } catch (e) {
    return res.status(400).json({ error: 'Endereco Solana invalido.' });
  }
  try {
    const p = await solana.readPortfolio(addr);
    return res.json(p);
  } catch (err) {
    console.error('portfolio read:', err.message);
    return res.status(500).json({ error: 'Falha ao ler saldos.' });
  }
});

// ---------- fallback ----------
app.get('/api/health', async (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/', async (req, res) => {
  const indexFile = path.join(publicDir, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  return res.json({ ok: true, name: 'Nexora API', docs: '/api/health' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('unhandled:', err);
  return res.status(500).json({ error: 'Erro interno.' });
});

process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));
process.on('unhandledRejection', (reason) => console.error('UNHANDLED REJECTION:', reason));

// Accrue diario. Roda a cada hora e tambem sob demanda:
//   POST /api/admin/accrue/run  { "onDate": "2026-10-05" }  -> simula o dia
//
// Idempotente por dia (UNIQUE em accruals), entao repetir e seguro.
const ACCRUAL_INTERVAL_MS = 60 * 60 * 1000;

// Dispara o accrue manualmente — usado para testar sem esperar o dia virar.
// onDate opcional avança o relógio do accrue (util para validar 30 dias de
// plano em segundos).
app.post('/api/admin/accrue/run', authRequired, adminRequired, async (req, res) => {
  try {
    const onDate = (req.body || {}).onDate;
    if (onDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(onDate))) {
      return res.status(400).json({ error: 'onDate deve ser AAAA-MM-DD.' });
    }
    const r = await accrual.runAccruals(db, onDate ? { onDate: String(onDate) } : {});
    return res.json({ ok: true, simulated: await isSimulation(), ...r });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro no accrue: ' + err.message });
  }
});

// Catch-all DEPOIS de todas as rotas /api (registrava antes e deixava
// POST /api/admin/accrue/run permanentemente em 404).
app.use('/api', async (req, res) => res.status(404).json({ error: 'Rota nao encontrada.' }));

function scheduleAccruals() {
  const tick = async () => {
    try {
      await ensureDb();
      const r = await accrual.runAccruals(db);
      if (r.credited > 0) {
        console.log('[accrue] ' + r.credited + ' dia(s) creditado(s), total ' + r.gross.toFixed(2));
      }
    } catch (err) {
      console.error('[accrue] erro:', err.message);
    }
  };
  tick();
  const h = setInterval(tick, ACCRUAL_INTERVAL_MS);
  h.unref(); // nao segura o processo aberto so por causa do timer
  return h;
}

if (require.main === module) {
  (async () => {
    try {
      await ensureDb();
      const sim = await isSimulation();
      scheduleAccruals();
      app.listen(PORT, () => {
        console.log(`[nexora] API rodando na porta ${PORT}`);
        console.log(`[nexora] DB: ${process.env.DATABASE_URL ? 'Supabase Postgres (DATABASE_URL)' : 'sem DATABASE_URL'}`);
        console.log(`[nexora] simulation_mode=${sim ? '1' : '0'}`);
      });
    } catch (err) {
      console.error('[nexora] falha ao iniciar:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = { app, ensureDb, getDb, db, scheduleAccruals, isSimulation };
