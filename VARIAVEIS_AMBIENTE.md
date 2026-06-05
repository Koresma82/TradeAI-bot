# VARIÁVEIS DE AMBIENTE — o que criar e onde

As variáveis NÃO vão dentro dos zips (o ficheiro .env real nunca é incluído, por
segurança). Tens de as definir nos painéis do Railway (bot) e Netlify (app).

═══════════════════════════════════════════════════════════════════════════════
BOT — Railway  (serviço TradeAI-bot → separador "Variables")
═══════════════════════════════════════════════════════════════════════════════

OBRIGATÓRIAS (sem estas o bot CRASHA no arranque — foi o que viste nos logs):

  FIREBASE_ADMIN_JSON
      O conteúdo INTEIRO do ficheiro firebase-admin.json (a service account),
      colado como uma única string JSON. Gera em:
      Firebase Console → Project Settings → Service Accounts → Generate new private key
      ⚠ Cola o JSON todo, incluindo as \n da private_key tal como estão no ficheiro.

  USER_UID
      O teu UID (copia da app: Definições → Copiar UID). Diz ao bot onde escrever
      no Firestore para a app ler.

RECOMENDADA (resolve o problema do Stooq nos preços):

  TWELVEDATA_KEY
      Chave grátis de twelvedata.com (800 chamadas/dia). Sem ela, forex/ETF/
      commodity dependem só de Stooq/Yahoo (que bloqueiam datacenters). Crypto
      vem da Binance e não precisa de chave.

MODO DE OPERAÇÃO:

  MODE
      "sim"   → simulação 24/7 sem corretora (estás aqui agora)
      "paper" → ordens reais em conta paper (Alpaca paper)
      "real"  → DINHEIRO REAL
      (default: sim)

SÓ PARA PAPER / LIVE (não precisas enquanto estiveres em sim):

  ALPACA_API_KEY
  ALPACA_SECRET_KEY
  ALPACA_BASE_URL          → https://paper-api.alpaca.markets  (paper)
                              https://api.alpaca.markets        (live real)

  BINANCE_API_KEY          → só se quiseres executar crypto na Binance (real)
  BINANCE_SECRET_KEY
  # BINANCE_BASE_URL=https://testnet.binance.vision   → para testes na testnet

  BROKER_ROUTING           → opcional. Quem trata cada classe de ativo.
      Ex.: crypto:binance; etf:alpaca; stock:alpaca; commodity:alpaca
      Se vazio, usa o default (tudo Alpaca; crypto faz failover p/ Binance).

OPCIONAIS (já existiam no teu projeto):

  TELEGRAM_TOKEN           → notificações no Telegram (sem isto, ficam desligadas)
  SIM_CAPITAL              → capital fictício em € (default 1000)
  SIM_TICK_MS              → intervalo entre checks (default 30000 = 30s)
  MAX_POSITION_EUR         → máximo por posição
  MAX_TOTAL_EUR            → máximo total investido em simultâneo
  DAILY_LOSS_LIMIT_EUR     → para o bot se perder mais de X€/dia
  FIREBASE_PROJECT_ID      → ex.: tradeaisimulator-aebcd

═══════════════════════════════════════════════════════════════════════════════
APP — Netlify  (Site settings → Environment variables)
═══════════════════════════════════════════════════════════════════════════════

A app usa as chaves do Firebase no lado do cliente (config pública do Firebase) e,
se aplicável, as das funções Netlify. Confere as que já tinhas configuradas — não
foram alteradas nesta sessão. Tipicamente:

  As VITE_* do Firebase (apiKey, authDomain, projectId, etc.) — já configuradas.
  GROQ_API_KEY (se a função netlify/functions/groq.js a usa do lado servidor).

Nesta sessão NÃO foi adicionada nenhuma variável nova do lado da app. As features
novas (saldo por broker, sugestão de quantia) leem dados que o BOT escreve no
Firestore — não precisam de variáveis novas na Netlify.

═══════════════════════════════════════════════════════════════════════════════
RESUMO RÁPIDO — para arrancar AGORA (ainda em simulação)
═══════════════════════════════════════════════════════════════════════════════

No Railway, garante só estas três e o bot arranca sem crashar:
  • FIREBASE_ADMIN_JSON
  • USER_UID
  • TWELVEDATA_KEY   (recomendada)

As de Alpaca/Binance só quando passares a paper/live.
