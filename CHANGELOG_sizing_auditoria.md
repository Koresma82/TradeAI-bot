# TradeAI — Position sizing do bot + auditoria de chamadas

Trabalhei a partir dos zips que enviaste. Eram uma versão intermédia: tinham a
cascata de preços e a carência de SL manual, mas FALTAVAM várias coisas das
últimas sessões (throttle TwelveData, fix Binance 451, partilha de preços). Repus
tudo isso E acrescentei o position sizing do bot que pediste. Está tudo coerente
agora numa só versão.

## 1. Position sizing do BOT (o que pediste)
O bot deixou de abrir sempre com valor fixo. Agora dimensiona como a app:
- **Modo "Valor Fixo"** (Definições): mantém o valor fixo (comportamento clássico).
- **Modo "% da Banca"**: dimensiona por **perfil de risco + confiança + saldo**:
  - Perfil (conservador/moderado/agressivo) define o teto por posição (10/20/33%).
  - A % da banca das Definições é a base, escalada pela confiança do sinal:
    ≥90%→2x, ≥80%→1.5x, ≥70%→1.1x, ≥60%→0.8x, <60%→0.5x.
  - Mínimo €10, nunca acima do teto do perfil nem do saldo.
- Aplica-se às **Estratégias** (usa a força do sinal técnico + confiança da IA) e
  ao **AI Brain** (usa a confiança do sinal Groq).
- Lê o perfil e o modo das Definições da app via Firestore (campos `riscoPerfil`,
  `modoValor`, `percentagem`) — coerente com a app.

→ Para ativar o sizing dinâmico: na app, Definições → Modo de Investimento →
  "% da Banca". Em "Valor Fixo" mantém-se o valor fixo.

## 2. Auditoria de chamadas + otimizações (reposto)
- **Bot publica preços** no Firestore (`marketPrices`) a cada 2 min.
- **App lê do Firestore** quando o bot está ativo, em vez de bater nas APIs:
  - `fetchMarkets` (Netlify /market): saltada com bot ativo.
  - CoinGecko direto (BTC/ETH, era redundante): saltado com bot ativo.
- Impacto: com bot ativo + app aberta, a app deixa de fazer ~2.800 pedidos
  externos/hora; passa a 1 leitura Firestore. O Groq da app já estava protegido.

## 3. Outras correções repostas
- **TwelveData throttle**: orçamento 700/dia, ≤6 créditos/min (era o que estourou
  os 7.410 créditos). Ao esgotar, Stooq assume.
- **Binance 451**: usa o domínio de dados `data-api.binance.vision` (sem bloqueio
  regional). Se mesmo assim der 451, deixa de tentar e o CoinGecko assume.
- Carência de SL manual (60s) e per-asset cap (3) já lá estavam — mantidos.

## Verificação
- App.jsx (parser Babel) → OK.
- sim-engine.js, prices.js (node --check) → OK.
- Sizing testado: modo fixo respeita valor fixo; modo % escala por perfil/confiança
  com tetos corretos (ex.: saldo €500, agressivo @90% → €140; conservador @60% → €16).

## Ações tuas (Railway)
- `TWELVEDATA_KEY` (já a tens). Opcional: `TWELVEDATA_DAILY_BUDGET` (default 700).
- Confirma `FIREBASE_ADMIN_JSON` e `USER_UID`.
- Nada de novo obrigatório — o sizing dinâmico ativa-se ao escolheres "% da Banca"
  na app.
