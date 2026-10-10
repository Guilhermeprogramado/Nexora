# Nexora — Plataforma de Investimento IA (clone funcional estilo Loxton, cores próprias)

Plataforma completa inspirada na loxtoncapital.io, com identidade própria **Nexora** (verde `#10b981` + violeta `#8b5cf6` sobre dark `#0b0f14` — diferente do azul Loxton), livre de build-step. O backend roda em Express e o banco é **Postgres no Supabase** via `pg` (connection string em `DATABASE_URL`) — arquitetura serverless-friendly para a Vercel.

`Nexora.html` original foi preservado como estudo de UI.

## Como rodar (local)

Pré-requisito: **Node.js 22+** e um banco Postgres no Supabase.

Antes de rodar, exporte a connection string do Supabase (projeto → Settings → Database → Connection string / Pooler):

```powershell
$env:DATABASE_URL = "postgresql://postgres:SUA_SENHA@db.xxxxxxxxxxxxxxxxxxxx.supabase.co:5432/postgres"
cd "C:\Users\Willis\Desktop\Nexora dask\Nexora dask"
npm install
npm run init-db     # garante schema + seeds (idempotente; nunca apaga dados)
node criar-demo.js  # cria o usuario demo, se nao existir
npm start
```

Abra: **http://localhost:3000/**

- Landing: `/` (`public/index.html`)
- Login: `/login.html` | Cadastro: `/signup.html?ref=CODIGO` | `/forgot.html`
- Dashboard usuário: `/dashboard.html` (views `#dashboard #deposit #withdraw #history #deposits #referrals #security #settings`)
- Admin: `/admin.html`

> **Reset total**: `node init-db.js --reset` apaga todas as tabelas e recria schema + seeds (admin, planos, gateways) do zero.

### Credenciais padrão (seed)

| Tipo | Login | Senha |
|------|-------|-------|
| Admin | `admin` ou `admin@nexora.local` | `Admin123!` |
| Usuário demo | `demo` ou `demo@nexora.local` | `Demo123!` |

- O admin entra pela tela de login do próprio `/admin.html` (usa `POST /api/auth/login` e valida `is_admin`).
- O usuário demo nasce **zerado**; o rendimento dele é o que estiver na carteira, lido em `/yield.html`.
- Também é possível criar contas novas pela página `/signup.html`.

## Deploy na Vercel + Supabase

1. Crie o projeto no Supabase e copie a **connection string do POOLER** (Password mode). Defina-a como variável de ambiente no dashboard da Vercel:
   - `DATABASE_URL` = `postgresql://postgres.<project-ref>:...@aws-0-<regiao>.pooler.supabase.com:5432/postgres` — **use o pooler**, o host direto `db.<ref>.supabase.co` não resolve DNS dentro da função da Vercel.
   - `PGSSL=disable` apenas se usar o Supabase local via CLI (na Vercel fica omitido — SSL on).
   - `JWT_SECRET` = valor aleatório (obrigatório em produção).
   - `CMC_API_KEY` = (opcional) chave da CoinMarketCap.
   - `CRON_SECRET` = valor aleatório — o Cron Job da Vercel envia `Authorization: Bearer <CRON_SECRET>` para `POST /api/cron/accrue`.
2. Push para o GitHub e **Import Project** na Vercel (framework: Other, build: nada, output: nada).
3. O `vercel.json` redireciona tudo para `api/index.js` (Function Node 22, `maxDuration 30`), que exporta o mesmo `app` do `server.js`. O banco é SP completo, então não há escrita em disco.
4. `engines` força Node 22.x e `overrides.rpc-websockets.uuid = ^11` elimina o `ERR_REQUIRE_ESM` (`@solana/web3.js` → `rpc-websockets` exigia `uuid@14` ESM-only).
5. O `vercel.json` agenda o **accrue diário** (`"crons": [{ "path": "/api/cron/accrue", "schedule": "0 0 * * *" }]`, UTC). Fora do cron, o `scheduleAccruals` interno roda de hora em hora só enquanto a instância está quente — não confie nele em serverless. O accrue é idempotente (`ON CONFLICT DO NOTHING`), então um Post extra não credita duas vezes.

