# TradeAI — passagem final (objetivo: domingo 100%, semana estável)

Trabalhei a partir do código REAL que está no Git/produção (os zips que enviaste).
Encontrei uma coisa importante: o teu deploy tinha versões MISTURADAS — a app tinha
as correções recentes, o bot tinha o sistema de brokers e a publicação de saldos,
MAS o `prices.js` do bot era o antigo (só CoinGecko+Stooq, sem a cascata) e faltava
a carência de SL manual. Isto explica os sintomas das imagens. Está tudo alinhado
agora.

## O que foi corrigido nesta passagem

### BOT (prices.js) — CASCATA DE PREÇOS reposta (era o problema central)
O `prices.js` em produção não tinha a cascata. Reposto, preservando tudo o que já
tinhas (catálogo com nome/ícone, fetchWithRetry, fetchHistory):
- Crypto: **Binance** → CoinGecko → cache
- Forex/ETF/Commodity: **TwelveData** → Stooq → Yahoo → cache
- Cada fonte só busca ativos "stale" (>90s); Stooq deixa de ser o gargalo.
- Deteção de outliers; `getSourceHealth` agora reporta as 5 fontes.
- `BASE_PRICES` completado (faltavam ada, doge, etc.).
→ Resolve o "Stooq OK" como fonte única e o WTI a mexer com mercado fechado
  (desde que metas `TWELVEDATA_KEY` no Railway — ver fim).

### BOT (sim-engine.js + engine.js) — carência de SL manual
Posições manuais não fecham por SL nos primeiros 60s (evita o fecho-relâmpago do
BTC/DOGE logo após a compra). Reposto nos dois motores. As `apiHealth` enviadas à
app agora incluem Binance e TwelveData.

### APP — barra minimizada da simulação (o "−82%")
Já estava corrigida no código que enviaste (usa equity total). O "−82%" que vias
era de um deploy ANTERIOR. Ao fazer deploy desta versão, desaparece de vez.

### APP — estratégias Prata/Gás Natural com ativos errados (BTC/ETH)
A criação de estratégia por IA copiava o exemplo `["btc","eth"]` para qualquer
estratégia. Agora infere o ativo a partir do NOME/descrição: uma estratégia
chamada "Prata" passa a ter `silver`, "Gás Natural" → `natgas`, etc.
→ Nota: isto corrige estratégias NOVAS. As que já tens guardadas no Firestore com
  btc/eth continuam assim — apaga-as e recria, ou edita o ativo, para corrigir.

### APP — sobre-concentração num só ativo (7x ADA)
Adicionado limite de **3 posições por ativo** nas estratégias automáticas. Impede
que um só ativo (como o ADA) ocupe todos os slots — sete entradas iguais eram, na
prática, uma aposta grande disfarçada.

### APP — health badges
O Dashboard mostra agora Binance / CoinGecko / TwelveData / Stooq conforme o que
o bot reporta, em vez de só Stooq+CoinGecko.

### APP — typo "posiçãoões"
Corrigido para "posições abertas" / "posição aberta".

## O que verifiquei e NÃO era bug
- O "−111 scans restantes": é "~111 scans restantes" (o ~ lia-se como −). Já tem
  piso em zero. Sem alteração.
- A coluna de status (SL verde): já estava com a lógica outcome-aware. Sem alteração.

## Verificação
- App.jsx (parser Babel, ~5100 linhas) → OK.
- prices.js, sim-engine.js, engine.js, broker.js, brokers/* (node --check) → OK.
- Smoke-test da cascata: cai fonte→fonte→cache sem crashar; health reporta 5 fontes.

═══════════════════════════════════════════════════════════════════════════════
AÇÃO TUA NO RAILWAY (sem isto, o WTI/forex continuam no Stooq)
═══════════════════════════════════════════════════════════════════════════════
Define a variável de ambiente no serviço do bot:
  TWELVEDATA_KEY = (chave grátis de twelvedata.com)
Sem ela, a cascata para forex/ETF/commodity cai direto para Stooq/Yahoo. A crypto
(Binance) funciona sem chave.

Confirma também que continuas com FIREBASE_ADMIN_JSON e USER_UID definidas.

═══════════════════════════════════════════════════════════════════════════════
DEPLOY
═══════════════════════════════════════════════════════════════════════════════
1. Descomprime os dois zips por cima dos projetos.
2. npm install em cada um.
3. Push → Netlify (app) e Railway (bot).
4. Para limpar as estratégias antigas com btc/eth errados: Definições → Limpar
   Simulações (ou apaga só essas estratégias), e deixa o bot recriá-las certas.
