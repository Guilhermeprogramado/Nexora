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

module.exports = {
  RPC_URL,
  PublicKey,
  JITO,
  KLEND,
  MINTS,
  connection,
  readJitoPool,
  readUsdtVaults,
  readPortfolio
};