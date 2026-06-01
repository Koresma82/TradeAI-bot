# ◆ TradeAI Bot — Servidor 24/7

Corre estratégias de simulação ou trading real sem precisar do browser aberto.

---

## 🚀 COMEÇAR — 3 passos

### Passo 1 — Hetzner (servidor €4/mês)

1. Vai a **hetzner.com** → Cloud → Create Server
2. Escolhe: **CX22** · Ubuntu 24.04 · Frankfurt · €3.79/mês
3. Cria uma SSH Key ou usa password
4. Liga-te ao servidor:
```bash
ssh root@IP_DO_SERVIDOR
```

### Passo 2 — Instalar Node.js e PM2

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# PM2 (gestor de processos)
npm install -g pm2

# Criar pasta
mkdir /opt/tradeai-bot
```

### Passo 3 — Copiar o bot e configurar

```bash
# No teu PC, copia a pasta tradeai-bot para o servidor
scp -r tradeai-bot/ root@IP_DO_SERVIDOR:/opt/tradeai-bot/

# No servidor
cd /opt/tradeai-bot
npm install
cp .env.example .env
nano .env   # preenche as variáveis
```

**Variáveis obrigatórias para modo SIM:**
```env
MODE=sim
SIM_CAPITAL=1000
FIREBASE_PROJECT_ID=tradeaisimulator-aebcd
```

**Firebase Admin JSON** (obrigatório):
- Firebase Console → Project Settings → Service Accounts → Generate new private key
- Descarrega o JSON e coloca em `/opt/tradeai-bot/config/firebase-admin.json`

---

## ▶ Iniciar o Bot

```bash
# Modo SIMULAÇÃO 24/7 (começa aqui)
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # auto-start no boot

# Ver logs em tempo real
pm2 logs tradeai-sim
```

---

## 📊 O que faz em modo SIM

- Lê estratégias criadas na app React (Firestore)
- Busca preços reais (CoinGecko + Yahoo Finance) a cada 30s
- Executa a lógica de compra/venda de acordo com as estratégias
- Guarda trades e saldo no Firestore
- A app React mostra os resultados em tempo real
- Envia relatório diário pelo Telegram (se configurado)
- Funciona 24/7 mesmo com o computador desligado

---

## 🔄 Progressão de modos

```
MODE=sim   → Simulação 24/7 (sem corretora) — começa aqui
    ↓ resultados positivos por 15 dias?
MODE=demo  → Paper Trading Alpaca (preços reais, dinheiro fictício)
    ↓ resultados consistentes?
MODE=real  → Dinheiro real no Alpaca ou IBKR
```

Para mudar de modo:
```bash
nano .env         # altera MODE=sim para MODE=demo
pm2 restart tradeai-sim
```

---

## 💰 Custos

| Item | Custo |
|------|-------|
| Hetzner CX22 | €3.79/mês |
| Firebase (Firestore) | Gratuito (plano Spark) |
| Yahoo Finance / CoinGecko | Gratuito |
| Telegram Bot | Gratuito |
| **Total** | **~€4/mês** |