> Nota: a senha do banco **não** é a publishable key `sb_publishable_...` — ela serve apenas para autenticação no client Supabase, não para a connection string do `pg`.

## O que foi entregue

**Landing page** — hero honesto sobre rendimento DeFi on-chain, ticker cripto via `/api/crypto/prices` (sem fallback inventado: mostra "indisponível" se a API falhar), cartões dos protocolos reais (Jito para staking de SOL, Kamino para vaults USDT), simulador de rendimento composto com taxa **anual escolhida pelo usuário**, números do pool Jito lidos on-chain, maiores stats do banco (0 enquanto não houver operação), FAQ sem promessa de retorno.

**Painel on-chain** (`/yield.html`) — conecta a Phantom **somente em modo leitura** (`connect({ onlyIfTrusted })`), mostra saldos de SOL/jitoSOL/USDT da carteira e a tabela de vaults USDT da Kamino com APY, TVL, depositantes, fees e performance fee. Sem botão de depósito, saque ou assinatura de transação.

**Auth** — signup com `?ref=` (o campo continua aceitando o parâmetro, mas **não paga comissão**), login por username ou email, JWT 7 dias em `localStorage nexora_token`.

**Dashboard usuário** — sidebar (Dashboard, Investir em Plano, Adicionar Saldo, Sacar, Histórico, Meus Depósitos, Referral, Segurança, Config, Sair), **contadores de rendimento ao vivo no topo** (um por plano + total capital+rendimento, interpolado 1x/s entre os créditos diários e ressincronizado com o banco a cada 20s; congela quando o período do investimento encerra), 4 cards (Available Balance, Total Earnings, Active Deposit, Total Withdrawn + Pending), affiliate link com copiar. Fluxo de 2 passos: **(1) Adicionar Saldo** — gateway + valor + hash da transferência → depósito `pending`, obriga aprovação do admin, um pendente por vez; **(2) Investir em Plano** — automático: debita o saldo na hora, abre a posição e o rendimento começa a contar a partir de hoje (sem aprovação). Saque (valida saldo, reserva `pending_withdraw`), histórico, referral list, trocar senha, editar email. Mobile com hamburger + drawer.

**Admin** — guarda `is_admin=1`:

- **Visão Geral** — cards de apoio + **Caixa e exposição (ao vivo)**: capital em posição, gerado para os usuários, **a pagar (caixa a guardar = saldo já creditado + o que as posições ativas ainda vão creditar)**, saldo dos usuários, geração diária e total de usuários — números agregados de todos os usuários, atualizados a cada 15s com contador interpolado. Abaixo, **Evolução da empresa** (capital investido × rendimento gerado, acumulado, 7/30/90/365 dias) e **Cenário** (lucro gerado aos usuários × resultado aplicado pela empresa × **meta dinâmica**, calculada dia a dia como `lucro gerado × fator`, padrão **1,30 = cobre o lucro dos usuários + 30% para a empresa** — fator editável em `settings.meta_factor`; resultados são lançados manualmente na tabela `company_results`). Gráficos são SVG próprio, sem biblioteca.
- **Usuários** (editar balance/earnings/active/is_admin), **Depósitos** (aprovar=`active`/rejeitar — credita **saldo**; não abre posição), **Saques** (aprovar=`approved` debita saldo / rejeitar libera reserva), **Planos** CRUD, **Gateways** CRUD (carteiras), **Config Site** (`site_name, hero_title, support_telegram, primary_color, secondary_color` com live preview).

> **Investir vs. Depositar.** Deposit (1x por vez, `pending`) é o único passo que exige aprovação do admin: aprovar credita `balance`. Investir num plano (`POST /api/my/invest`) é **automático** — debita `balance`, soma em `active_deposit` e abre a posição, que o `accrual.js` credita dia a dia a partir da data de hoje. O CRUD de **planos** no admin apenas define as taxas do motor de crédito local; depósito/saque são saldos internos. Rendimento real on-chain só é lido de `/api/solana/*` e assinado na própria carteira via `/yield.html`.

