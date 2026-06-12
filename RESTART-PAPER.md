# 🔄 Plano — Restart Limpo do Paper

> Guia passo-a-passo para começar um período de teste limpo em paper.
> Faz isto SÓ depois de teres feito deploy de todas as correções (bot + app).

---

## Pré-requisitos (antes de começar)

- [ ] **Deploy do BOT feito** (Railway) — com todas as correções recentes:
  - day-trade e AI-Brain a executar via Alpaca (mode correto)
  - anti-duplicado a funcionar
  - rollover por-tick (arquivo à prova de falhas)
  - Hold coerente com bracket
  - notificações agrupadas + tab Mensagens
- [ ] **Deploy da APP feito** (Netlify) — com o tab Mensagens corrigido e o limit(150)
- [ ] Confirmaste nos logs do Railway que o bot arrancou sem erros de tick

---

## Passo 1 — Fixar a configuração final

Na app, separador **Paper**, define a configuração que vais testar e **não lhe toques durante o teste**:

- [ ] **Perfil de risco**: sugiro **Equilibrado** (SL5/TP6) ou **Scalper** (SL3/TP4),
      pelo problema do rácio SL/TP que vimos (agressivo SL9/TP18 batia sempre no SL).
- [ ] **Ajuste por categoria**: se ficares em agressivo, mete Crypto a ~0.5–0.6×.
- [ ] **Origens ligadas**: confirma Estratégias, Day Trading e AI-Brain todos ON.
- [ ] **Limites de posições**: revê os máximos (Estratégias / AI-Brain / Day Trading).
- [ ] **Guarda** as definições no separador Paper.

> Nota: o Groq continua bloqueado, por isso o Day Trading vai estar em pausa e o
> AI-Brain em modo técnico. É esperado — testas estratégias + AI técnico. Quando
> o Groq abrir, fazes o restart final com IA completa.

---

## Passo 2 — Pausar o bot

- [ ] Na app, carrega no botão **⏸ Pausar** (cartão de estado do bot).
- [ ] Confirma que o bot parou (não abre novos trades).

Isto evita que o bot abra posições a meio da limpeza.

---

## Passo 3 — Reset da conta paper na Alpaca

Para começar com os $100.000 limpos:

- [ ] Entra no dashboard da Alpaca (conta **paper**).
- [ ] Vai a **Account / Settings** e usa **"Reset Paper Account"**.
- [ ] Isto repõe o saldo inicial E fecha todas as posições do lado da corretora.

> Se preferires manter o saldo atual (não recomeçar do zero), salta este passo —
> mas o teste de rentabilidade fica menos limpo.

---

## Passo 4 — Pré-visualizar o reset do Firestore

No Railway, abre o **Console** do serviço do bot e corre:

```
node scripts/reset-paper.js
```

- [ ] Lê o output: mostra quantas posições/trades de paper SERIAM apagados.
- [ ] Confirma que os números fazem sentido (NÃO toca em trades de simulação).
- [ ] Nada é apagado neste passo — é só pré-visualização.

---

## Passo 5 — Executar o reset do Firestore

Se os números do passo 4 estiverem bem:

```
node scripts/reset-paper.js --executar
```

- [ ] Apaga os trades de paper (mode "live")
- [ ] Limpa a fila de comandos
- [ ] Repõe o liveBalance ao cash real da Alpaca
- [ ] Preserva: simulação, estratégias, definições, Arquivo Diário

> O script recusa-se a correr se MODE=real (proteção). Em paper corre normal.

---

## Passo 6 — Retomar o bot

- [ ] Na app, carrega em **▶ Retomar**.
- [ ] Nos logs do Railway, confirma o arranque limpo:
  - `Reconciliação: tudo alinhado` (ou recupera o que houver)
  - **0 posições** (ou só as que abriste de novo)
  - Saldo de paper no valor inicial

---

## Passo 7 — Validar nos primeiros minutos

- [ ] Aparecem compras das 3 origens (estratégia, AI técnico, day-trade se Groq permitir)
- [ ] As compras **aparecem na app** (não só no Telegram) — confirma que o bug
      dos trades fantasma está resolvido
- [ ] O Telegram envia **resumos agrupados** (não spam individual)
- [ ] O tab **Mensagens** mostra os eventos

---

## Durante o teste (1–2 semanas)

- **Não mexas na configuração** — deixa correr para teres dados limpos.
- Acompanha o **€/trade** no Arquivo Diário: a métrica-chave. Deves ver menos
  trades mas maior lucro médio por trade do que os ~€1.20 de antes (microtrading).
- Vigia o **Win Rate**: se continuar muito baixo (<30%), o problema é o rácio
  SL/TP do perfil — ajusta no restart seguinte, não a meio.
- Quando o **Groq** abrir: upgrade para Developer Tier, e considera um restart
  final para o teste com IA completa.

---

## Se algo correr mal

- **Posições fantasma / app não mostra trades** → já corrigido (mode dinâmico).
- **Spam de compras repetidas** → já corrigido (anti-duplicado + execução real).
- **Dia não arquivado** → já corrigido (rollover por-tick).
- **Erro no tab Mensagens** → já corrigido (useState movido).
- Se aparecer algo novo, tira print dos logs do Railway + consola da app.

---

*Lembra-te: o objetivo do paper é validar o sistema completo com execução real na
corretora, sem arriscar dinheiro. Um teste limpo de 1–2 semanas dá-te a confiança
(ou os alertas) que precisas antes de passar a live.*
