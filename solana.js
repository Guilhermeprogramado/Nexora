// Leitura de dados Solana 100% on-chain / API oficial dos protocolos.
// Regra deste modulo: NUNCA inventar valor. Se a leitura falhar, o campo e null
// e o front exibe "indisponivel". Nao existe fallback com numero chutado.
//
// Enderecos conferidos em:
//  - https://www.jito.network/docs/jitosol/jitosol-liquid-staking/security/deployed-programs
//  - https://github.com/Kamino-Finance/klend (Deployments)
//  - https://kamino.com/docs/build/api-reference/earn/vault-data/vaults-list

const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getMint } = require('@solana/spl-token');
const { getStakePoolAccount } = require('@solana/spl-stake-pool');

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const KAMINO_API = 'https://api.kamino.finance';

// --- Jito (docs: .../security/deployed-programs) ---
const JITO = {
  stakePool: new PublicKey('Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb'),
  mint: new PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'),
  mintDecimals: 9,
  // SPL stake pool program (identico em mainnet/testnet)
  programId: new PublicKey('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy')
};

// --- Kamino Lend (github.com/Kamino-Finance/klend -> Deployments) ---
const KLEND = {
  programId: new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'),
  staging: new PublicKey('SLendK7ySfcEzyaFqy93gDnD3RtrpXJcnRwb6zFHJSh')
};

const MINTS = {
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
  jitoSOL: JITO.mint,
  USDT: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')
};

let conn = null;
function connection() {
  if (!conn) conn = new Connection(RPC_URL, 'confirmed');
  return conn;
}

// ---------------------------------------------------------------- Jito

