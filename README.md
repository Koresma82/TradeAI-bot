# ◆ TradeAI Bot — Servidor 24/7 (Railway)

Corre toda a automação (estratégias, cérebro AI, compra/venda) no servidor,
sem precisar do browser aberto. Deploy no **Railway**.

---

## 🚀 Deploy

O passo-a-passo completo está em **[RAILWAY.md](./RAILWAY.md)**. Resumo:

1. Põe esta pasta no GitHub (`git init` → push). O `.gitignore` protege os segredos.
2. Railway → **New Project** → **Deploy from GitHub repo** → escolhe o repo.
3. Em **Variables**, define (no mínimo):
   ```env
   MODE=sim
   USER_UID=<o teu UID — copia na app em Definições → Copiar UID>
   FIREBASE_ADMIN_JSON=<cola o JSON da Service Account do Firebase>
   FIREBASE_PROJECT_ID=tradeaisimulator-aebcd
   GROQ_API_KEY=gsk_...
   ```
4. Settings → Networking → **Generate Domain** e abre o URL: deve responder
   `{"ok":true,...}` (health-check).
5. Ao fim de ~30s, na app, a barra "Bot 24/7 offline" passa a verde.

> **`USER_UID` é crítico.** O bot escreve em `users/{USER_UID}` e a app lê no teu
> UID de login. Sem ele, não vês os trades do bot na app.

---

## 📊 O que o bot faz (toda a automação vive aqui)

- Lê as estratégias e definições criadas na app (Firestore), em tempo real.
- Busca preços reais (CoinGecko para cripto + Stooq para o resto) a cada 30s.
- **Cérebro AI**: gera sinais com a Groq e abre posições de alta confiança.
- **Estratégias**: compra na queda configurada, gere SL/TP e trailing stop.
- **Saída por flip da IA**: fecha se a IA virar para VENDER com confiança.
- Guarda trades, saldo, P&L e heartbeat no Firestore → a app mostra tudo ao vivo.
- Respeita os limites (máx. por posição, máx. total, perda diária).
- Relatório diário e alertas pelo Telegram (opcional).
- Funciona 24/7 mesmo com o computador/app desligados.

---

## 🔄 Progressão de modos

```
MODE=sim   → Simulação 24/7 (sem corretora) — começa aqui
    ↓ resultados positivos por ~15 dias?
MODE=demo  → Paper Trading Alpaca (preços reais, dinheiro fictício)
    ↓ resultados consistentes?
MODE=real  → Dinheiro real (Alpaca / IBKR)
```

Para mudar de modo no Railway: muda a variável `MODE` e adiciona as chaves da
corretora (ver RAILWAY.md → "Mudar para trading real"). O Railway reinicia sozinho.

---

## 💻 Correr localmente (opcional, para testar)

```bash
npm install
cp .env.example .env   # preenche as variáveis
# coloca a credencial em config/firebase-admin.json OU usa FIREBASE_ADMIN_JSON
npm run start:demo     # ou: MODE=sim node src/index.js
```

---

## 💰 Custos

| Item | Custo |
|------|-------|
| Railway | Plano gratuito com créditos mensais (este bot é leve e costuma caber) |
| Firebase (Firestore) | Gratuito (plano Spark) |
| CoinGecko / Stooq | Gratuito |
| Groq | ~€1-2/mês (tem tier gratuito generoso) |
| Telegram Bot | Gratuito |
