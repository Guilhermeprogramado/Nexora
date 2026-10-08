// Painel de yield: leitura da chain + APIs oficiais dos protocolos.
// Regra: se a leitura falhar, mostra "indisponível". Nenhum número é estimado.

var provider = window.solana || (window.phantom && window.phantom.solana);
var pubkey = null;

var fmt = function (n, d) {
  if (n === null || n === undefined || !isFinite(n)) return null;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: d || 0, maximumFractionDigits: d === undefined ? 2 : d });
};
var pct = function (n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return (n * 100).toFixed(2).replace('.', ',') + '%';
};
var el = function (id) { return document.getElementById(id); };

function put(id, text) {
  var n = el(id);
  if (n) n.textContent = text;
}

// ------------------------------------------------------------ Jito

async function loadJito() {
  try {
    var r = await fetch('/api/solana/jito');
    var d = await r.json();
    if (!d.ok) {
      put('jRate', ''); el('jRate').innerHTML = '<span class="nullv">indisponível</span>';
      put('jPool', 'indisponível');
      put('jIssued', 'indisponível');
      return;
    }
    el('jRate').innerHTML = fmt(d.solPerJitoSol, 6) + ' <span style="font-size:13px;color:var(--dim)">SOL / jitoSOL</span>';
    put('jPool', fmt(d.solInPool, 0) + ' SOL');
    put('jIssued', fmt(d.jitoSolIssued, 0));
    put('jPoolAddr', 'stake pool: ' + d.stakePool);
    put('jApyHint', 'https://www.jito.network/stats');
  } catch (e) {
    el('jRate').innerHTML = '<span class="nullv">erro de rede</span>';
  }
}

// ------------------------------------------------------------ Kamino

async function loadVaults() {
  var tb = el('vaults');
  try {
    var r = await fetch('/api/solana/usdt-vaults');
    var d = await r.json();
    var vaults = d.vaults || [];
    if (!vaults.length) {
      tb.innerHTML = '<tr><td colspan="7" style="color:var(--dim)">nenhum vault USDT retornado' +
        (d.error ? ' (' + d.error + ')' : '') + '</td></tr>';
      return;
    }
    var esc = function (s) {
      return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    tb.innerHTML = vaults.map(function (v) {
      var m = v.metrics;
      var fee = v.performanceFeeBps ? (v.performanceFeeBps / 100).toFixed(2).replace('.', ',') + '%' : '0%';
      var holders = m && m.numberOfHolders !== null ? m.numberOfHolders : '—';
      var tag = v.name.indexOf('Private Credit') >= 0
        ? ' <span class="pill">crédito privado</span>' : '';
      return '<tr>' +
        '<td><a href="https://explorer.solana.com/address/' + v.address + '" target="_blank" rel="noopener">' +
          esc(v.name) + '</a>' + tag + '<div class="mono" style="color:var(--dim);font-size:11px">' + v.address + '</div></td>' +
        '<td class="ok">' + pct(m && m.apy) + '</td>' +
        '<td>' + pct(m && m.apy7d) + '</td>' +
        '<td>' + pct(m && m.apy30d) + '</td>' +
        '<td>' + pct(m && m.apy365d) + '</td>' +
        '<td>' + holders + '</td>' +
        '<td>' + fee + '</td>' +
      '</tr>';
    }).join('');
  } catch (e) {
    tb.innerHTML = '<tr><td colspan="7" style="color:var(--dim)">erro de rede</td></tr>';
  }
}

// ------------------------------------------------------------ Phantom

async function loadPortfolio() {
  if (!pubkey) return;
  try {
    var r = await fetch('/api/solana/portfolio?address=' + encodeURIComponent(pubkey));
    var d = await r.json();
    if (!r.ok) { el('balances').innerHTML = '<div class="stat"><div class="k">Erro</div><div class="v bad">' +
      (d.error || 'falha') + '</div></div>'; return; }
    var b = d.balances;
    el('balances').innerHTML =
      card('SOL', fmt(b.SOL, 4)) +
      card('jitoSOL', fmt(b.jitoSOL, 4)) +
      card('USDT', fmt(b.USDT, 2)) +
      card('jitoSOL em SOL', d.jitoSolValueInSol === null ? '—' : fmt(d.jitoSolValueInSol, 4));
    el('posHint').textContent = 'Leitura direta da chain. Nenhuma assinatura é feita nesta página.';
  } catch (e) {
    el('balances').innerHTML = '<div class="stat"><div class="k">Erro</div><div class="v bad">erro de rede</div></div>';
  }
}

function card(k, v) {
  return '<div class="stat"><div class="k">' + k + '</div><div class="v">' +
    (v === null ? '<span class="nullv">indisponível</span>' : v) + '</div></div>';
}

async function connect() {
  if (!provider) { alert('Phantom não encontrado. Instale a extensão e recarregue.'); return; }
  try {
    if (provider.isPhantom) {
      var res = await provider.connect();
      pubkey = res.publicKey.toString();
    } else {
      await provider.connect();
      pubkey = provider.publicKey.toString();
    }
    el('waddr').textContent = pubkey;
    el('wallet').hidden = false;
    el('connect').hidden = true;
    loadPortfolio();
  } catch (e) {
    alert('Conexão recusada: ' + e.message);
  }
}

function disconnect() {
  if (provider && provider.disconnect) provider.disconnect();
  pubkey = null;
  el('wallet').hidden = true;
  el('connect').hidden = false;
  el('balances').innerHTML = '';
  el('posHint').textContent = 'Conecte a carteira para ver saldos. Leitura apenas — nada é movimentado.';
}

el('connect').addEventListener('click', connect);
el('disconnect').addEventListener('click', disconnect);
el('refresh').addEventListener('click', function () { loadJito(); loadVaults(); loadPortfolio(); });

loadJito();
loadVaults();