// Le o stake pool e devolve a taxa de cambio jitoSOL -> SOL, lida da chain.
// Usa o decoder oficial do SPL stake pool (@solana/spl-stake-pool) em vez de
// parse manual do layout bin -- parse manual ja errou os offsets e produziu
// numeros absurdos. Campos usados: totalLamports e poolTokenSupply.
async function readJitoPool() {
  const res = await getStakePoolAccount(connection(), JITO.stakePool);
  const st = res && res.account && res.account.data;
  if (!st) return { ok: false, error: 'Stake pool nao encontrado na chain' };

  // Garante que o mint do pool e mesmo o jitoSOL esperado.
  const poolMint = st.poolMint && st.poolMint.toBase58
    ? st.poolMint.toBase58()
    : String(st.poolMint);
  if (poolMint !== JITO.mint.toBase58()) {
    return { ok: false, error: `Mint inesperado no pool: ${poolMint}` };
  }

  const totalLamports = Number(st.totalLamports);
  const poolTokenSupply = Number(st.poolTokenSupply);
  if (!Number.isFinite(totalLamports) || !Number.isFinite(poolTokenSupply)) {
    return { ok: false, error: 'totalLamports/poolTokenSupply nao numericos' };
  }
  if (totalLamports <= 0 || poolTokenSupply <= 0) {
    return { ok: false, error: 'Pool com saldos zerados' };
  }

  // 1 jitoSOL = totalLamports / poolTokenSupply SOL. A taxa sobe com o tempo
  // conforme o pool acumula rewards de staking + MEV.
  return {
    ok: true,
    source: 'on-chain',
    stakePool: JITO.stakePool.toBase58(),
    mint: poolMint,
    solPerJitoSol: totalLamports / poolTokenSupply,
    solInPool: totalLamports / LAMPORTS_PER_SOL,
    jitoSolIssued: poolTokenSupply / 1e9,
    observedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------- Kamino

async function kaminoFetch(path, timeoutMs = 12000) {
  const res = await fetch(`${KAMINO_API}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`Kamino ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Lista vaults cujo token e USDT, com metricas reais de APY.
// A doc da Kamino e explicita: APY quoted e media retroativa, nao taxa garantida.
async function readUsdtVaults() {
  const vaults = await kaminoFetch('/kvaults/vaults', 20000);
  if (!Array.isArray(vaults)) throw new Error('/kvaults/vaults nao retornou array');

  const usdt = MINTS.USDT.toBase58();
  const usdtVaults = vaults.filter((v) => v && v.state && v.state.tokenMint === usdt);

  const withMetrics = await Promise.all(
    usdtVaults.map(async (v) => {
      const base = {
        address: v.address,
        name: v.state.name,
        tokenMint: v.state.tokenMint,
        sharesMint: v.state.sharesMint,
        managementFeeBps: Number(v.state.managementFeeBps || 0),
        performanceFeeBps: Number(v.state.performanceFeeBps || 0),
        metrics: null,
        metricsError: null
      };
      try {
        const m = await kaminoFetch(`/kvaults/vaults/${v.address}/metrics`);
        const n = (x) => (x === undefined || x === null ? null : Number(x));
        base.metrics = {
          apy: n(m.apy),
          apy7d: n(m.apy7d),
          apy24h: n(m.apy24h),
          apy30d: n(m.apy30d),
          apy90d: n(m.apy90d),
          apy180d: n(m.apy180d),
          apy365d: n(m.apy365d),
          apyFarmRewards: n(m.apyFarmRewards),
          apyIncentives: n(m.apyIncentives),
          sharePrice: n(m.sharePrice),
          tokensPerShare: n(m.tokensPerShare),
          numberOfHolders: n(m.numberOfHolders),
          tokensInvested: n(m.tokensInvested),
          tokensInvestedUsd: n(m.tokensInvestedUsd),
          cumulativePerformanceFees: n(m.cumulativePerformanceFees)
        };
      } catch (err) {
        base.metricsError = err.message;
      }
      return base;
    })
  );

  // Ordena por APY real quando disponivel; vaults sem metrica vao para o fim.
  return withMetrics.sort((a, b) => {
    const av = a.metrics && typeof a.metrics.apy === 'number' ? a.metrics.apy : -1;
    const bv = b.metrics && typeof b.metrics.apy === 'number' ? b.metrics.apy : -1;
    return bv - av;
  });
}

// ---------------------------------------------------------------- Balances

async function readTokenBalance(owner, mint) {
  const c = connection();
  const accounts = await c.getParsedTokenAccountsByOwner(owner, { mint });
  let raw = 0n;
  for (const { account } of accounts.value) {
    const amt = account.data.parsed.info.tokenAmount;
    raw += BigInt(amt.amount);
  }
  const decimals = (await getMint(c, mint)).decimals;
  return Number(raw) / 10 ** decimals;
}

// Balancas do usuario + posicoes. Somente leitura, nunca move fundo.
async function readPortfolio(ownerPubkey) {
  const owner = new PublicKey(ownerPubkey);
  const [sol, jitoSol, usdt] = await Promise.all([
    connection().getBalance(owner).then((l) => l / LAMPORTS_PER_SOL),
    readTokenBalance(owner, JITO.mint),
    readTokenBalance(owner, MINTS.USDT)
  ]);

  const pool = await readJitoPool().catch(() => ({ ok: false, error: 'falha ao ler stake pool' }));

  return {
    owner: owner.toBase58(),
    balances: { SOL: sol, jitoSOL: jitoSol, USDT: usdt },
    // Valor em SOL do jitoSOL holdings, usando a taxa lida on-chain
    jitoSolValueInSol: pool.ok ? jitoSol * pool.solPerJitoSol : null,
    jitoPool: pool
  };
}

// ------------------------------------------------------ Pagamentos (deposito)

// O RPC de LEITURA (Jito/Kamino/portfolio) e sempre mainnet. Os PAGAMENTOS usam
// a rede escolhida pelo ADMIN (settings.solana_network no banco): 'devnet'
// (padrao, para testes sem dinheiro real) ou 'mainnet-beta' (SOL real). Na
// mainnet o endpoint e configuravel por SOLANA_PAY_RPC_URL (senao SOLANA_RPC_URL
// e por fim a mainnet publica).
const MAINNET_PAY_RPC_URL = process.env.SOLANA_PAY_RPC_URL
  || process.env.SOLANA_RPC_URL
  || 'https://api.mainnet-beta.solana.com';
const PAY_RPCS = {
  'devnet': 'https://api.devnet.solana.com',
  'testnet': 'https://api.testnet.solana.com',
  'mainnet-beta': MAINNET_PAY_RPC_URL
};
// Rede de pagamento padrao quando o admin nao definiu nada no banco.
const RAW_DEFAULT_NET = String(process.env.SOLANA_PAY_NETWORK || 'devnet').trim().toLowerCase();
const DEFAULT_PAY_NETWORK = (RAW_DEFAULT_NET === 'mainnet' || RAW_DEFAULT_NET === 'mainnet-beta')
  ? 'mainnet-beta'
  : (RAW_DEFAULT_NET === 'testnet' ? 'testnet' : 'devnet');
function normalizeNetwork(n) {
  const v = String(n || '').trim().toLowerCase();
  if (v === 'mainnet' || v === 'mainnet-beta') return 'mainnet-beta';
  if (v === 'testnet') return 'testnet';
  return 'devnet';
}
function payRpcUrl(network) {
  return PAY_RPCS[normalizeNetwork(network)] || PAY_RPCS['devnet'];
}
const payConns = {};
function payConnection(network) {
  const url = payRpcUrl(network);
  if (!payConns[url]) payConns[url] = new Connection(url, 'confirmed');
  return payConns[url];
}
function payNetwork(network) {
  return normalizeNetwork(network);
}

// Preco do SOL em USD de fonte real (CoinGecko). Retorna null se indisponivel:
// nunca inventa cotacao.
async function getSolPriceUsd() {
  try {
    const headers = { Accept: 'application/json' };
    if (process.env.COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
      headers,
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const p = j && j.solana ? Number(j.solana.usd) : NaN;
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch (err) {
    console.error('[solana] preco SOL:', err.message);
    return null;
  }
}

// Verifica ON-CHAIN que `signature` transferiu >= minLamports de `from` para
// `to`. Confirma em `confirmed` e tenta algumas vezes (propagacao demora).
// O saldo so pode ser creditado se isto retornar ok:true.
async function verifySolTransfer({ signature, from, to, minLamports, network, attempts = 8, delayMs = 1500 }) {
  if (!signature) return { ok: false, error: 'assinatura ausente' };
  const c = payConnection(network);
  for (let i = 0; i < attempts; i++) {
    let tx = null;
    try {
      tx = await c.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    } catch (err) {
      if (i === attempts - 1) return { ok: false, error: 'falha ao ler a transacao: ' + err.message };
    }
    if (tx) {
      if (tx.meta && tx.meta.err) return { ok: false, error: 'a transacao falhou na blockchain' };
      const msg = tx.transaction && tx.transaction.message;
      const pre = (tx.meta && tx.meta.preBalances) || [];
      const post = (tx.meta && tx.meta.postBalances) || [];
      // Monta a lista COMPLETA de contas na MESMA ordem de pre/postBalances:
      // v0 = estaticas + loaded(writable) + loaded(readonly); legado = accountKeys.
      let keys;
      if (msg && msg.staticAccountKeys) {
        const loaded = (tx.meta && tx.meta.loadedAddresses) || {};
        const b58 = (k) => (k && k.toBase58 ? k.toBase58() : String(k));
        keys = msg.staticAccountKeys.map(b58)
          .concat((loaded.writable || []).map(b58))
          .concat((loaded.readonly || []).map(b58));
      } else {
        keys = ((msg && msg.accountKeys) || []).map((k) => (k && k.toBase58 ? k.toBase58() : String(k)));
      }
      // Seguranca: se o layout nao casar com as balancas, NAO credita.
      if (keys.length !== pre.length || pre.length !== post.length) {
        return { ok: false, error: 'layout de contas inesperado' };
      }
      const toIdx = keys.indexOf(to);
      const fromIdx = from ? keys.indexOf(from) : -1;
      if (toIdx < 0) return { ok: false, error: 'endereco de destino nao aparece na transacao' };
      if (from && fromIdx < 0) return { ok: false, error: 'carteira de origem nao aparece na transacao' };
      const received = Number(post[toIdx] || 0) - Number(pre[toIdx] || 0);
      if (!(received >= minLamports)) {
        return { ok: false, error: `valor recebido (${received} lamports) abaixo do esperado (${minLamports})` };
      }
      return { ok: true, lamports: received, slot: tx.slot };
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok: false, error: 'transacao ainda nao confirmada' };
}

module.exports = {
  RPC_URL,
  MAINNET_PAY_RPC_URL,
  DEFAULT_PAY_NETWORK,
  LAMPORTS_PER_SOL,
  PublicKey,
  JITO,
  KLEND,
  MINTS,
  connection,
  payConnection,
  payNetwork,
  normalizeNetwork,
  payRpcUrl,
  getSolPriceUsd,
  verifySolTransfer,
  readJitoPool,
  readUsdtVaults,
  readPortfolio
};