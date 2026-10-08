# Nexora — Plataforma de Investimento IA (clone funcional estilo Loxton, cores próprias)

Plataforma completa inspirada na loxtoncapital.io, com identidade própria **Nexora** (verde `#10b981` + violeta `#8b5cf6` sobre dark `#0b0f14` — diferente do azul Loxton), livre de build-step e sem dependências nativas (usa `node:sqlite` nativo do Node 22+).

`Nexora.html` original foi preservado como estudo de UI.

## Como rodar (Windows)

Pré-requisito: **Node.js 22+** (testado no Node 24).

```powershell
cd "C:\Users\willi\Desktop\Nexora dashboard"
npm install
npm run init-db
npm start
```

Abra: **http://localhost:3000/**

- Landing: `/` (`public/index.html`)
- Login: `/login.html` | Cadastro: `/signup.html?ref=CODIGO` | `/forgot.html`
- Dashboard usuário: `/dashboard.html` (views `#dashboard #deposit #withdraw #history #deposits #referrals #security #settings`)
- Admin: `/admin.html`

### Credenciais padrão (seed)

| Tipo | Login | Senha |
|------|-------|-------|
| Admin | `admin` ou `admin@nexora.local` | `Admin123!` |
| Usuário demo | `demo` ou `demo@nexora.local` | `Demo123!` |

- O admin entra pela tela de login do próprio `/admin.html` (usa `POST /api/auth/login` e valida `is_admin`).
- O usuário demo já vem com saldo $1.250,50 e depósito ativo $1.000 para testar o dashboard.
- Após `npm run init-db` o banco volta ao zero (admin + planos + gateways); recrie o demo com `node criar-demo.js`.
- Também é possível criar contas novas pela página `/signup.html`.

## O que foi entregue

**Landing page** — hero honesto sobre rendimento DeFi on-chain, ticker cripto via `/api/crypto/prices` (sem fallback inventado: mostra "indisponível" se a API falhar), cartões dos protocolos reais (Jito para staking de SOL, Kamino para vaults USDT), simulador de rendimento composto com taxa **anual escolhida pelo usuário**, números do pool Jito lidos on-chain, maiores stats do banco (0 enquanto não houver operação), FAQ sem promessa de retorno.

**Painel on-chain** (`/yield.html`) — conecta a Phantom **somente em modo leitura** (`connect({ onlyIfTrusted })`), mostra saldos de SOL/jitoSOL/USDT da carteira e a tabela de vaults USDT da Kamino com APY, TVL, depositantes, fees e performance fee. Sem botão de depósito, saque ou assinatura de transação.

**Auth** — signup com `?ref=` (o campo continua aceitando o parâmetro, mas **não paga comissão**), login por username ou email, JWT 7 dias em `localStorage nexora_token`.

**Dashboard usuário** — sidebar (Dashboard, Fazer Depósito, Sacar, Histórico, Meus Depósitos, Referral, Segurança, Config, Sair), **contadores de rendimento ao vivo no topo** (um por plano + total capital+rendimento, interpolado 1x/s entre os créditos diários e ressincronizado com o banco a cada 20s; congela quando o período do investimento encerra), 4 cards (Available Balance, Total Earnings, Active Deposit, Total Withdrawn + Pending), affiliate link com copiar, depósito (plano+valor+gateway+tx_hash → status `pending`), saque (valida saldo, reserva `pending_withdraw`), histórico, referral list, trocar senha, editar email. Mobile com hamburger + drawer.

**Admin** — guarda `is_admin=1`:

- **Visão Geral** — cards de apoio + **Caixa e exposição (ao vivo)**: capital em posição, gerado para os usuários, **a pagar (caixa a guardar = saldo já creditado + o que as posições ativas ainda vão creditar)**, saldo dos usuários, geração diária e total de usuários — números agregados de todos os usuários, atualizados a cada 15s com contador interpolado. Abaixo, **Evolução da empresa** (capital investido × rendimento gerado, acumulado, 7/30/90/365 dias) e **Cenário** (lucro gerado aos usuários × resultado aplicado pela empresa × **meta dinâmica**, calculada dia a dia como `lucro gerado × fator`, padrão **1,30 = cobre o lucro dos usuários + 30% para a empresa** — fator editável em `settings.meta_factor`; resultados são lançados manualmente na tabela `company_results`). Gráficos são SVG próprio, sem biblioteca.
- **Usuários** (editar balance/earnings/active/is_admin), **Depósitos** (aprovar=`active`/rejeitar — credita `active_deposit`), **Saques** (aprovar=`approved` debita saldo / rejeitar libera reserva), **Planos** CRUD, **Gateways** CRUD (carteiras), **Config Site** (`site_name, hero_title, support_telegram, primary_color, secondary_color` com live preview).

> **O usuário não "investe" pelo painel.** `POST /api/my/invest` responde `410`: a rota debitava saldo interno e marcava `active_deposit` contra uma linha de `plans`, sem nenhuma transferência on-chain que pagasse aquilo. O CRUD de **planos continua no admin** — ele apenas define as taxas do motor de crédito local (`accrual.js`), e depósito/saque continuam sendo **saldos internos**. Rendimento real só é lido de `/api/solana/*` e assinado na própria carteira via `/yield.html`.

## API (resumo)

Público: `POST /api/auth/signup|login`, `GET /api/public/settings|gateways|stats`, `GET /api/crypto/prices`, `GET /api/health`
Solana: `GET /api/solana/jito`, `GET /api/solana/usdt-vaults`, `GET /api/solana/portfolio?address=<pubkey>`
Usuário (Bearer): `GET|PUT /api/me`, `POST /api/me/change-password`, `GET|POST /api/my/deposits|withdrawals`, `GET /api/my/transactions|referrals`
Admin (Bearer+is_admin): `GET|PUT /api/admin/users`, `GET|PUT /api/admin/deposits|withdrawals`, CRUD `/api/admin/plans|gateways`, `GET|PUT /api/admin/settings`, `GET /api/admin/overview` (agregados de caixa/exposição), `GET /api/admin/evolution?days=7|30|90|365`, `GET|POST /api/admin/results`, `DELETE /api/admin/results/:id`, `POST /api/admin/accrue/run`

`GET /api/public/plans` devolve os planos ativos e `POST /api/my/invest` responde `410` — o convite é operar on-chain pelo `/yield.html`, não simular stake no banco.

## Estrutura

```
├── server.js  solana.js  accrual.js  db.js  init-db.js  criar-demo.js  package.json  nexora.db
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

- Banco `nexora.db` via `node:sqlite` (DatabaseSync) — sem Visual Studio / sem compilação. `db.js` adiciona shim `pragma` + `transaction` para compatibilidade.
- Depósito aprovado = `active` (não `approved`). Saque aprovado = `approved`.
- Para trocar cores/logo sem código: `/admin.html` → aba Config Site.
- `npm run init-db` apaga e recria o banco com admin + **5 planos** (Nexora Start … Sovereign) + 2 gateways de demonstração.
- Assinatura de transações on-chain **não está implementada**. O site apenas lê dados. Implementar depósito/resgate exige construir as transações no navegador, revisar taxas de prioridade e gas, e submeter a auditoria — não deve ser feito copiando exemplos de terceiros.
