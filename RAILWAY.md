# 🚂 Deploy no Railway — Passo a Passo

O bot já está pronto para o Railway. Não precisas de servidor nem de PM2 — o Railway
trata de manter o processo a correr 24/7 e reinicia-o se falhar.

---

## Antes de começar — junta estas 3 coisas

### 1. Credencial do Firebase (FIREBASE_ADMIN_JSON)
- Firebase Console → o teu projeto (`tradeaisimulator-aebcd`)
- ⚙ Project Settings → separador **Service accounts**
- Botão **Generate new private key** → faz download do ficheiro `.json`
- Abre o ficheiro e **copia todo o conteúdo** (é uma única estrutura JSON).
  No Railway vais colar isto numa variável.

### 2. O teu UID (USER_UID) — MUITO IMPORTANTE
O bot tem de escrever no mesmo sítio onde a tua app lê. Esse sítio é o teu UID.
- Na app TradeAI → **Definições** → botão **Copiar UID**
- Sem isto, o bot escreve em `users/server` e **não vais ver nada na app**.

### 3. Chave da Groq (GROQ_API_KEY)
- console.groq.com → API Keys → cria uma → começa por `gsk_...`
- (É o que alimenta os sinais de IA do bot. Sem ela o bot corre na mesma, mas
  sem o "cérebro AI".)

---

## Passo 1 — Pôr o código no GitHub

```bash
cd TradeAI-bot
git init
git add .
git commit -m "TradeAI bot"
# cria um repo novo no github.com e depois:
git remote add origin https://github.com/O_TEU_USER/tradeai-bot.git
git branch -M main
git push -u origin main
```

> O `.gitignore` já garante que `node_modules`, `.env` e a credencial Firebase
> **não** vão para o GitHub. Nunca commites segredos.

## Passo 2 — Criar o projeto no Railway

1. Vai a **railway.com** → faz login (com o GitHub é mais fácil)
2. **New Project** → **Deploy from GitHub repo** → escolhe o `tradeai-bot`
3. O Railway deteta o `railway.json` e o `package.json` e começa a build sozinho.

## Passo 3 — Configurar as variáveis de ambiente

No projeto → separador **Variables** → adiciona uma a uma:

| Variável | Valor | Obrigatória? |
|---|---|---|
| `MODE` | `sim` | sim (começa sempre em sim) |
| `USER_UID` | *(o UID copiado da app)* | **SIM — sem isto não vês nada** |
| `FIREBASE_ADMIN_JSON` | *(cola o JSON inteiro da credencial)* | sim |
| `FIREBASE_PROJECT_ID` | `tradeaisimulator-aebcd` | sim |
| `GROQ_API_KEY` | `gsk_...` | recomendado |
| `SIM_CAPITAL` | `1000` | opcional |
| `SIM_TICK_MS` | `30000` | opcional |
| `MAX_POSITION_EUR` | `300` | opcional |
| `MAX_TOTAL_EUR` | `800` | opcional |
| `DAILY_LOSS_LIMIT_EUR` | `150` | opcional |
| `AI_SIGNALS_MIN` | `15` | opcional (minutos entre análises IA) |
| `TELEGRAM_TOKEN` | *(opcional)* | não |
| `TELEGRAM_CHAT_ID` | *(opcional)* | não |

> Para o `FIREBASE_ADMIN_JSON`: cola o conteúdo do ficheiro tal como está
> (o Railway aceita o JSON com quebras de linha). Se preferires, podes colá-lo
> numa única linha — funciona à mesma.

## Passo 4 — Confirmar que está vivo

1. No Railway, abre os **Deploy Logs**. Deves ver:
   ```
   Health server na porta XXXX ✓
   Firebase Admin inicializado ✓ (uid: <o teu uid>)
   Motor iniciado — tick cada 30s ✓
   ```
2. Railway → **Settings → Networking → Generate Domain**. Abre o URL gerado:
   deve responder com um JSON `{"ok":true,...}` — é o health-check.
3. Na app TradeAI, ao fim de ~30s, a barra laranja "Bot 24/7 offline" passa a
   verde: **"🤖 Bot 24/7 ativo — a operar no servidor"**.

A partir daqui, mesmo com a app fechada, o bot continua a operar no servidor.

---

## Mudar para trading real (mais tarde)

Só depois de teres resultados bons em simulação:
1. Cria conta na **Alpaca** (paper primeiro) e gera as chaves.
2. No Railway, muda `MODE` para `demo` (paper) e adiciona:
   `BROKER=alpaca`, `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`,
   `ALPACA_BASE_URL=https://paper-api.alpaca.markets`
3. Só quando o paper for consistente é que passas a `MODE=real` com a URL real.

---

## Resolução de problemas

- **A app continua "offline":** quase sempre é o `USER_UID` errado/em falta. Copia-o
  outra vez da app e confirma que é exatamente igual na variável do Railway.
- **`FIREBASE_ADMIN_JSON inválido`:** colaste o JSON incompleto. Copia o ficheiro
  todo, desde o primeiro `{` até ao último `}`.
- **`CoinGecko 429` nos logs:** é normal de vez em quando (limite gratuito); o bot
  usa cache e recupera sozinho.
- **Custo:** o Railway tem um plano gratuito com créditos mensais; este bot é leve
  e costuma caber lá. Verifica o uso no painel do Railway.