## API (resumo)

Público: `POST /api/auth/signup|login`, `GET /api/public/settings|gateways|stats`, `GET /api/crypto/prices`, `GET /api/health`
Solana: `GET /api/solana/jito`, `GET /api/solana/usdt-vaults`, `GET /api/solana/portfolio?address=<pubkey>`
Usuário (Bearer): `GET|PUT /api/me`, `POST /api/me/change-password`, `GET|POST /api/my/deposits`, `POST /api/my/invest`, `GET|POST /api/my/withdrawals`, `GET /api/my/transactions|referrals`
Admin (Bearer+is_admin): `GET|PUT /api/admin/users`, `GET|PUT /api/admin/deposits|withdrawals`, CRUD `/api/admin/plans|gateways`, `GET|PUT /api/admin/settings`, `GET /api/admin/overview` (agregados de caixa/exposição), `GET /api/admin/evolution?days=7|30|90|365`, `GET|POST /api/admin/results`, `DELETE /api/admin/results/:id`, `POST /api/admin/accrue/run`

`GET /api/public/plans` devolve os planos ativos. `POST /api/my/invest` debita `balance` e abre a posição automaticamente (sem aprovação); `POST /api/my/deposits` cria um depósito `pending` (um por vez) que o admin aprova para liberar saldo.

## Estrutura

```
├── server.js  solana.js  accrual.js  db.js  init-db.js  criar-demo.js  vercel.json  package.json
├── api/index.js
├── README.md
└── public/
    ├── index.html yield.html login.html signup.html forgot.html admin-login.html
    ├── dashboard.html admin.html
    ├── css/style.css css/dashboard.css css/admin.css
    └── js/landing.js js/yield.js js/auth.js js/dashboard.js js/admin.js js/admin-auth.js js/ticker.js
```

## Rendimento DeFi (leitura, não custódia)

`solana.js` é a única fonte dos números de rendimento:

- **Jito** — decodifica o stake pool com `@solana/spl-stake-pool` (`getStakePoolAccount`) e calcula `totalLamports / poolTokenSupply`. Endereço do pool `Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb`, mint jitoSOL `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn`.
- **Kamino** — `GET /kvaults/vaults` + `/kvaults/vaults/{address}/metrics` na API pública; a Kamino é agregadora, então o risco de crédito é do protocolo específico de cada vault, não só do contrato.
- **USDT** — mint `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`; saldos lidos com `@solana/spl-token` e soma manual dos token accounts.

Se a RPC ou a API falhar, a resposta é `null`/503 e a tela mostra "indisponível". Não existe valor estimado, taxa presumida ou APY inventado em nenhum caminho do código.

## Notas técnicas

- Banco **Postgres no Supabase** via `node-postgres` (`pg`) — nada de SQLite local, nada de escrita em disco (essencial para a Vercel). `db.js` expõe uma API assíncrona parecida com a antiga (`prepare().get/all/run`, `exec`, `transaction`) e traduz `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING` e `?` → `$1, $2...`.
- Configuração por ambiente: `DATABASE_URL` (obrigatória), `PGSSL=disable` (opcional), `PGPOOL_MAX` (default 5), `JWT_SECRET`, `CMC_API_KEY`, `CRON_SECRET` (protege `/api/cron/accrue`).
- Depósito aprovado = `active` (não `approved`). Saque aprovado = `approved`.
- Para trocar cores/logo sem código: `/admin.html` → aba Config Site.
- `npm run init-db` garante schema + seeds (idempotente); `node init-db.js --reset` apaga tudo e recria com admin + **5 planos** (Nexora Start … Sovereign) + 2 gateways de demonstração.
- Assinatura de transações on-chain **não está implementada**. O site apenas lê dados. Implementar depósito/resgate exige construir as transações no navegador, revisar taxas de prioridade e gas, e submeter a auditoria — não deve ser feito copiando exemplos de terceiros.
