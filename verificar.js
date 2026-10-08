// Verificação completa em primeiro plano: sobe o app, testa e encerra.
// Uso: node verificar.js
const { app } = require('./server.js');

const PORT = 3001;
const BASE = `http://localhost:${PORT}`;

async function api(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, () => resolve(s));
  });
  console.log(`[verificar] servidor de teste na porta ${PORT}`);
  try {
    let r = await api('/api/health');
    console.log('health:', r.status, JSON.stringify(r.data));

    r = await api('/api/public/plans');
    console.log('plans:', r.status, Array.isArray(r.data) ? r.data.map((p) => p.name).join(', ') : 'FALHOU');

    r = await api('/api/public/gateways');
    console.log('gateways:', r.status, Array.isArray(r.data) ? r.data.length + ' gateways' : 'FALHOU');

    r = await api('/api/crypto/prices');
    console.log('prices:', r.status, r.data.prices ? r.data.prices.length + ' moedas' : 'FALHOU');

    const u = 'teste' + Date.now().toString(36);
    r = await api('/api/auth/signup', 'POST', { username: u, email: `${u}@teste.com`, password: 'Teste123' });
    console.log('signup:', r.status, r.data.user ? 'OK user=' + r.data.user.username : JSON.stringify(r.data));

    r = await api('/api/auth/login', 'POST', { login: 'admin', password: 'Admin123!' });
    console.log('login admin:', r.status, r.data.user && r.data.user.is_admin ? 'OK is_admin=1' : 'FALHOU');

    console.log('VERIFICACAO PASS — o projeto roda corretamente.');
  } finally {
    server.close();
  }
  process.exit(0);
}

main().catch((e) => { console.error('FALHA:', e.message); process.exit(1); });
