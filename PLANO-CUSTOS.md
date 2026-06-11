# 💰 Plano de Custos Mensal — TradeAI

> Referência de custos e thresholds para a operação do TradeAI.
> Preços verificados em junho de 2026. Valores podem mudar — confirma nos painéis de cada serviço.

---

## Resumo rápido

| Cenário | Custo/mês | O que inclui |
|---|---|---|
| **Mínimo funcional** | **~€6** | Só Railway (bot 24/7) |
| **Recomendado** | **~€10** | Railway + Groq pay-as-you-go (destrava a IA) |
| **Máximo confortável** | **~€20** | Railway + Groq + TwelveData pago (dados premium) |

**Conclusão:** a app é uma fonte de investimento funcional por **~€6/mês**. Os teus 20€ dão muita folga.

---

## 1. Infraestrutura (custos de correr a app)

### Railway — bot 24/7  ⚙️ ÚNICO CUSTO FIXO REAL
- **Plano Hobby: $5/mês** (≈ €5), inclui $5 de créditos de uso.
- O bot é Node.js leve; com 0.5 vCPU / 512MB fica perto dos $5.
- Uso típico de um Node simples: **$5–8/mês**.
- ⚠️ Container parado também consome — não sobre-provisionar recursos.
- **Estimativa: €5–7/mês.**

### Netlify — app + frontend  🆓 GRÁTIS (uso pessoal)
- Free tier 2026: **300 créditos/mês** (≈ 15 GB largura de banda, ~20 deploys, funções incluídas).
- Sozinho a usar a app → **€0**.
- ⚠️ Free não recarrega: tráfego para quando os créditos acabam (não é problema para uso pessoal).
- Só passar a Pro ($20/mês) se houver muitos utilizadores ou centenas de deploys.
- **Estimativa: €0/mês.**

### Firebase / Firestore — base de dados  🆓 GRÁTIS (com cuidado) ⚠️
- Plano Spark (grátis): **50.000 leituras/dia, 20.000 escritas/dia, 1 GB storage, 10k auth/mês.**
- **Onde está o risco escondido:**
  - O bot escreve a cada tick (30s). Escritas recorrentes base ≈ **2.880/dia** (simLive, marketPrices, heartbeat). Confortável, mas sobe com mais ativos/frequência.
  - **Leituras** são o maior risco: a app subscreve trades/settings/arquivos em tempo real. Deixar a app aberta muito tempo consome leituras continuamente.
  - Ultrapassar → passa a **Blaze (pay-as-you-go), que NÃO tem teto de gastos por defeito.** É o único sítio onde pode haver surpresa na fatura.
- ✅ **AÇÃO OBRIGATÓRIA:** definir um **alerta de orçamento no Google Cloud Billing** (ex.: €5/mês) antes ou logo após passar a Blaze.
- **Estimativa: €0/mês (uso pessoal), desde que monitorizado.**

---

## 2. APIs de dados

| Fonte | Cobre | Custo | Notas |
|---|---|---|---|
| **Binance + CoinGecko** | Crypto (o forte) | €0 | 100% gratuito, sem chave/limite relevante |
| **Finnhub** | ETFs / ações / forex | €0 | Free 60 chamadas/min; ações/ETF US em tempo real |
| **TwelveData** | Backup não-crypto | €0 (free) | Free esgota: 800 créditos/dia (o "Basic 8") |
| **Groq** | Sinais AI (Cérebro AI, Day Trading) | €0 free | Free 100k tokens/dia esgota; pay-as-you-go ~€3–5/mês |
| **Yahoo Finance** | Último recurso não-crypto | €0 | Sem chave, menos fiável |

**Threshold de dados:** praticamente **€0** — crypto está coberto de graça e o Finnhub cobre os não-crypto.

---

## 3. Como gastar os 20€/mês (por prioridade)

1. **Railway Hobby (~€6)** — obrigatório. É onde o bot vive 24/7.
2. **Groq pay-as-you-go (~€4)** — PRIORIDADE a seguir ao Railway. Remove o limite de tokens
   que bloqueia o Cérebro AI e o Day Trading (o coração da app). Sem cartão fica limitado;
   com cartão paga-se só o que se usa (~€3–5/mês no padrão atual).
3. **TwelveData pago (~€10–12)** — OPCIONAL. Só se o Finnhub se revelar insuficiente para
   forex/commodities. Remove o limite diário (o 804/800 que viste). Com o Finnhub grátis a
   cobrir o mesmo, provavelmente **não é preciso**.

### Recomendação concreta
> **Railway (€6) + Groq pay-as-you-go (€4) ≈ €10/mês**, deixando dados no free (Finnhub + Binance).
> Sobram **€10** dos 20€ — só usar se precisares mesmo de dados premium não-crypto.

---

## 4. Thresholds (a partir de quando pagas)

| Item | Grátis até | Depois |
|---|---|---|
| Railway | (sempre $5 base) | uso > $5 → paga o excedente |
| Netlify | 300 créditos/mês (~15 GB) | suspende ou Pro $20/mês |
| Firestore escritas | 20.000/dia | Blaze pay-as-you-go (sem teto ⚠️) |
| Firestore leituras | 50.000/dia | Blaze pay-as-you-go (sem teto ⚠️) |
| Groq | 100k tokens/dia | pay-as-you-go |
| Finnhub | 60 chamadas/min | plano pago |
| TwelveData | 800 créditos/dia | plano pago (~€10–12) |

---

## 5. Checklist antes de "live a sério"

- [ ] Railway Hobby ativo e bot estável (verificar uso no dashboard semanalmente)
- [ ] **Alerta de orçamento no Google Cloud Billing** (Firestore Blaze sem teto)
- [ ] Groq: decidir free vs pay-as-you-go conforme o uso real (ver console.groq.com)
- [ ] Finnhub key configurada (cobre não-crypto grátis)
- [ ] Publicar Firestore rules (bloqueador de segurança, ver firestore.rules)
- [ ] Monitorizar leituras/escritas Firestore na consola na 1ª semana

---

*Nota: estimativas baseadas em uso pessoal (1 utilizador) com o bot a operar 24/7 em tick de 30s.
Custos reais dependem do padrão de uso — confirma sempre nos painéis dos serviços.*
