# TradeAI — Backtester + Camada de Notícias (guia rápido)

Três peças novas, por ordem de importância:

## 1. Backtester (`scripts/backtest.js`) — o que faltava

Corre as **tuas** regras de entrada (`indicators.buySignal`, com o veto de tendência) e
saída (SL/TP por perfil × ajuste de categoria) sobre histórico real, e diz-te a
**expectativa por trade** ANTES de arriscares. Reutiliza o `indicators.js` do bot, por
isso o que ele mostra é o que o bot faria.

```bash
# Baixa histórico real (crypto via Binance) e compara TODOS os perfis:
node scripts/backtest.js --fetch=btc,eth,sol,xrp,ada --grid --dias=365

# Um perfil só, com detalhe completo:
node scripts/backtest.js --fetch=btc,eth,sol --perfil=scalper

# Dados próprios (1 ficheiro <id>.json por ativo: {id, cat, candles:[{t,c}]}):
node scripts/backtest.js --data=./historico --grid
```

Notas:
- `--fetch` usa `data-api.binance.vision` (o mesmo domínio que o bot já usa para
  contornar o 451 do Railway). Só crypto por agora; para ETF/forex/commodities passa
  os teus ficheiros via `--data`.
- O backtest **não usa o Groq** — de propósito. Se há edge, tem de aparecer nos
  indicadores técnicos (reproduzíveis). O LLM, na melhor das hipóteses, **filtra**;
  nunca cria edge. Se o grid der todos os perfis negativos, o problema é a lógica de
  entrada/saída, não os parâmetros — e nenhuma feature de IA resolve isso.
- Métricas: expectativa €/trade, win rate, profit factor (>1.5 = bom), max drawdown,
  Sharpe por trade. Custo realista por trade configurável com `--custo=0.2`.

**Fluxo recomendado antes de live:** corre `--grid` sobre 1-2 anos, escolhe o perfil
com expectativa positiva E profit factor > 1.3, e só esse vai a paper. Se nenhum for
positivo, não passes a live — afina a lógica primeiro.

## 2. Win rate de breakeven nos perfis (app)

Cada perfil de risco agora mostra o **win rate mínimo para empatar** (já a contar
custo de ~0.2%/trade), com aviso visual:
- 🔴 ≥40% exigido → win rate alto, arriscado.
- 🟡 33-40% → moderado, confirma no backtester.
- 🟢 <33% → mais fácil de tornar lucrativo.

O agressivo (SL 9 / TP 18) precisa de **34%** só para empatar. Com win rate real baixo,
é perda matemática. O número está agora à vista para decidires com dados, não intuição.

## 3. Camada de Notícias (`src/news-sentiment.js` + toggle na app)

Ajusta **exposição** (nº de posições, € por trade, confiança exigida) com base no clima
macro lido de manchetes — **nunca mexe em SL/TP**. Esta é a fronteira que protege a
conta: a IA pode dizer "ambiente arriscado, encolhe" mas **não** "vai subir, aposta mais
e põe o alvo mais longe". Direção é do mercado; só ajustamos o tamanho do risco.

- Clima negativo (ex.: escalada de guerra) → aperta exposição, exige mais confiança.
- Clima positivo credível (ex.: desescalada confirmada) → afrouxa **até ao teu teto**
  (nunca acima). Limitado a ±30% (`NEWS_MAX_TILT`).
- Combina-se com o Modo Dinâmico técnico (multiplicam-se, com clamp a 1.0).

**Como alimentar:** a app escreve em `users/{uid}/settings/newsFeed`:
- `{ headlines: ["...", "..."] }` → a IA classifica o clima.
- `{ manualBias: 0.5, manualLabel: "desescalada" }` → override manual (salta a IA).

Sem manchetes recentes (>6h), volta a neutro sozinho. Toggle em Definições, ao lado do
Modo Dinâmico. O estado atual (clima + justificação) aparece no `botStatus`.

### Env vars novas (opcionais)
```
NEWS_REFRESH_MIN=20      # intervalo de reavaliação (min)
NEWS_MAX_TILT=0.30       # ajuste máximo de exposição (±30%)
GROQ_NEWS_MODEL=...      # modelo só para notícias (default = GROQ_MODEL)
```
