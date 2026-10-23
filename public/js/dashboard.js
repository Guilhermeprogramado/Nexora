/* ============================================================
   Nexora — public/js/dashboard.js (vanilla JS, sem dependências)
   - Guard de auth via localStorage `nexora_token`
   - Roteamento hash SPA (#dashboard, #deposit, #withdraw, ...)
   - fetch com Authorization: Bearer <token>, try/catch, null-checks
   ============================================================ */
(function () {
  'use strict';

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDate(v) {
    if (!v) return '—';
    try {
      var d = new Date(v);
      if (isNaN(d.getTime())) return esc(v);
      return esc(d.toLocaleString('pt-BR'));
    } catch (e) { return esc(v); }
  }
  function statusPill(s) {
    var k = String(s || 'pending').toLowerCase();
    var cls = 'pending';
    if (['approved', 'paid', 'completed', 'active', 'confirmed', 'success', 'buy'].indexOf(k) >= 0) cls = 'buy';
    else if (['rejected', 'failed', 'cancelled', 'canceled', 'sell'].indexOf(k) >= 0) cls = 'sell';
    return '<span class="pill ' + cls + '">' + esc(s || 'pending') + '</span>';
  }

  var toastTimer = null;
  function toast(msg, type) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show' + (type ? ' ' + type : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  /* ---------- auth ---------- */
  var token = null;
  try { token = localStorage.getItem('nexora_token'); } catch (e) { token = null; }
  if (!token) { window.location.href = '/login.html'; return; }

  function authHeaders(extra) {
    var h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  async function api(path, opts) {
    opts = opts || {};
    try {
      var res = await fetch(path, {
        method: opts.method || 'GET',
        headers: authHeaders(),
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
      if (res.status === 401) {
        try { localStorage.removeItem('nexora_token'); localStorage.removeItem('nexora_user'); } catch (e) {}
        window.location.href = '/login.html';
        return null;
      }
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) {
        var msg = (data && (data.message || data.error)) || ('Erro ' + res.status);
        throw new Error(msg);
      }
      return data;
    } catch (err) {
      throw err;
    }
  }

  function logout() {
    try { localStorage.removeItem('nexora_token'); localStorage.removeItem('nexora_user'); } catch (e) {}
    window.location.href = '/login.html';
  }

  /* ---------- sidebar drawer (mobile) ---------- */
  var sidebar = $('sidebar'), hamburger = $('hamburger'), backdrop = $('backdrop');
  function closeDrawer() {
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('show');
  }
  if (hamburger && sidebar) {
    hamburger.addEventListener('click', function () {
      sidebar.classList.toggle('open');
      if (backdrop) backdrop.classList.toggle('show', sidebar.classList.contains('open'));
    });
  }
  if (backdrop) backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  /* ---------- SPA router ---------- */
  var TITLES = {
    dashboard: 'Dashboard', deposit: 'Investir em Plano', wallet: 'Adicionar Saldo', withdraw: 'Sacar',
    history: 'Histórico Transações', deposits: 'Meus Depósitos',
    referrals: 'Menu Referral', security: 'Segurança', settings: 'Config Conta'
  };
  var loaded = {};
  function currentRoute() {
    try {
      var q = new URLSearchParams(window.location.search).get('view');
      var h = (window.location.hash || '').replace(/^#\/?/, '').split('?')[0];
      var r = (h || q || 'dashboard').toLowerCase();
      return TITLES[r] ? r : 'dashboard';
    } catch (e) { return 'dashboard'; }
  }
  function render(route) {
    var views = document.querySelectorAll('.view');
    views.forEach(function (s) { s.classList.remove('active'); });
    var sec = $('view-' + route);
    if (sec) sec.classList.add('active');
    var links = document.querySelectorAll('#mainNav a[data-route]');
    links.forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-route') === route);
    });
    var t = $('pageTitle');
    if (t) t.textContent = TITLES[route] || 'Dashboard';
    closeDrawer();
    lazyLoad(route);
    // Saldo/posicoes podem ter mudado (plano vencido -> principal liberado).
    // Recarrega o perfil ao entrar nas telas que dependem de saldo para nao
    // mostrar valor defasado do servidor.
    if (route === 'dashboard' || route === 'deposit' || route === 'withdraw') loadMe();
  }
  function lazyLoad(route) {
    if (loaded[route]) return;
    loaded[route] = true;
    if (route === 'dashboard') { loadPositions(); loadAccruals(); }
    else if (route === 'history') loadHistory();
    else if (route === 'deposits') loadDeposits();
    else if (route === 'referrals') loadReferrals();
    else if (route === 'deposit') { loadPlans(); loadMe(); }
    else if (route === 'wallet') { loadPublicSettings(); loadWalletGateways(); }
    else if (route === 'withdraw') loadGateways();
  }
  window.addEventListener('hashchange', function () { render(currentRoute()); });

  /* ---------- state ---------- */
  var state = { me: null, plans: [], gateways: [], positions: [], available: 0, balance: 0, withdrawUnlocked: false, hasInvestment: null, wallet: null, settings: {} };

  /* O servidor devolve objetos ({ simulated, positions }) e não listas.
     Aceitar as duas formas evita painel vazio quando a API muda. */
  function listFrom(payload, key) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload[key])) return payload[key];
    if (payload && Array.isArray(payload.data)) return payload.data;
    return [];
  }

  /* ---------- rendimento por plano + total no topo ----------
     Janelas de 24h ancoradas no MOMENTO do investimento (created_at). O valor
     começa em $0 ao investir e sobe suavemente até o crédito diário exato às
     24h (e assim a cada 24h). O teto é sempre o que o servidor vai creditar
     (accrual.js credita nas mesmas janelas de 24h) — nunca antecipa o fim de
     um ciclo. Concluídas são removidas do painel. */
  var DAY_MS = 86400000;
  var mine = { rows: [], simulated: false, key: null, models: [] };

  function moneyLive(v) {
    var n = Number(v);
    if (!isFinite(n) || n < 0) n = 0;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
  }
  function fmtLeft(ms) {
    if (!isFinite(ms) || ms <= 0) return '0s';
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + sec + 's';
    return sec + 's';
  }

  function buildModel(p) {
    // Período de 24h ancorado no MOMENTO do investimento (created_at, que tem
    // hora). Sem created_at cai no dia (meia-noite UTC) de started_on.
    var rawStart = String(p.created_at || '').trim();
    var startedMs = Date.parse(rawStart.replace(' ', 'T') + 'Z');
    if (!isFinite(startedMs)) startedMs = Date.parse(String(p.started_on || '').slice(0, 10) + 'T00:00:00Z');
    if (!isFinite(startedMs)) startedMs = Date.now();
    var days = Math.max(1, parseInt(p.duration_days, 10) || 1);
    var paid = Math.min(days, Math.max(0, parseInt(p.days_paid, 10) || 0));
    var daily = Number(p.daily_amount);
    if (!isFinite(daily) || daily <= 0) {
      daily = (Number(p.principal) || 0) * ((Number(p.daily_rate) || 0) / 100);
    }
    return {
      id: p.id,
      plan: p.plan_name || 'Plano',
      principal: Number(p.principal) || 0,
      rate: Number(p.daily_rate) || 0,
      days: days,
      paid: paid,
      daily: daily,
      accrued: Number(p.accrued) || 0,
      startedMs: startedMs,
      closed: p.status === 'closed' || paid >= days,
      dayStart: startedMs + paid * DAY_MS,
      dayEnd: startedMs + (paid + 1) * DAY_MS,
      endMs: startedMs + days * DAY_MS,
      el: null
    };
  }
  function liveAccrued(m, now) {
    if (m.closed) return m.accrued;
    var maxCreditable = m.accrued + m.daily * (m.days - m.paid);
    if (now <= m.dayStart) return m.accrued;
    var frac = (now - m.dayStart) / Math.max(1, m.dayEnd - m.dayStart);
    if (frac > 1) frac = 1;
    return Math.min(maxCreditable, m.accrued + m.daily * frac);
  }

  function counterHTML(m) {
    return '<div class="mine-card' + (m.closed ? ' done' : '') + '" data-pid="' + esc(m.id) + '">' +
      '<div class="mine-card-top"><b>' + esc(m.plan) + '</b>' +
        (m.closed ? '<span class="pill buy">Concluído</span>' : '<span class="mine-live-tag">Ativo</span>') +
      '</div>' +
      '<div class="mine-meta">' + money(m.principal) + ' · ' + String(m.rate).replace('.', ',') +
        '% ao dia · ' + m.days + ' dia(s)</div>' +
      '<div class="mine-amount" data-role="amount">' + moneyLive(m.accrued) + '</div>' +
      '<div class="mine-amount-lbl">rendimento acumulado' + '</div>' +
      '<div class="mine-bar"><i data-role="bar" style="width:0%"></i></div>' +
      '<div class="mine-foot"><span data-role="days">' + m.paid + '/' + m.days + ' dias</span>' +
        '<span data-role="eta"></span></div>' +
    '</div>';
  }

  function paintMine() {
    var panel = $('minePanel'), grid = $('mineGrid');
    if (!panel || !grid) return;
    panel.style.display = '';
    var sub = $('mineSub');
    if (sub) sub.textContent = mine.simulated
      ? 'Modo simulação — taxa de configuração, crédito só no banco local'
      : 'Crédito diário automático por plano · atualiza sozinho';

    // Somente posições ATIVAS aparecem. Concluída (principal liberado/retirado),
    // a posição sai do dashboard — fica só no histórico de créditos/transações.
    var rows = mine.rows
      .filter(function (p) { return p.status !== 'closed'; })
      .slice()
      .sort(function (a, b) { return Number(b.id) - Number(a.id); });

    if (!rows.length) {
      mine.key = 'empty';
      mine.models = [];
      grid.innerHTML = '<div class="mine-empty">Nenhum plano ativo ainda. ' +
        '<a href="#deposit">Investir em um plano →</a></div>';
      var t = $('mineTotal'); if (t) t.textContent = '$0.000000';
      var sp = $('mineSplit'); if (sp) sp.textContent = '—';
      var nt = $('mineNote'); if (nt) nt.textContent = '';
      return;
    }

    var key = rows.map(function (p) { return p.id + ':' + p.status; }).join('|');
    if (key !== mine.key) {
      mine.key = key;
      mine.models = rows.map(buildModel);
      grid.innerHTML = mine.models.map(counterHTML).join('');
    } else {
      // Mesma lista: só re-le o que o servidor gravou (novo crédito, encerramento).
      mine.models = rows.map(buildModel);
    }
    mine.models.forEach(function (m) {
      m.el = grid.querySelector('.mine-card[data-pid="' + m.id + '"]');
    });

    var note = $('mineNote');
    if (note) {
      note.textContent = 'O rendimento começa em $0 no momento do investimento e sobe até o crédito de 24h exato (gravado pelo banco). Valor jamais passa do teto do próximo crédito. Posições concluídas saem deste painel.';
    }
    tickMine();
  }
  function tickMine() {
    if (!mine.models.length) {
      var t0 = $('mineTotal');
      if (t0) t0.textContent = '$0.000000';
      return;
    }
    var now = Date.now();
    var capital = 0, earnings = 0;
    mine.models.forEach(function (m) {
      var amt = liveAccrued(m, now);
      capital += m.principal;
      earnings += amt;
      var el = m.el || document.querySelector('.mine-card[data-pid="' + m.id + '"]');
      if (!el) return;
      m.el = el;
      var a = el.querySelector('[data-role="amount"]');
      if (a) a.textContent = moneyLive(amt);
      var frac = 1;
      if (!m.closed) {
        frac = (now - m.dayStart) / Math.max(1, m.dayEnd - m.dayStart);
        if (frac < 0) frac = 0;
        if (frac > 1) frac = 1;
      }
      var pct = ((m.paid + frac) / m.days) * 100;
      if (pct < 0) pct = 0;
      if (pct > 100) pct = 100;
      var bar = el.querySelector('[data-role="bar"]');
      if (bar) bar.style.width = pct.toFixed(3) + '%';
      var d = el.querySelector('[data-role="days"]');
      if (d) d.textContent = m.paid + '/' + m.days + ' dias creditados';
      var eta = el.querySelector('[data-role="eta"]');
      if (eta) {
        eta.textContent = m.closed
          ? 'período encerrado'
          : 'próximo crédito ' + fmtLeft(m.dayEnd - now) + ' · fim ' + fmtLeft(m.endMs - now);
      }
    });
    var t = $('mineTotal');
    if (t) t.textContent = moneyLive(capital + earnings);
    var sp = $('mineSplit');
    if (sp) sp.textContent = 'capital ' + money(capital) + ' · rendimento +' + moneyLive(earnings);
  }

  async function loadPositions() {
    var grid = $('mineGrid');
    try {
      var data = await api('/api/my/positions');
      var rows = listFrom(data, 'positions');
      mine.rows = rows;
      mine.simulated = !!(data && data.simulated);
      state.positions = rows;
      if (rows.length) state.hasInvestment = true;
      if (state.me) paintBalances();
      paintMine();
    } catch (err) {
      if (grid && !mine.models.length) {
        grid.innerHTML = '<div class="mine-empty">Falha ao carregar os contadores.</div>';
      }
    }
  }

  async function loadAccruals() {
    var box = $('accrualList');
    if (!box) return;
    try {
      var data = await api('/api/my/accruals');
      var rows = listFrom(data, 'accruals');
      if (!rows.length) { box.innerHTML = '<p class="desc">Nenhum crédito diário ainda.</p>'; return; }
      box.innerHTML = '<table class="table"><thead><tr><th>Data</th><th>Plano</th>' +
        '<th>Crédito</th><th>Rendimento acumulado</th></tr></thead><tbody>' +
        rows.map(function (a) {
          var dateStr = a.accrual_date ? new Date(a.accrual_date + 'T00:00:00').toLocaleDateString('pt-BR') : '—';
          var acc = (a.earned_until !== undefined && a.earned_until !== null) ? a.earned_until : a.balance_after;
          return '<tr><td>' + esc(dateStr) + '</td><td>' + esc(a.plan_name || '—') + '</td>' +
            '<td style="color:var(--green,#10b981)">+' + money(a.amount) + '</td>' +
            '<td>' + money(acc) + '</td></tr>';
        }).join('') + '</tbody></table>';
    } catch (err) {
      box.innerHTML = '<p class="desc">Falha ao carregar créditos.</p>';
    }
  }

  function pick(obj, keys, fb) {
    if (!obj) return fb;
    for (var i = 0; i < keys.length; i++) {
      if (obj[keys[i]] !== undefined && obj[keys[i]] !== null) return obj[keys[i]];
    }
    return fb;
  }

  function getAssetBal(sym) {
    if (!state.me || !Array.isArray(state.me.balances)) return { amount: 0, pending: 0, available: 0, usd_price: null };
    var s = String(sym || '').toUpperCase();
    for (var i = 0; i < state.me.balances.length; i++) {
      if (String(state.me.balances[i].asset).toUpperCase() === s) return state.me.balances[i];
    }
    return { amount: 0, pending: 0, available: 0, usd_price: null };
  }

  function paintDepositAssets() {
    var sel = $('depAsset');
    if (!sel) return;
    var bals = (state.me && Array.isArray(state.me.balances)) ? state.me.balances : [];
    if (!bals.length) {
      sel.innerHTML = '<option value="">Sem saldo por moeda</option>';
      var av = $('depAssetAvail'); if (av) av.textContent = 'Saldo disponivel: —';
      var hu = $('depUsdHint'); if (hu) hu.textContent = 'Equivale a: US$ —';
      return;
    }
    var html = bals.map(function (b) {
      return '<option value="' + esc(b.asset) + '">' + esc(b.asset) + ' · disponivel ' + Number(b.available || 0) + '</option>';
    }).join('');
    sel.innerHTML = html;
    updateDepAssetUI();
  }

  function updateDepAssetUI() {
    var sym = $('depAsset') && $('depAsset').value;
    var b = getAssetBal(sym);
    var av = $('depAssetAvail');
    if (av) av.textContent = 'Saldo disponivel: ' + Number(b.available || 0) + ' ' + (sym || '');
    var amtEl = $('depAmount');
    var amt = amtEl && Number(amtEl.value);
    var hu = $('depUsdHint');
    if (!hu) return;
    if (isFinite(amt) && amt > 0 && Number(b.usd_price) > 0) {
      hu.textContent = 'Equivale a: US$ ' + money(amt * Number(b.usd_price));
    } else {
      hu.textContent = 'Equivale a: US$ —';
    }
  }

  function paintWithdrawAssets() {
    var sel = $('wdAsset');
    if (!sel) return;
    var bals = (state.me && Array.isArray(state.me.balances)) ? state.me.balances : [];
    if (!bals.length) {
      sel.innerHTML = '<option value="">Sem saldo por moeda</option>';
      var av = $('wdAssetAvail'); if (av) av.textContent = 'Disponivel: —';
      return;
    }
    var html = bals.map(function (b) {
      return '<option value="' + esc(b.asset) + '">' + esc(b.asset) + ' · ' + Number(b.available || 0) + ' disponivel</option>';
    }).join('');
    sel.innerHTML = html;
    updateWithdrawAssetUI();
  }

  function updateWithdrawAssetUI() {
    var sym = $('wdAsset') && $('wdAsset').value;
    var b = getAssetBal(sym);
    var av = $('wdAssetAvail');
    if (av) av.textContent = 'Disponivel: ' + Number(b.available || 0) + ' ' + (sym || '');
  }

  /* ---------- /api/me ---------- */
  async function loadMe() {
    try {
      var data = await api('/api/me');
      if (!data) return;
      var u = data.user || data.data || data;
      state.me = u;
      var username = pick(u, ['username', 'name', 'login'], 'User');
      var email = pick(u, ['email'], '');
      var code = pick(u, ['referral_code', 'ref_code', 'refCode', 'ref'], '');
      var wN = $('welcomeName'); if (wN) wN.textContent = username;
      var chip = $('userChip'); if (chip) chip.innerHTML = '<b>' + esc(username) + '</b>' + (email ? ' · ' + esc(email) : '');
      $('cardAvailable').textContent = money(pick(u, ['available_balance', 'balance', 'availableBalance', 'available'], 0));
      $('cardEarnings').textContent = money(pick(u, ['total_earnings', 'earnings', 'profit', 'totalEarnings'], 0));
      $('cardActiveDeposit').textContent = money(pick(u, ['active_deposit', 'activeDeposit', 'invested'], 0));
      $('cardWithdrawn').textContent = money(pick(u, ['total_withdrawn', 'withdrawn', 'totalWithdrawn'], 0));
      var pw = $('cardPendingWithdraw');
      if (pw) pw.textContent = money(pick(u, ['pending_withdraw', 'pendingWithdraw', 'pending'], 0));

      var bal = Number(pick(u, ['available_balance', 'balance', 'availableBalance', 'available'], 0)) || 0;
      var pend = Number(pick(u, ['pending_withdraw', 'pendingWithdraw', 'pending'], 0)) || 0;
      state.balance = bal;

      // Saque: liberado só quando TODO o saldo depositado concluiu um plano.
      // O backend manda `withdrawable` (0 enquanto bloqueado) e `withdraw_unlocked`.
      var wu = pick(u, ['withdraw_unlocked', 'withdrawUnlocked'], false);
      if (wu === undefined || wu === null) state.withdrawUnlocked = false;
      else state.withdrawUnlocked = wu === true || wu === 1 || wu === '1';
      var wdAvail = Number(pick(u, ['withdrawable', 'withdrawAvailable'], 0)) || 0;
      state.available = Math.max(0, wdAvail);

      // Regra: só saca quem já investiu em algum plano (tem posição no banco).
      var hi = u.has_investment;
      if (hi === undefined || hi === null) state.hasInvestment = state.positions.length > 0;
      else state.hasInvestment = hi === true || hi === 1 || hi === '1';
      paintBalances();
      // Sincroniza a carteira persistida no servidor (fonte da verdade) com o
      // localStorage para a UI refletir a auto-aprovação de depósito.
      var srvWallet = String(pick(u, ['wallet_address'], '') || '').trim();
      if (srvWallet) {
        var wc = String(pick(u, ['wallet_chain'], '') || '').toLowerCase();
        var ex = getWallet();
        var wtype = ex && ex.type ? ex.type : (wc === 'evm' ? 'MetaMask/EVM' : 'Solana');
        try { localStorage.setItem('nexora_wallet', JSON.stringify({ type: wtype, address: srvWallet })); } catch (e) {}
      } else {
        try { localStorage.removeItem('nexora_wallet'); } catch (e) {}
      }
      var balRows = Array.isArray(u.balances) ? u.balances : [];
      var ab = $('assetBalancesBody');
      if (ab) {
        if (!balRows.length) {
          ab.innerHTML = '<tr class="empty-row"><td colspan="4">Sem saldos por moeda.</td></tr>';
        } else {
          ab.innerHTML = balRows.map(function (b) {
            var amt = Number(b.available !== undefined ? b.available : b.amount) || 0;
            var pend = Number(b.pending) || 0;
            var usd = (Number(b.usd_price) > 0) ? money(amt * Number(b.usd_price)) : '—';
            return '<tr><td><b>' + esc(b.asset) + '</b></td><td>' + amt + '</td><td>' + pend + '</td><td class="muted">' + usd + '</td></tr>';
          }).join('');
        }
      }
      paintDepositAssets();
      paintWithdrawAssets();
      if (code) {
        var link = 'https://site/?ref=' + code;
        var r1 = $('refLink'); if (r1) r1.value = link;
        var r2 = $('refLink2'); if (r2) r2.value = link;
        var rc = $('refCode'); if (rc) rc.textContent = code;
      }
      var su = $('setUsername'); if (su) su.value = username;
      var se = $('setEmail'); if (se && !se.value) se.value = email;
      try { localStorage.setItem('nexora_user', JSON.stringify({ username: username, email: email, referral_code: code })); } catch (e) {}
    } catch (err) {
      toast('Falha ao carregar perfil: ' + err.message, 'error');
    }
  }

  // Saque: liberado so quando TODO o saldo depositado concluiu um investimento
  // em plano (o backend valida e manda withdrawable/withdraw_unlocked).
  function paintBalances() {
    var avail = Number(state.available) || 0;
    var ok = state.withdrawUnlocked === true;

    var ia = $('invAvailable');
    if (ia) ia.textContent = money(state.balance || 0);
    var act = state.me ? (Number(state.me.active_deposit) || 0) : 0;
    var ias = $('invAvailableSub');
    if (ias) {
      ias.textContent = (Number(state.balance) || 0) <= 0 && act > 0
        ? 'Seu saldo está aplicado no plano ativo (US$ ' + money(act) + ') e volta ao fim do ciclo.'
        : 'descontando saques pendentes';
    }
    var iw = $('invWithdrawable');
    if (iw) iw.textContent = money(avail);
    var iws = $('invWithdrawSub');
    if (iws) iws.textContent = ok
      ? 'liberado — todo o saldo depositado concluiu investimento'
      : 'libera após TODO o saldo depositado concluir um investimento';

    var wa = $('wdAvailable');
    if (wa) wa.textContent = money(avail);
    var wr = $('wdRule');
    if (wr) {
      wr.textContent = ok ? 'Liberado' : 'Bloqueado';
      wr.className = ok ? 'ok' : 'no';
    }
    var wrs = $('wdRuleSub');
    if (wrs) wrs.textContent = ok
      ? 'todo o saldo depositado passou por investimento'
      : 'há saldo depositado que ainda não concluiu um investimento';
    var wrn = $('wdRuleNote');
    if (wrn) wrn.textContent = ok
      ? 'Saque liberado. Máximo disponível: ' + money(avail) + '.'
      : 'Saque bloqueado até TODO o saldo depositado concluir um investimento em plano — a regra também é validada no servidor.';

    var btn = $('wdSubmit');
    if (btn) btn.disabled = (ok === false);
  }


  /* ---------- lists ---------- */
  function rowDeposit(d) {
    var plan = esc(pick(d, ['plan_name', 'plan', 'planName'], 'Saldo'));
    var gw = esc(pick(d, ['gateway_symbol', 'gateway', 'gateway_name', 'method'], '—'));
    var asset = esc(String(pick(d, ['asset'], '') || gw || '—').toUpperCase());
    var amt = pick(d, ['amount_asset', 'amount_asset_units'], null);
    if (amt === null || amt === undefined) amt = pick(d, ['amount', 'value'], 0);
    return '<tr><td><b>' + plan + '</b></td><td>' + esc(amt) + ' ' + asset + '</td><td>' + gw + '</td>' +
      '<td>' + statusPill(pick(d, ['status'], 'pending')) + '</td><td class="muted">' + fmtDate(pick(d, ['created_at', 'createdAt', 'date'], '')) + '</td></tr>';
  }
  function rowTx(t) {
    var type = String(pick(t, ['type', 'kind'], 'deposit')).toLowerCase();
    var label = type.indexOf('with') >= 0 ? '<span class="pill sell">Saque</span>'
      : type.indexOf('invest') >= 0 ? '<span class="pill buy">Staking</span>'
      : '<span class="pill buy">Depósito</span>';
    var asset = esc(String(pick(t, ['asset'], '') || '').toUpperCase());
    var amt = pick(t, ['amount_asset'], null);
    if (amt === null || amt === undefined || Number(amt) === 0 && type.indexOf('accrual') >= 0) {
      var a2 = pick(t, ['amount_asset', 'amount'], 0);
      amt = a2;
    }
    if (amt === null || amt === undefined) amt = pick(t, ['amount', 'value'], 0);
    var show = asset ? (Number(amt) + ' ' + asset) : money(amt);
    // Para rollover/legado sem asset, mostramos valor em USD
    if (!asset || asset === 'UNDEFINED' || asset === 'NULL') show = money(pick(t, ['amount', 'value'], 0));
    return '<tr><td>' + label + '</td><td>' + show + '</td>' +
      '<td>' + statusPill(pick(t, ['status'], 'completed')) + '</td><td class="muted">' + fmtDate(pick(t, ['created_at', 'createdAt', 'date'], '')) + '</td></tr>';
  }

  async function loadRecent() {
    var rd = $('recentDeposits'), rw = $('recentWithdrawals');
    try {
      var dep = await api('/api/my/deposits');
      var arr = Array.isArray(dep) ? dep : (dep && (dep.data || dep.deposits || dep.items)) || [];
      if (rd) rd.innerHTML = arr.length
        ? arr.slice(0, 5).map(function (d) {
            return '<tr><td><b>' + esc(pick(d, ['plan_name', 'plan', 'planName'], 'Saldo')) + '</b></td><td>' + money(pick(d, ['amount', 'value'], 0)) + '</td><td>' + statusPill(pick(d, ['status'], 'pending')) + '</td></tr>';
          }).join('')
        : '<tr class="empty-row"><td colspan="3">Nenhum depósito ainda.</td></tr>';
      try {
        var w = await api('/api/my/withdrawals');
        var warr = Array.isArray(w) ? w : (w && (w.data || w.withdrawals || w.items)) || [];
        if (rw) rw.innerHTML = warr.length
          ? warr.slice(0, 5).map(function (x) {
              var wallet = esc(pick(x, ['wallet_to', 'wallet', 'address'], '—'));
              var short = wallet.length > 14 ? wallet.slice(0, 8) + '…' + wallet.slice(-4) : wallet;
              return '<tr><td>' + money(pick(x, ['amount', 'value'], 0)) + '</td><td class="mono">' + short + '</td><td>' + statusPill(pick(x, ['status'], 'pending')) + '</td></tr>';
            }).join('')
          : '<tr class="empty-row"><td colspan="3">Nenhum saque ainda.</td></tr>';
      } catch (e2) {
        /* fallback: deriva saques do histórico */
        try {
          var h = await api('/api/my/transactions');
          var hall = Array.isArray(h) ? h : (h && (h.data || h.transactions || h.items)) || [];
          var onlyW = hall.filter(function (t) { return String(pick(t, ['type', 'kind'], '')).toLowerCase().indexOf('with') >= 0; });
          if (rw) rw.innerHTML = onlyW.length
            ? onlyW.slice(0, 5).map(function (x) {
                return '<tr><td>' + money(pick(x, ['amount', 'value'], 0)) + '</td><td class="muted">—</td><td>' + statusPill(pick(x, ['status'], 'pending')) + '</td></tr>';
              }).join('')
            : '<tr class="empty-row"><td colspan="3">Nenhum saque ainda.</td></tr>';
        } catch (e3) { if (rw) rw.innerHTML = '<tr class="empty-row"><td colspan="3">Indisponível.</td></tr>'; }
      }
    } catch (err) {
      if (rd) rd.innerHTML = '<tr class="empty-row"><td colspan="3">Falha ao carregar.</td></tr>';
      if (rw) rw.innerHTML = '<tr class="empty-row"><td colspan="3">Falha ao carregar.</td></tr>';
    }
  }

  async function loadHistory() {
    var tb = $('historyBody');
    try {
      var data = await api('/api/my/transactions');
      var arr = Array.isArray(data) ? data : (data && (data.data || data.transactions || data.items)) || [];
      if (tb) tb.innerHTML = arr.length ? arr.map(rowTx).join('') : '<tr class="empty-row"><td colspan="4">Nenhuma transação.</td></tr>';
    } catch (err) { if (tb) tb.innerHTML = '<tr class="empty-row"><td colspan="4">Falha ao carregar.</td></tr>'; }
  }
  async function loadDeposits() {
    var tb = $('depositsBody');
    try {
      var data = await api('/api/my/deposits');
      var arr = Array.isArray(data) ? data : (data && (data.data || data.deposits || data.items)) || [];
      if (tb) tb.innerHTML = arr.length ? arr.map(rowDeposit).join('') : '<tr class="empty-row"><td colspan="5">Nenhum depósito.</td></tr>';
    } catch (err) { if (tb) tb.innerHTML = '<tr class="empty-row"><td colspan="5">Falha ao carregar.</td></tr>'; }
  }
  async function loadReferrals() {
    var tb = $('referralsBody');
    try {
      var data = await api('/api/my/referrals');
      var arr = Array.isArray(data) ? data : (data && (data.data || data.referrals || data.items)) || [];
      // Sem coluna de bônus: a comissão foi removida do produto. Mostrar "$0,00
      // ganho" para cada indicado seria sugerir que ainda existe um pagamento.
      if (tb) tb.innerHTML = arr.length
        ? arr.map(function (r) {
            return '<tr><td><b>' + esc(pick(r, ['username', 'name', 'email', 'user'], '—')) + '</b></td><td class="muted">' + fmtDate(pick(r, ['created_at', 'createdAt', 'date'], '')) + '</td></tr>';
          }).join('')
        : '<tr class="empty-row"><td colspan="2">Nenhuma conta usou seu link ainda.</td></tr>';
    } catch (err) { if (tb) tb.innerHTML = '<tr class="empty-row"><td colspan="2">Falha ao carregar.</td></tr>'; }
  }

  /* ---------- planos & gateways ---------- */
  // Planos vêm do servidor com a taxa de configuração. A tela diz, no
  // mínimo e no máximo de cada plano, o mesmo número que o servidor usa —
  // fora da faixa, o servidor rejeita o investimento (POST /api/my/invest).
  function paintPlanHint() {
    var sel = $('depPlan'), panel = $('depPlanHint');
    if (!sel || !panel) return;
    var cur = state.plans.filter(function (p) { return String(p.id) === String(sel.value); })[0];
    if (!cur) { panel.innerHTML = '<p class="desc">Sem planos ativos.</p>'; return; }
    var daily = (Number(cur.daily_rate) / 100);
    panel.innerHTML =
      '<div class="calc-result"><span>Taxa (configurada)</span><b>' +
        String(cur.daily_rate).replace('.', ',') + '% ao dia</b></div>' +
      '<div class="calc-result"><span>Faixa aceita</span><b>' + money(cur.min_deposit) + ' — ' +
        money(cur.max_deposit) + '</b></div>' +
      '<div class="calc-result"><span>Duração</span><b>' + cur.duration_days + ' dia(s)</b></div>' +
      '<div class="calc-result"><span>Lucro no valor mínimo</span><b>' +
        money(Number(cur.min_deposit) * daily * Number(cur.duration_days)) + '</b></div>' +
      (cur.simulated === false ? '' :
        '<p class="hero-note" style="color:#f59e0b">Simulação — taxa de configuração, sem lastro.</p>');
  }
  async function loadPlans() {
    var sel = $('depPlan');
    try {
      var data = await api('/api/public/plans');
      state.plans = Array.isArray(data) ? data : [];
      if (sel) {
        sel.innerHTML = state.plans.length
          ? state.plans.map(function (p) {
              return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
            }).join('')
          : '<option value="">Nenhum plano ativo</option>';
      }
      paintPlanHint();
    } catch (err) {
      state.plans = [];
      if (sel) sel.innerHTML = '<option value="">Falha ao carregar planos</option>';
      var panel = $('depPlanHint');
      if (panel) panel.innerHTML = '<p class="desc">Não foi possível carregar os planos.</p>';
    }
    await loadGateways();
    await loadPositions();
    await loadAccruals();
  }
  async function loadGateways() {
    var s1 = $('depGateway'), s2 = $('wdGateway');
    try {
      var data = await api('/api/public/gateways');
      var arr = Array.isArray(data) ? data : (data && (data.data || data.gateways || data.items)) || [];
      state.gateways = arr;
      var html = arr.length
        ? arr.map(function (g) {
            var id = g.id ?? g._id ?? g.code ?? g.name;
            return '<option value="' + esc(id) + '">' + esc(g.name || g.label || id) + '</option>';
          }).join('')
        : '<option value="">Nenhum gateway disponível</option>';
      if (s1) s1.innerHTML = html;
      if (s2) s2.innerHTML = html;
      paintGatewayInfo();
    } catch (err) {
      if (s1) s1.innerHTML = '<option value="">Falha ao carregar</option>';
      if (s2) s2.innerHTML = '<option value="">Falha ao carregar</option>';
    }
  }
  function paintGatewayInfo() {
    var sel = $('depGateway'), box = $('gatewayInfo');
    if (!sel || !box) return;
    var g = state.gateways.filter(function (x) { return String(x.id ?? x._id ?? x.code ?? x.name) === String(sel.value); })[0];
    if (g && (g.address || g.wallet || g.instructions)) {
      box.hidden = false;
      box.innerHTML = 'Send to: <b>' + esc(g.address || g.wallet || '') + '</b>' + (g.instructions ? '<br>' + esc(g.instructions) : '');
    } else { box.hidden = true; box.innerHTML = ''; }
  }

  /* ---------- carteira: redes + conexão ---------- */
  function walletHint(net) {
    var n = String(net || '').toUpperCase();
    if (n.indexOf('SOL') >= 0 || n.indexOf('SPL') >= 0) return 'Use a Solflare (Solana) para enviar nesta rede.';
    if (n.indexOf('BEP20') >= 0 || n.indexOf('ERC20') >= 0 || n.indexOf('ETH') >= 0 || n.indexOf('BNB') >= 0 || n.indexOf('POLYGON') >= 0 || n.indexOf('ARBITRUM') >= 0 || n.indexOf('EVM') >= 0) return 'Use a MetaMask para enviar nesta rede.';
    if (n.indexOf('TRC20') >= 0 || n.indexOf('TRX') >= 0) return 'Use TronLink ou o app da sua corretora (rede Tron).';
    return 'Envie pelo app oficial da moeda, sempre na rede indicada acima.';
  }
  var WALLET_INSTALL = {
    metamask: { name: 'MetaMask', url: 'https://metamask.io/download/' },
    phantom: { name: 'Phantom', url: 'https://phantom.app/download' },
    solflare: { name: 'Solflare', url: 'https://solflare.com/downloads' }
  };
  var walletRetryKey = null;
  function walletKind(net) {
    var n = String(net || '').toUpperCase();
    if (n.indexOf('SOL') >= 0 || n.indexOf('SPL') >= 0) return 'sol';
    if (n.indexOf('BEP20') >= 0 || n.indexOf('ERC20') >= 0 || n.indexOf('ETH') >= 0 || n.indexOf('BNB') >= 0 || n.indexOf('POLYGON') >= 0 || n.indexOf('ARBITRUM') >= 0 || n.indexOf('EVM') >= 0) return 'evm';
    return 'other';
  }
  function selectedGateway() {
    var sel = $('topGateway');
    if (!sel || !sel.value) return null;
    var g = state.gateways.filter(function (x) { return String(x.id ?? x._id ?? x.code ?? x.name) === String(sel.value); })[0];
    return g || null;
  }
  // Carteiras aceitas no depósito — controladas pelo admin (Config Site).
  // Sem a chave salva no banco, valem os defaults: só a Solflare habilitada.
  var WALLET_DEFAULT_ENABLED = { solflare: true, phantom: false, metamask: false };
  function walletEnabled(key) {
    var v = state.settings ? state.settings['wallet_' + key + '_enabled'] : null;
    if (v == null || v === '') return !!WALLET_DEFAULT_ENABLED[key];
    var s = String(v).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'on';
  }
  function firstEnabledSolanaKey() {
    if (walletEnabled('solflare')) return 'solflare';
    if (walletEnabled('phantom')) return 'phantom';
    return null;
  }
  // Rede dos pagamentos Solana definida pelo admin: 'devnet' | 'testnet' | 'mainnet-beta'.
  function solPayNetwork() {
    var v = state.settings ? state.settings.solana_network : null;
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (s === 'mainnet' || s === 'mainnet-beta') return 'mainnet-beta';
    if (s === 'testnet') return 'testnet';
    return 'devnet';
  }
  function solNetLabel(net) {
    var n = String(net == null ? '' : net).toLowerCase();
    if (n === 'mainnet' || n === 'mainnet-beta') return 'Mainnet (SOL real)';
    if (n === 'testnet') return 'Testnet (teste)';
    return 'Devnet (teste)';
  }
  // Normaliza o que a carteira informar (ex.: 'mainnet', 'devnet', cluster) para a mesma nomenclatura.
  function normalizeWalletNet(v) {
    var s = String(v == null ? '' : v).toLowerCase();
    if (!s || s.length > 40) return '';
    if (s.indexOf('main') >= 0) return 'mainnet-beta';
    if (s.indexOf('test') >= 0) return 'testnet';
    if (s.indexOf('dev') >= 0) return 'devnet';
    return '';
  }
  function showNetworkWarn(msg) {
    var el = $('topNetworkWarn');
    if (!el) return;
    if (msg) { el.hidden = false; el.textContent = msg; }
    else { el.hidden = true; el.textContent = ''; }
  }
  function paintWalletGrid() {
    var map = { metamask: 'btnMetaMask', phantom: 'btnPhantom', solflare: 'btnSolflare' };
    var any = false;
    Object.keys(map).forEach(function (k) {
      var b = $(map[k]);
      if (!b) return;
      var on = walletEnabled(k);
      b.style.display = on ? '' : 'none';
      if (on) any = true;
    });
    var grid = $('walletGrid');
    if (grid) grid.style.display = any ? '' : 'none';
    return any;
  }
  async function loadPublicSettings() {
    try {
      var s = await api('/api/public/settings');
      if (s && typeof s === 'object' && !Array.isArray(s)) state.settings = s;
    } catch (e) {}
    paintWalletGrid();
    paintWalletRecommend();
    paintWallet();
  }
  function paintWalletRecommend() {
    var rec = $('walletRecommend');
    var g = selectedGateway();
    var bm = $('btnMetaMask'), bp = $('btnPhantom'), bs = $('btnSolflare');
    [bm, bp, bs].forEach(function (b) { if (b) b.classList.remove('recommended'); });
    document.querySelectorAll('.wallet-btn .rec-tag').forEach(function (t) { t.hidden = true; });
    if (!g) { if (rec) rec.textContent = 'Selecione um ativo acima para ver a carteira recomendada.'; return; }
    var kind = walletKind(g.network);
    var label = esc(g.symbol || '') + ' na rede ' + esc(g.network || '');
    function mark(btn) { if (!btn) return; btn.classList.add('recommended'); var t = btn.querySelector('.rec-tag'); if (t) t.hidden = false; }
    if (kind === 'evm') {
      if (walletEnabled('metamask')) {
        mark(bm);
        if (rec) rec.innerHTML = 'Para <b>' + label + '</b>, use <b>MetaMask</b> (destacada). Clique para conectar.';
      } else if (rec) {
        rec.innerHTML = 'A carteira <b>MetaMask</b> está <b>desabilitada</b> no momento. Use o hash da transferência no passo 2.';
      }
    } else if (kind === 'sol') {
      var names = [];
      if (walletEnabled('phantom')) names.push('Phantom');
      if (walletEnabled('solflare')) names.push('Solflare');
      var firstKey = firstEnabledSolanaKey();
      if (firstKey === 'phantom') mark(bp);
      else if (firstKey === 'solflare') mark(bs);
      if (names.length && rec) {
        rec.innerHTML = 'Para <b>' + label + '</b>, use <b>' + names.join('</b> ou <b>') + '</b>. Ao clicar em <b>Depositar</b>, a carteira abre para você <b>aprovar a transação</b> — nada é cobrado sem a sua aprovação.';
      } else if (rec) {
        rec.innerHTML = 'As carteiras Solana estão <b>desabilitadas</b> no momento. Use o hash da transferência no passo 2.';
      }
    } else {
      if (rec) rec.innerHTML = 'Para <b>' + label + '</b>, envie pelo app oficial da moeda (ou corretora) e cole o hash no passo 2.';
    }
  }
  function showWalletInstall(key) {
    var w = WALLET_INSTALL[key];
    if (!w) return;
    walletRetryKey = key;
    var g = selectedGateway();
    var asset = g ? (' para operar ' + (g.symbol || '') + ' na rede ' + (g.network || '')) : '';
    var box = $('walletInstallBox');
    var title = $('walletInstallTitle');
    var steps = $('walletInstallSteps');
    var link = $('walletInstallLink');
    if (title) title.textContent = w.name + ' não encontrada — instale para continuar';
    if (steps) steps.innerHTML =
      '<li>Clique em <b>Instalar agora</b> e instale a extensão ' + esc(w.name) + ' no seu navegador.</li>' +
      '<li>Crie ou importe sua carteira' + esc(asset) + ' e volte a esta página.</li>' +
      '<li>Clique em <b>Já instalei, tentar de novo</b> e conecte.</li>';
    if (link) link.href = w.url;
    if (box) { box.hidden = false; try { box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {} }
  }
  function hideWalletInstall() { var box = $('walletInstallBox'); if (box) box.hidden = true; }
  async function loadWalletGateways() {
    var sel = $('topGateway');
    try {
      var data = await api('/api/public/gateways');
      var arr = Array.isArray(data) ? data : (data && (data.data || data.gateways || data.items)) || [];
      state.gateways = arr;
      if (sel) sel.innerHTML = arr.length
        ? arr.map(function (g) {
            var id = g.id ?? g._id ?? g.code ?? g.name;
            return '<option value="' + esc(id) + '">' + esc(g.symbol || g.name || id) + ' — ' + esc(g.network || '') + '</option>';
          }).join('')
        : '<option value="">Nenhuma rede disponível</option>';
      paintTopGateway();
    } catch (err) { if (sel) sel.innerHTML = '<option value="">Falha ao carregar redes</option>'; }
  }
  function paintTopGateway() {
    var sel = $('topGateway'), box = $('topGatewayInfo');
    if (!sel || !box) return;
    var g = state.gateways.filter(function (x) { return String(x.id ?? x._id ?? x.code ?? x.name) === String(sel.value); })[0];
    if (!g) { box.hidden = true; box.innerHTML = ''; return; }
    var addr = g.wallet_address || g.address || g.wallet || '';
    box.hidden = false;
    var netLine = '';
    if (walletKind(g.network) === 'sol') {
      var pn = solPayNetwork();
      netLine = '<br><span class="form-hint" style="color:#f0b90b">Rede de pagamento: <b>' + esc(solNetLabel(pn)) + '</b> — a carteira precisa estar na mesma rede.</span>';
    }
    box.innerHTML = 'Rede: <b>' + esc(g.network || '—') + ' (' + esc(g.symbol || g.name || '') + ')</b>' +
      '<br>Endereço da plataforma: <b class="mono">' + esc(addr) + '</b>' +
      '<br><span class="form-hint">' + esc(walletHint(g.network)) + '</span>' + netLine;
    var hid = $('topAddrValue');
    if (hid) hid.value = addr;
    paintWalletRecommend();
    paintWallet();
    paintSolConvert();
  }

  function getWallet() {
    try { return JSON.parse(localStorage.getItem('nexora_wallet') || 'null'); }
    catch (e) { return null; }
  }
  function persistWalletServer(chain, address) {
    return api('/api/auth/wallet', { method: 'POST', body: { chain: chain, address: address } }).catch(function () {});
  }
  function saveWallet(type, address) {
    try { localStorage.setItem('nexora_wallet', JSON.stringify({ type: type, address: address })); } catch (e) {}
    paintWallet();
  }
  function paintWallet() {
    var st = $('walletStatus'), dc = $('walletDisconnect');
    var w = getWallet();
    var submit = $('topupSubmit');
    var hash = $('topTxHash');
    var hashWrap = $('topHashWrap');
    var g = selectedGateway();
    var kind = g ? walletKind(g.network) : 'other';
    var addr = g ? (g.wallet_address || g.address || g.wallet || '') : '';
    var solKey = firstEnabledSolanaKey();
    var solName = solKey === 'phantom' ? 'Phantom' : 'Solflare';
    // No fluxo Solana nao ha hash: a carteira assina a transferencia no proprio app.
    if (hashWrap) hashWrap.hidden = (kind === 'sol');
    if (w) {
      var amt = $('topAmount') ? Number($('topAmount').value) : 0;
      var dest = addr
        ? ' Destino: <b class="mono">' + esc(addr) + '</b>' +
          (g && g.network ? ' (rede ' + esc(g.network) + ')' : '') +
          (amt > 0 ? ' · valor <b>' + money(amt) + '</b>' : '') + '.'
        : ' Selecione a moeda/rede no passo 1 para ver o endereço de destino.';
      if (kind === 'sol') {
        if (st) st.innerHTML = 'Carteira conectada: <b>' + esc(w.type) + '</b> · <span class="mono">' + esc(w.address) +
          '</span>. Ao clicar em <b>Depositar</b>, a <b>' + esc(solName) + '</b> abre para você <b>aprovar a transação</b>.' + dest;
        if (submit) submit.textContent = 'Depositar com ' + solName;
      } else {
        if (st) st.innerHTML = 'Carteira conectada: <b>' + esc(w.type) + '</b> · <span class="mono">' + esc(w.address) + '</span>.' + dest;
        if (submit) submit.textContent = 'Aprovar depósito e creditar';
      }
      if (hash) hash.required = false;
    } else {
      if (kind === 'sol') {
        if (!solKey) {
          if (st) st.textContent = 'Nenhuma carteira Solana está habilitada no momento. Use o hash da transferência no passo 2.';
          if (submit) submit.textContent = 'Enviar para validação';
          if (hash) hash.required = true;
        } else {
          if (st) st.innerHTML = 'Digite o valor e clique em <b>Depositar</b>: a <b>' + esc(solName) + '</b> abre para você <b>aprovar a transação</b>. O valor em USD é convertido em SOL e verificado na blockchain antes de creditar — nada é cobrado sem a sua aprovação.';
          if (submit) submit.textContent = 'Depositar com ' + solName;
          if (hash) hash.required = false;
        }
      } else {
        if (st) st.textContent = 'Nenhuma carteira conectada. Sem carteira, o depósito fica pendente até o hash ser validado pelo admin.';
        if (submit) submit.textContent = 'Enviar para validação';
        if (hash) hash.required = true;
      }
    }
    if (dc) dc.style.display = w ? '' : 'none';
  }

  /* ---------- Solana: conversao USD->SOL e pagamento on-chain ---------- */
  var solPriceCache = { usd: null, at: 0 };
  async function fetchSolPrice() {
    if (solPriceCache.usd && (Date.now() - solPriceCache.at) < 60000) return solPriceCache.usd;
    try {
      var d = await api('/api/solana/price');
      var p = d && Number(d.usd);
      if (isFinite(p) && p > 0) { solPriceCache = { usd: p, at: Date.now() }; return p; }
    } catch (e) {}
    return null;
  }
  async function paintSolConvert() {
    var el = $('topSolConvert');
    if (!el) return;
    var g = selectedGateway();
    if (!g || walletKind(g.network) !== 'sol') { el.textContent = ''; return; }
    var amt = $('topAmount') ? Number($('topAmount').value) : 0;
    if (!isFinite(amt) || amt <= 0) { el.textContent = 'Digite o valor em USD para ver a conversão em SOL.'; return; }
    el.textContent = 'Calculando…';
    var p = await fetchSolPrice();
    if (!p) { el.textContent = 'Cotação do SOL indisponível no momento.'; return; }
    el.innerHTML = '≈ <b>' + (amt / p).toFixed(6) + ' SOL</b> (SOL = $' + p.toFixed(2) + ') · Rede: <b>' + esc(solNetLabel(solPayNetwork())) + '</b>';
  }
  async function ensureSolanaProvider() {
    var order = [];
    if (walletEnabled('solflare')) order.push('solflare');
    if (walletEnabled('phantom')) order.push('phantom');
    if (!order.length) throw new Error('Nenhuma carteira Solana está habilitada no momento.');
    var key = null, provider = null;
    for (var i = 0; i < order.length; i++) {
      provider = solanaProvider(order[i]);
      if (provider) { key = order[i]; break; }
    }
    if (!key) {
      var first = order[0];
      showWalletInstall(first);
      throw new Error('Instale a ' + (WALLET_INSTALL[first] ? WALLET_INSTALL[first].name : first) + ' para pagar em Solana.');
    }
    var r = null;
    // Reusa a conexao existente; se ainda nao houver, abre a carteira para autorizar.
    if (!provider.publicKey || provider.isConnected === false) {
      try { r = await provider.connect(); }
      catch (e) { throw new Error('conexão da carteira cancelada'); }
    }
    var pkObj = (r && (r.publicKey || r.address)) || provider.publicKey;
    var pk = pkObj ? (pkObj.toString ? pkObj.toString() : String(pkObj)) : '';
    if (!pk) throw new Error('a carteira não retornou o endereço');
    await persistWalletServer('solana', pk);
    saveWallet(key === 'phantom' ? 'Phantom' : 'Solflare', pk);
    return { provider: provider, address: pk };
  }
  async function solanaPayFlow() {
    var btn = $('topupSubmit');
    var gateway = $('topGateway') && $('topGateway').value;
    var amount = $('topAmount') ? Number($('topAmount').value) : 0;
    if (!gateway || !isFinite(amount) || amount <= 0) { toast('Escolha a moeda/rede e o valor.', 'error'); return; }
    if (btn) btn.disabled = true;
    showNetworkWarn('');
    var wantNet = solPayNetwork();
    var walletName = 'carteira';
    try {
      // 1) conecta a carteira Solana (abre a extensao, se necessario)
      var wallet = await ensureSolanaProvider();
      walletName = (wallet.provider && wallet.provider.isPhantom) ? 'Phantom' : 'Solflare';
      // 2) o servidor valida o gateway e converte USD -> lamports (cotacao real)
      var intent = await api('/api/solana/pay-intent', { method: 'POST', body: { amount_usd: amount, gateway_id: gateway } });
      if (!intent || !intent.lamports) throw new Error('não foi possível preparar o pagamento');
      wantNet = normalizeWalletNet(intent.network) || wantNet;
      // 3) confere a rede da carteira (quando ela informa) antes de pedir aprovacao
      var curNet = normalizeWalletNet(wallet.provider && (wallet.provider.network || wallet.provider.cluster));
      if (curNet && curNet !== wantNet) {
        showNetworkWarn('Sua carteira está em ' + solNetLabel(curNet) + ', mas este depósito é em ' + solNetLabel(wantNet) +
          '. Abra a ' + walletName + ' → Configurações → Rede, mude para ' + solNetLabel(wantNet) + ' e tente novamente.');
        toast('Rede da carteira diferente da rede do depósito.', 'error');
        return;
      }
      // Se a carteira permitir trocar de rede por codigo, tenta alinhar automaticamente.
      if (!curNet && wallet.provider && typeof wallet.provider.changeNetwork === 'function') {
        try { await wallet.provider.changeNetwork(wantNet); } catch (e) {}
      }
      // 4) monta a transacao; o navegador fala com a rede via proxy do servidor
      var web3 = await import('https://esm.sh/@solana/web3.js@1');
      var rpcFetch = function (url, opts) {
        var body = (opts && opts.body) ? opts.body : '{}';
        return fetch('/api/solana/rpc', { method: 'POST', headers: authHeaders(), body: body });
      };
      var conn = new web3.Connection('https://rpc.nexora.local', { commitment: 'confirmed', fetch: rpcFetch });
      var from = new web3.PublicKey(wallet.address);
      var to = new web3.PublicKey(intent.destination);
      var tx = new web3.Transaction().add(
        web3.SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: intent.lamports })
      );
      tx.feePayer = from;
      var bh = await conn.getLatestBlockhash('confirmed');
      tx.recentBlockhash = bh.blockhash;
      // 5) assina na carteira e envia. Se o usuario recusar, NADA e cobrado.
      var signed = await wallet.provider.signTransaction(tx);
      var signedTx = (signed && signed.serialize) ? signed : (signed && signed.signedTransaction);
      if (!signedTx || !signedTx.serialize) throw new Error('a carteira não retornou a transação assinada');
      var signature = await conn.sendRawTransaction(signedTx.serialize(), { skipPreflight: false });
      toast('Transação enviada. Confirmando na blockchain…', 'success');
      // 6) registra o deposito; o servidor verifica on-chain ANTES de creditar.
      var dep = await api('/api/my/deposits', { method: 'POST', body: { amount: amount, gateway_id: gateway, tx_hash: signature } });
      if (dep && dep.status === 'active') {
        toast('Pagamento confirmado! Saldo de ' + money(amount) + ' creditado.', 'success');
        var tf = $('topupForm'); if (tf) tf.reset();
        loadRecent(); loadMe(); loadPositions();
      } else {
        toast('Pagamento registrado. Aguardando validação do admin.', 'success');
      }
      paintSolConvert();
    } catch (err) {
      // Erro/cancelamento em qualquer etapa: o saldo NAO e creditado.
      var msg = err && err.message ? err.message : String(err);
      if (/incompatibilidade de rede|rede.*(devnet|mainnet|testnet)|(devnet|mainnet|testnet).*rede|network|cluster/i.test(msg)) {
        showNetworkWarn('Sua carteira parece estar em outra rede. Abra a ' + walletName + ' → Configurações → Rede, mude para ' +
          solNetLabel(wantNet) + ' e tente novamente.');
        toast('Rede da carteira diferente da rede do depósito.', 'error');
      } else {
        toast('Pagamento não concluído: ' + msg, 'error');
      }
    } finally { if (btn) btn.disabled = false; }
  }
  async function connectEVM(provider, type) {
    if (!provider || !provider.request) { toast('Carteira ' + type + ' não encontrada neste navegador.', 'error'); return; }
    try {
      var accs = await provider.request({ method: 'eth_requestAccounts' });
      if (!accs || !accs.length) throw new Error('nenhuma conta autorizada');
      var address = String(accs[0]).trim();
      await persistWalletServer('evm', address);
      saveWallet(type, address);
      toast(type + ' conectada!', 'success');
    } catch (err) { toast('Falha ao conectar: ' + (err && err.message ? err.message : err), 'error'); }
  }
  function solanaProvider(key) {
    var sol = window.solana;
    if (key === 'phantom') {
      if (window.phantom && window.phantom.solana && window.phantom.solana.isPhantom) return window.phantom.solana;
      if (sol && sol.isPhantom) return sol;
      return null;
    }
    if (key === 'solflare') {
      if (window.solflare && window.solflare.isSolflare) return window.solflare;
      if (sol && sol.isSolflare) return sol;
      return null;
    }
    return null;
  }
  function connectWalletByKey(key) {
    hideWalletInstall();
    if (!walletEnabled(key)) { toast('Esta carteira está desabilitada no momento.', 'error'); return; }
    if (key === 'metamask') {
      if (!window.ethereum) { showWalletInstall('metamask'); return; }
      connectEVM(window.ethereum, 'MetaMask');
      return;
    }
    if (key !== 'phantom' && key !== 'solflare') return;
    (async function () {
      var provider = solanaProvider(key);
      if (!provider) { showWalletInstall(key); return; }
      try {
        var r = await provider.connect();
        var pkObj = r && (r.publicKey || r.address) ? (r.publicKey || r.address) : provider.publicKey;
        var pk = pkObj ? (pkObj.toString ? pkObj.toString() : String(pkObj)) : '';
        if (!pk) throw new Error('carteira não retornou o endereço');
        await persistWalletServer('solana', pk);
        saveWallet(key === 'phantom' ? 'Phantom' : 'Solflare', pk);
        toast((key === 'phantom' ? 'Phantom' : 'Solflare') + ' conectada! Ao clicar em Depositar, a carteira abre para você aprovar a transação.', 'success');
      } catch (err) { toast('Falha ao conectar: ' + (err && err.message ? err.message : err), 'error'); }
    })();
  }
  function bindWallet() {
    var bm = $('btnMetaMask');
    if (bm) bm.addEventListener('click', function () { connectWalletByKey('metamask'); });
    var bp = $('btnPhantom');
    if (bp) bp.addEventListener('click', function () { connectWalletByKey('phantom'); });
    var bs = $('btnSolflare');
    if (bs) bs.addEventListener('click', function () { connectWalletByKey('solflare'); });
    var rt = $('walletInstallRetry');
    if (rt) rt.addEventListener('click', function () { if (walletRetryKey) connectWalletByKey(walletRetryKey); });
    var dc = $('walletDisconnect');
    if (dc) dc.addEventListener('click', async function () {
      try { localStorage.removeItem('nexora_wallet'); } catch (e) {}
      try { await api('/api/auth/wallet/disconnect', { method: 'POST', body: {} }); } catch (e) {}
      paintWallet();
      toast('Carteira desconectada.', 'success');
    });
  }

  /* ---------- forms ---------- */
  function bindForms() {
    /* Investir em plano: AUTOMÁTICO via /api/my/invest. Debitamos o saldo do
       usuário na hora e abrimos a posição (o rendimento começa hoje). Nenhuma
       aprovação de admin aqui — o depósito (1x) que espera aprovação está na
       tela "Adicionar Saldo". */
    var df = $('depositForm');
    if (df) {
      var dpl = $('depPlan');
      if (dpl) dpl.addEventListener('change', paintPlanHint);
      var das = $('depAsset');
      if (das) das.addEventListener('change', function () { updateDepAssetUI(); });
      var dam = $('depAmount');
      if (dam) dam.addEventListener('input', updateDepAssetUI);
      df.addEventListener('submit', async function (e) {
        e.preventDefault();
        var btn = $('depSubmit');
        var plan = dpl && dpl.value;
        var asset = das && das.value;
        var amount = dam && Number(dam.value);
        if (!asset) { toast('Selecione a moeda para investir.', 'error'); return; }
        if (!plan) { toast('Escolha um plano.', 'error'); return; }
        if (!isFinite(amount) || amount <= 0) { toast('Informe o valor.', 'error'); return; }
        var b = getAssetBal(asset);
        if (amount > (Number(b.available) || 0) + 1e-12) {
          toast('Saldo de ' + asset + ' insuficiente (disponível: ' + Number(b.available || 0) + '). Faça um depósito nessa moeda.', 'error');
          return;
        }
        var cur = state.plans.filter(function (p) { return String(p.id) === String(plan); })[0];
        if (cur && Number(b.usd_price) > 0) {
          var usd = amount * Number(b.usd_price);
          if (usd < Number(cur.min_deposit) || usd > Number(cur.max_deposit)) {
            toast('Valor equivale a US$ ' + money(usd) + ' — fora da faixa do plano (' + money(cur.min_deposit) + ' — ' + money(cur.max_deposit) + ').', 'error');
            return;
          }
        } else if (cur && (amount < Number(cur.min_deposit) || amount > Number(cur.max_deposit))) {
          toast('Valor fora da faixa do plano (' + money(cur.min_deposit) + ' — ' + money(cur.max_deposit) + ').', 'error');
          return;
        }
        if (btn) btn.disabled = true;
        try {
          var body = { plan_id: plan, amount: amount, asset: asset };
          await api('/api/my/invest', { method: 'POST', body: body });
          toast('Staking realizado! O rendimento começa a contar hoje.', 'success');
          if (dam) dam.value = '';
          paintPlanHint();
          await loadPlans();
          await loadPositions();
          loadMe();
        } catch (err) { toast('Erro: ' + err.message, 'error'); }
        finally { if (btn) btn.disabled = false; }
      });
    }

    /* Top-up manual: envia hash da transferência para validação do saldo */
    var tg = $('topGateway');
    if (tg) tg.addEventListener('change', paintTopGateway);
    var cb = $('copyTopAddrBtn');
    if (cb) cb.addEventListener('click', function () {
      var v = $('topAddrValue') && $('topAddrValue').value;
      copyText(v, 'Endereço copiado! Confira a rede antes de enviar.');
    });
    var tf = $('topupForm');
    var ta = $('topAmount');
    if (ta) ta.addEventListener('input', function () { paintWallet(); paintSolConvert(); });
    if (tf) tf.addEventListener('submit', async function (e) {
      e.preventDefault();
      // Gateway Solana: fluxo de pagamento on-chain (carteira -> assinatura ->
      // verificacao -> credito). Nada e creditado se o pagamento falhar.
      var sel = selectedGateway();
      if (sel && walletKind(sel.network) === 'sol') { solanaPayFlow(); return; }
      var btn = $('topupSubmit');
      var gateway = $('topGateway') && $('topGateway').value;
      var amount = $('topAmount') && Number($('topAmount').value);
      var tx = $('topTxHash') && $('topTxHash').value.trim();
      var w = getWallet();
      var gobj = sel;
      var gsym = gobj && (gobj.symbol || gobj.code || gobj.name);
      if (!gateway || !isFinite(amount) || amount <= 0) { toast('Escolha a moeda/rede e o valor.', 'error'); return; }
      if (!w && (!tx || tx.length < 5)) { toast('Sem carteira conectada, cole o hash da transferência para validação.', 'error'); return; }
      if (btn) btn.disabled = true;
      try {
        var body = { amount: amount, gateway_id: gateway };
        if (gsym) body.asset = String(gsym).toUpperCase();
        if (tx) body.tx_hash = tx;
        var dep = await api('/api/my/deposits', { method: 'POST', body: body });
        // O status real vem do servidor: com carteira salva o deposito entra
        // 'active' (saldo creditado na hora); sem carteira fica 'pending'.
        if (dep && dep.status === 'active') {
          toast('Depósito aprovado automaticamente — saldo creditado!', 'success');
        } else {
          toast('Depósito enviado! Saldo liberado após validação do admin.', 'success');
        }
        tf.reset(); loadRecent(); loadMe(); loadPositions();
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
      finally { if (btn) btn.disabled = false; }
    });

    var wf = $('withdrawForm');
    if (wf) wf.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = $('wdSubmit');
      var asset = $('wdAsset') && $('wdAsset').value;
      var amount = $('wdAmount') && Number($('wdAmount').value);
      var gateway = $('wdGateway') && $('wdGateway').value;
      var wallet = $('wdWallet') && $('wdWallet').value.trim();
      if (!asset) { toast('Selecione a moeda.', 'error'); return; }
      if (!isFinite(amount) || amount <= 0 || !gateway || !wallet) { toast('Preencha moeda, quantidade, gateway e carteira.', 'error'); return; }
      if (state.withdrawUnlocked !== true) {
        toast('Saque bloqueado até todo o saldo depositado concluir um investimento em plano.', 'error');
        return;
      }
      var b = getAssetBal(asset);
      if (amount > (Number(b.available) || 0) + 1e-12) { toast('Saldo de ' + asset + ' insuficiente (disponível: ' + Number(b.available || 0) + ').', 'error'); return; }
      if (btn) btn.disabled = true;
      try {
        await api('/api/my/withdrawals', { method: 'POST', body: { amount: amount, asset: asset, gateway_id: gateway, gateway: gateway, wallet_to: wallet, wallet: wallet } });
        toast('Saque solicitado!', 'success');
        wf.reset(); loadRecent(); loadMe();
        paintWithdrawAssets();
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
      finally { if (btn) btn.disabled = false; }
    });

    var sf = $('securityForm');
    if (sf) sf.addEventListener('submit', async function (e) {
      e.preventDefault();
      var cur = $('secCurrent') && $('secCurrent').value;
      var nw = $('secNew') && $('secNew').value;
      var nw2 = $('secNew2') && $('secNew2').value;
      if (!cur || !nw) { toast('Preencha as senhas.', 'error'); return; }
      if (nw !== nw2) { toast('Nova senha e confirmação divergem.', 'error'); return; }
      var btn = $('secSubmit'); if (btn) btn.disabled = true;
      try {
        await api('/api/me/change-password', { method: 'POST', body: { current_password: cur, currentPassword: cur, new_password: nw, newPassword: nw } });
        toast('Senha atualizada!', 'success');
        sf.reset();
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
      finally { if (btn) btn.disabled = false; }
    });

    var st = $('settingsForm');
    if (st) st.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = $('setEmail') && $('setEmail').value.trim();
      if (!email) { toast('Informe um email válido.', 'error'); return; }
      var btn = $('setSubmit'); if (btn) btn.disabled = true;
      try {
        await api('/api/me', { method: 'PUT', body: { email: email } });
        toast('Conta atualizada!', 'success');
        loadMe();
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
      finally { if (btn) btn.disabled = false; }
    });
  }

  /* ---------- copy buttons ---------- */
  function copyText(v, okMsg) {
    if (!v) { toast('Link ainda não carregado.', 'error'); return; }
    function done() { toast(okMsg || 'Copiado!', 'success'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(v).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = v; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta); done();
      } catch (e) { toast('Não foi possível copiar.', 'error'); }
    }
  }
  function bindCopy() {
    var b1 = $('copyRefBtn'), b2 = $('copyRefBtn2');
    if (b1) b1.addEventListener('click', function () { copyText($('refLink') && $('refLink').value, 'Affiliate link copiado!'); });
    if (b2) b2.addEventListener('click', function () { copyText($('refLink2') && $('refLink2').value, 'Affiliate link copiado!'); });
  }

  /* ---------- logout ---------- */
  var lo = $('logoutLink');
  if (lo) lo.addEventListener('click', function (e) { e.preventDefault(); logout(); });

  /* ---------- boot ---------- */
  /* Aviso de simulação: some apenas se o servidor declarar simulated=false.
     Enquanto o fetch não responde, o aviso fica oculto — nunca o contrário. */
  function paintSimNotice() {
    api('/api/public/plans').then(function (d) {
      var arr = Array.isArray(d) ? d : [];
      var sim = arr.length ? arr[0].simulated !== false : true;
      var n = $('simNotice'); if (n) n.style.display = sim ? '' : 'none';
      var s = $('simStats'); if (s) s.style.display = sim ? '' : 'none';
    }).catch(function () { /* rede caiu: mantém o aviso como está */ });
  }
  bindForms();
  bindCopy();
  bindWallet();
  loadPublicSettings();
  paintWallet();
  paintSimNotice();
  /* ?view=xxx → normaliza para hash na primeira carga */
  try {
    var qv = new URLSearchParams(window.location.search).get('view');
    if (qv && TITLES[qv.toLowerCase()] && !window.location.hash) {
      window.location.hash = '#' + qv.toLowerCase();
    }
  } catch (e) {}
  render(currentRoute());
  loadMe();
  loadRecent();

  /* ---- contadores ao vivo: tick por segundo + ressincronização com o banco ---- */
  setInterval(tickMine, 1000);
  setInterval(function () {
    if (document.visibilityState === 'hidden') return;
    loadPositions();
  }, 20000);
  setInterval(function () {
    if (document.visibilityState === 'hidden') return;
    loadMe();      /* saldo/earnings sobem sozinhos quando o crédito do dia cai */
    loadAccruals();
  }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    loadPositions();
    loadMe();
    loadAccruals();
  });
})();
