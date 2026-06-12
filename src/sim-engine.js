// src/sim-engine.js
// Motor de simulação 24/7 — corre no servidor sem IBKR/Alpaca
// Lê estratégias do Firestore, executa lógica, guarda trades no Firestore
// A app React lê os resultados em tempo real via onSnapshot

const logger  = require("./logger");
const fb      = require("./firebase");
const prices  = require("./prices");
const indicators = require("./indicators");
const stats   = require("./stats");
const aiSignals = require("./ai-signals");
const dayTrading = require("./day-trading");
const broker  = require("./broker");
const { notify, queueOpen, tg } = require("./telegram");

// Publica um evento no tab Mensagens da app (via Firestore logs/{dia}).
// Não bloqueia o tick — falhas são silenciosas. level: buy|sell|warn|error|info.
function logEvent(level, msg) {
  fb.appendLog("server", { level, msg }).catch(() => {});
}

const uid = () => require("crypto").randomUUID();

// ── Estado em memória ─────────────────────────────────────────────────────────
let strategies    = [];
let openPositions = {};  // { posId: { ...position } }
let priceHistory  = {};  // { assetId: [{ price, ts }] } — intradiário (curto prazo)
let dailySeries   = {};  // { assetId: [fechos diários] } — para indicadores (RSI/MM)
let noPriceWarned = {};  // { assetId: ts } — controlo de avisos "sem preço"
let lastBuyTime   = {};  // cooldown por estratégia/ativo
let lastLossTime  = {};  // cooldown pós-perda por ativo (mais longo após um SL)
let botPaused     = false; // pausa de novas entradas (toggle na app; SL/TP continua)
let tickCount     = 0;
let totalInvested = 0;
let dailyLossHit  = false;
// ── Controlo de escritas ao Firestore (poupar quota/custos) ──────────────────
let lastSimLiveJson    = "";   // último simLive escrito (só reescreve se mudar)
let lastSimLiveAt      = 0;    // timestamp da última escrita de simLive
let lastHeartbeatAt    = 0;    // timestamp do último botStatus escrito
let lastFeaturesJson   = "";   // últimas features escritas no botStatus
const SIMLIVE_MIN_MS   = 60 * 1000;       // no máx. 1 escrita de simLive por minuto
const PRICES_PUB_MS    = 2 * 60 * 1000;   // publica preços p/ a app a cada 2 min
let lastPricesAt       = 0;
let lastPricesJson     = "";   // último marketPrices publicado (só reescreve se mudar)
const HEARTBEAT_MS     = 2 * 60 * 1000;   // heartbeat a cada 2 min (app exige < 3 min)
// Definições lidas do Firestore (a app controla isto)
let appSettings   = {
  maxEstrategias: 5,
  maxManuais: 5,           // limite de posições abertas por compras manuais
  maxAiBrain: 3,           // limite SÓ para o Cérebro AI (separado das estratégias)
  riscoPerfil: "moderado",
  modoValor: "fixo",
  rotacaoAtiva: false,
  rotacaoMinPct: 1,        // lucro mínimo (%) para a rotação disparar (evita microtrading)
  // Automação avançada com IA
  aiBrain: false,
  aiBrainConfianca: 78,
  trailingStop: false,
  trailingStopPct: 4,
  aiExitOnFlip: true,
  stopLossPadrao: 6,
  takeProfitPadrao: 12,
  valorFixo: 100,
  maxDayTrading: 5,
  maxValorTrade: 100,      // teto ABSOLUTO em € por trade (independente do saldo)
  maxPosicoesTotal: 40,    // limite GLOBAL de posições abertas ao mesmo tempo
  scaleOutTP: false,       // TP parcial desligado por defeito
  scaleOutPct: 50,
  // Ajuste de SL/TP/queda por CATEGORIA de ativo. O perfil global dá os valores
  // base; estes multiplicadores adaptam-nos à volatilidade típica de cada classe.
  // Ex.: perfil SL 6% × crypto 1.5 = SL 9% para crypto; × forex 0.4 = SL 2.4%.
  // 1.0 = usa o valor do perfil tal e qual. Editável na app.
  catAjuste: {
    Crypto:    1.5,
    Commodity: 1.0,
    ETF:       0.7,
    Forex:     0.4,
    Ação:      1.1,
  },
  // Valor (€) e teto (€) por trade SEPARADOS por origem. Cada origem pode ter o
  // seu próprio valor fixo e teto; 0/null/ausente = herda o global (valorFixo /
  // maxValorTrade). Isto permite, ex.: estratégias €50, AI €30, day-trade €20.
  perOrigem: {
    estrategias: { valorFixo: 0, maxValorTrade: 0 },
    aibrain:     { valorFixo: 0, maxValorTrade: 0 },
    daytrading:  { valorFixo: 0, maxValorTrade: 0 },
    manual:      { valorFixo: 0, maxValorTrade: 0 },
  },
};
let dtConfig = null; // config de day trading lida da app (dtState)
let simBalance    = parseFloat(process.env.SIM_CAPITAL || "1000");
let simCapital    = simBalance;
// Ativos negociáveis: derivados da lista do prices.js (fonte única de verdade).
// Todos têm fonte de preço real (CoinGecko ou Stooq), por isso o bot consegue
// mesmo negociá-los. A app lê esta lista publicada no Firestore.
const TRADEABLE = new Set(prices.ASSETS.map(a => a.id));

// ── Helpers ───────────────────────────────────────────────────────────────────
const sign = v => v >= 0 ? "+" : "−";
const eur  = v => `€${Math.abs(v).toFixed(2)}`;

// Categorias por ativo (para saber se o mercado está aberto)
const ASSET_CAT = Object.fromEntries(prices.ASSETS.map(a => [a.id, a.cat]));

// Devolve o fator de ajuste de SL/TP/queda para a categoria de um ativo.
// O perfil global dá o valor base; aqui multiplica-se pela volatilidade típica
// da classe. Crypto mexe muito (SL/TP largos), forex pouco (apertados).
function catFactor(assetId) {
  const cat = ASSET_CAT[assetId];
  const m = (appSettings.catAjuste || {})[cat];
  return (typeof m === "number" && m > 0) ? m : 1.0;
}
// SL/TP/queda efetivos para um ativo: valor do perfil × fator da categoria.
// clamps para evitar valores absurdos (SL/TP entre 0.3% e 60%, queda 0.1%-15%).
function adjustedRisk(assetId, baseSl, baseTp, baseDrop) {
  const f = catFactor(assetId);
  const sl   = Math.min(60, Math.max(0.3, baseSl  * f));
  const tp   = Math.min(60, Math.max(0.3, baseTp  * f));
  const drop = baseDrop == null ? null : Math.min(15, Math.max(0.1, baseDrop * f));
  return { sl, tp, drop, factor: f };
}

// Mercado aberto para um ativo?
//  - Crypto: sempre (24/7)
//  - Forex:  seg-sex (24h nos dias úteis)
//  - ETF/Commodity (US): seg-sex, 14:30–21:00 UTC (NYSE/COMEX aprox.)
function isMarketOpenFor(assetId) {
  const cat = ASSET_CAT[assetId];
  if (cat === "Crypto") return true;
  const now = new Date();
  const dow = now.getUTCDay();        // 0=dom, 6=sáb
  if (dow === 0 || dow === 6) return false;
  if (cat === "Forex") return true;   // dias úteis: forex praticamente 24h
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 14 * 60 + 30 && mins <= 21 * 60; // 14:30–21:00 UTC
}

function recordPrice(assetId, price) {
  if (!priceHistory[assetId]) priceHistory[assetId] = [];
  const now = Date.now();
  priceHistory[assetId].push({ price, ts: now });
  priceHistory[assetId] = priceHistory[assetId].filter(p => now - p.ts < 5 * 60 * 1000);
}

function getRecentHigh(assetId) {
  const pts = priceHistory[assetId] || [];
  return pts.length ? Math.max(...pts.map(p => p.price)) : null;
}

// ── Gerir posições abertas: trailing stop, flip da IA, SL/TP ──────────────────
async function checkSLTP(currentPrices) {
  const trailingOn = !!appSettings.trailingStop;
  const trailPct   = appSettings.trailingStopPct || 4;
  const exitOnFlip = appSettings.aiExitOnFlip !== false;
  const flipConf   = appSettings.aiBrainConfianca || 78;

  for (const [posId, pos] of Object.entries(openPositions)) {
    // Só geримос com preço REAL e fresco. Um preço "seed" (base estático) ou
    // stale não pode disparar SL/TP/AI-EXIT — senão comparávamos a entrada real
    // com um preço fantasma e fechávamos a posição ao valor errado.
    const price = prices.isReal(pos.assetId) ? currentPrices[pos.assetId]?.price : null;
    if (!price) {
      // Posição aberta sem preço REAL atual (fonte falhou, preço só em base, ou
      // ativo removido). Não a perdemos — fica aberta e gerida assim que voltar
      // um preço fresco de feed. Avisa 1x por hora para não encher os logs.
      const k = `nopx_${pos.assetId}`;
      if (!noPriceWarned[k] || Date.now() - noPriceWarned[k] > 3600000) {
        logger.warn(`⚠ Sem preço real fresco para ${pos.assetSym || pos.assetId} (posição aberta continua segura, à espera de preço de feed)`);
        noPriceWarned[k] = Date.now();
      }
      continue;
    }

    // ── Trailing stop: sobe o SL atrás do pico quando há lucro ──
    if (trailingOn) {
      const peak = Math.max(pos.peak || pos.entryPrice, price);
      pos.peak = peak;
      if (peak > pos.entryPrice) {
        const trailSl = +(peak * (1 - trailPct / 100)).toFixed(pos.assetId === "eurusd" ? 5 : 4);
        if (trailSl > pos.sl) {
          pos.sl = trailSl;
          // persiste o novo SL para a app ver
          fb.updateTrade("server", posId, { sl: trailSl, peak }).catch(() => {});
        }
      }
    }

    // Fix 5: se a corretora gere SL/TP desta posição (bracket nativo em ações),
    // o motor NÃO mexe — quem fecha é a corretora. Evita o duplo-fecho (bot +
    // bracket) que resultaria numa venda a descoberto. A reconciliação no
    // arranque/periódica deteta quando o bracket fechou a posição.
    if (pos.brokerSLTP) continue;

    let reason = null;
    let closePrice = price;

    // ── Hold manual: se o utilizador ligou "Hold" nesta posição, o bot NÃO
    //    fecha por AI-EXIT nem por TP — deixa o lucro correr. Mas o SL mantém-se
    //    sempre (proteção contra perdas). ──
    const onHold = pos.hold === true;

    // ── Tempo mínimo de vida: o AI-EXIT não pode fechar uma posição nos
    //    primeiros 2 minutos. Evita que uma compra (manual ou AI) seja fechada
    //    de imediato por um sinal de VENDER que já estava ativo. O SL/TP não
    //    são afetados por isto (a proteção contra perdas é sempre imediata). ──
    const idadeMs = pos.openedTs ? (Date.now() - pos.openedTs) : Infinity;
    const podeAiExit = idadeMs >= 120000; // 2 min

    // ── Saída antecipada se a IA virar para VENDER com confiança ──
    // Só fecha SE o lucro LÍQUIDO (após comissões ida-e-volta) for positivo com
    // uma margem mínima. Antes, fechávamos em qualquer micro-lucro (+€0.01), que
    // em cripto (0.25%/lado) seria PERDA depois das comissões. Agora o AI-EXIT
    // só dispara se valer mesmo a pena.
    const sg = aiSignals.getSignal(pos.assetId);
    const rtFee = broker.roundTripFee(pos.assetId, pos.amount); // comissão compra+venda (€)
    const minLucro = rtFee + (pos.amount * 0.0010); // comissões + 0.10% de margem
    const lucroLiquidoSeFechar = (price - pos.entryPrice) * pos.units - rtFee;
    const valeAPena = lucroLiquidoSeFechar >= (pos.amount * 0.0010); // lucro líq. acima da margem
    if (!onHold && podeAiExit && exitOnFlip && sg && sg.sinal === "VENDER" && (sg.confianca || 0) >= flipConf && valeAPena && price > pos.sl) {
      reason = "AI-EXIT"; closePrice = price;
    }
    else if (price <= pos.sl) {
      // Carência de SL para posições MANUAIS: nos primeiros 60s não fecha por SL,
      // evitando o fecho-relâmpago logo após a compra manual (cripto volátil).
      const manualGrace = pos.stratId === "manual" && idadeMs < 60000;
      if (!manualGrace) {
        reason = (trailingOn && pos.sl > pos.entryPrice) ? "TRAIL" : "SL";
        // Fecha ao preço REAL de mercado, não ao SL teórico. Quando o preço salta
        // para lá do SL, fechas onde o mercado está — isto reflete o slippage real
        // e evita que a simulação pareça melhor do que o paper/real será.
        closePrice = Math.min(price, pos.sl);
      }
    }
    else if (!onHold && price >= pos.tp) {
      // O TP só fecha se o lucro líquido (após comissões) for positivo com margem.
      // Em TPs largos (12%) isto passa sempre; em TPs apertados (scalper/ajuste
      // baixo) evita "ganhar" no TP mas perder depois das taxas. NÃO afeta o SL.
      const feeTP = broker.roundTripFee(pos.assetId, pos.amount);
      const liqTP = (price - pos.entryPrice) * pos.units - feeTP;
      if (liqTP < (pos.amount * 0.0010)) {
        // ainda não cobre taxas + margem → não fecha, deixa o preço subir mais
        continue;
      }
      // ── TAKE-PROFIT PARCIAL (scale-out) — opcional, melhora retorno ────────
      // Em vez de "tudo ou nada" no TP, vende uma fração (default 50%) e deixa
      // o resto correr com o SL movido para break-even (entryPrice). Captura
      // lucro garantido e mantém exposição ao upside. Só em crypto (não mexe
      // em posições com bracket nativo) e só uma vez por posição.
      const scaleOn = appSettings.scaleOutTP === true && !pos.brokerSLTP && !pos.scaledOut;
      if (scaleOn) {
        const frac = Math.min(0.9, Math.max(0.1, (appSettings.scaleOutPct ?? 50) / 100));
        const sellUnits = +(pos.units * frac).toFixed(7);
        let partialClose = Math.max(price, pos.tp);
        if (broker.isLive()) {
          const exec = await broker.sell({ assetId: pos.assetId, units: sellUnits, price: partialClose, broker: pos.broker, hadBracket: false });
          if (!exec.ok) { logger.warn(`Scale-out ${pos.assetSym} falhou: ${exec.reason}`); /* tenta fecho normal abaixo */ }
          else if (typeof exec.fillPrice === "number" && exec.fillPrice > 0) partialClose = exec.fillPrice;
        }
        const soldAmount = pos.amount * frac;
        const feeP = broker.roundTripFee(pos.assetId, soldAmount);
        const pnlP = +(((partialClose - pos.entryPrice) * sellUnits) - feeP).toFixed(4);
        // Atualiza a posição: fica com o restante e SL em break-even.
        pos.units  = +(pos.units - sellUnits).toFixed(7);
        pos.amount = +(pos.amount - soldAmount).toFixed(2);
        pos.sl     = Math.max(pos.sl, pos.entryPrice); // protege o lucro já feito
        pos.tp     = +(pos.tp * (1 + ((appSettings.takeProfitPadrao || 12) / 100))).toFixed(6); // novo alvo mais alto
        pos.scaledOut = true;
        totalInvested = Math.max(0, totalInvested - soldAmount);
        simBalance = +(simBalance + soldAmount + pnlP).toFixed(2);
        await fb.updateTrade("server", posId, { units: pos.units, amount: pos.amount, sl: pos.sl, tp: pos.tp, scaledOut: true, partialPnl: pnlP }).catch(() => {});
        await fb.saveBalance("server", simBalance);
        stats.addClosedTrade({ ...pos, id: `${posId}_p`, units: sellUnits, amount: soldAmount, status: "TP-PARCIAL", closePrice: partialClose, pnl: pnlP, fee: feeP, closedTs: Date.now() });
        logger.info(`📊 TP parcial ${pos.assetSym}: vendeu ${(frac*100).toFixed(0)}% (+${eur(pnlP)}), resto corre com SL em break-even`);
        await notify(`📊 *TP parcial* ${pos.assetSym}\nVendido ${(frac*100).toFixed(0)}% · +${eur(pnlP)}\nResto a correr (SL em break-even)`).catch(() => {});
        continue; // não fecha tudo — o resto continua aberto
      }
      reason = "TP";
      closePrice = Math.max(price, pos.tp); // idem: preço real, não o TP teórico
    }

    if (!reason) continue;

    // ── Executar a venda real na Alpaca se em modo live ──
    if (broker.isLive()) {
      const exec = await broker.sell({ assetId: pos.assetId, units: pos.units, price: closePrice, broker: pos.broker, hadBracket: !!pos.brokerSLTP });
      if (!exec.ok) {
        logger.warn(`Venda ${pos.assetSym} falhou: ${exec.reason} — tenta no próximo tick`);
        continue; // não fecha localmente se a corretora recusou
      }
      // Fix 1: usar o preço REAL de execução para o P&L (não o teórico).
      if (typeof exec.fillPrice === "number" && exec.fillPrice > 0) closePrice = exec.fillPrice;
    }

    // P&L LÍQUIDO: lucro bruto menos comissões ida-e-volta. Em sim isto torna o
    // resultado realista (igual ao paper/real); em ações/ETF a comissão é 0.
    const pnlBruto = (closePrice - pos.entryPrice) * pos.units;
    const fee = broker.roundTripFee(pos.assetId, pos.amount);
    const pnl = +(pnlBruto - fee).toFixed(4);
    const icon = pnl >= 0 ? "✅" : "🛑";

    logger.info(`${icon} ${reason} ${pos.assetSym} | P&L ${sign(pnl)}${eur(pnl)}${fee > 0 ? ` (após €${fee.toFixed(2)} comissão)` : ""}`);

    const closedTs = Date.now();
    const closedTrade = {
      ...pos,
      status:    reason,
      closePrice,
      closedAt:  new Date().toLocaleString("pt-PT"),
      closedTs,
      fee,
      pnlBruto: +pnlBruto.toFixed(4),
      pnl,
    };

    // Remove posição + devolve saldo (líquido de comissões)
    delete openPositions[posId];
    totalInvested = Math.max(0, totalInvested - pos.amount);
    simBalance    = +(simBalance + pos.amount + pnl).toFixed(2);

    // Cooldown pós-perda: se fechámos a perder (SL), regista para impor uma
    // pausa MAIOR antes de reentrar neste ativo. Evita o "apanhar a faca a cair"
    // — reentrar repetidamente num ativo em queda livre (o padrão SOL/XRP).
    if (pnl < 0) lastLossTime[pos.assetId] = Date.now();

    // Guarda no Firestore
    await fb.updateTrade("server", posId, { status: reason, closePrice, pnl, fee, pnlBruto: closedTrade.pnlBruto, closedAt: closedTrade.closedAt, closedTs });
    await fb.saveBalance("server", simBalance);
    stats.addClosedTrade(closedTrade);
    dailyLossHit = stats.checkDailyLossLimit();

    // Log colorido para localizar vendas facilmente nos logs do Railway.
    const pct = pos.entryPrice ? ((closePrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
    const linha = `💰 VENDA [${reason}] ${pos.assetSym} | P&L ${pnl >= 0 ? "+" : ""}€${pnl.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) | $${pos.entryPrice} → $${closePrice}`;
    if (pnl >= 0) logger.win(linha); else logger.loss(linha);
    logEvent("sell", linha);

    await notify(tg.tradeClose(closedTrade, pnl, reason, broker.getMode()));
  }
}

// ── Sugestão de quantia a investir — perfil de risco + confiança + saldo ──────
// Espelha a lógica da app. Em sim usa o saldo da simulação; em paper/live usaria
// o saldo do broker (via broker.getBalance, mas mantemos simples e seguro aqui).
function suggestAmount(assetId, confianca, strategy, origem) {
  const avail = simBalance;
  if (!avail || avail <= 0) return strategy.perTrade || 10;

  // Valor e teto por ORIGEM (estrategias/aibrain/daytrading/manual). Se a origem
  // não tiver valor próprio (0/null), herda o global. Permite afinar cada motor.
  const po = (appSettings.perOrigem || {})[origem] || {};
  const valOrigem = Number(po.valorFixo) > 0 ? Number(po.valorFixo) : null;
  const tetoOrigem = Number(po.maxValorTrade) > 0 ? Number(po.maxValorTrade) : null;

  // Teto ABSOLUTO em € por trade: origem (se definido) senão global. 0/vazio = sem teto.
  const tetoCfg = tetoOrigem != null ? tetoOrigem : Number(appSettings.maxValorTrade);
  const tetoAbs = (Number.isFinite(tetoCfg) && tetoCfg > 0) ? tetoCfg : Infinity;

  // Modo "fixo": valor da origem > valor da estratégia > valorFixo global.
  if (appSettings.modoValor !== "percentagem") {
    const base = valOrigem != null ? valOrigem : (strategy.perTrade || appSettings.valorFixo || 10);
    return Math.min(base, avail, tetoAbs);
  }

  // Modo "% da Banca": dimensiona pelo perfil de risco + confiança + saldo.
  const PERFIL = {
    conservador: { teto: 0.10, base: 0.04 },
    scalper:     { teto: 0.12, base: 0.05 },
    moderado:    { teto: 0.20, base: 0.08 },
    equilibrado: { teto: 0.18, base: 0.07 },
    volatil:     { teto: 0.22, base: 0.09 },
    agressivo:   { teto: 0.33, base: 0.14 },
  };
  const cfg = PERFIL[appSettings.riscoPerfil] || PERFIL.moderado;
  const c = Math.max(0, Math.min(100, confianca || 0));
  const mult = c >= 90 ? 2.0 : c >= 80 ? 1.5 : c >= 70 ? 1.1 : c >= 60 ? 0.8 : 0.5;
  const pctBase = (appSettings.percentagem || 3) / 100;
  let amount = avail * pctBase * mult;
  amount = Math.min(amount, avail * cfg.teto);
  amount = Math.max(10, Math.min(amount, avail, tetoAbs)); // ← teto absoluto aplicado aqui
  return +amount.toFixed(2);
}

// ── Executar compra simulada ──────────────────────────────────────────────────
async function executeBuy(strategy, assetId, price, confianca) {
  // Travão de segurança: nunca abrir a um preço fantasma (base estático/stale).
  // Se o preço passado não é real e fresco, não abre — protege contra entradas
  // a valores irreais quando as fontes de preço falham.
  if (!prices.isReal(assetId)) {
    logger.warn(`Compra ${assetId} ignorada: sem preço real fresco (a evitar entrada a preço fantasma)`);
    return;
  }
  // Quantia: por perfil+confiança+saldo se modoInvestimento="auto", senão fixo.
  // Origem para sizing por-origem: manual vs estratégia (o AI-Brain chama
  // suggestAmount diretamente com "aibrain"; o day-trade tem o seu próprio fluxo).
  const origem = strategy.id === "manual" ? "manual" : "estrategias";
  const sized  = suggestAmount(assetId, confianca, strategy, origem);
  // sized já vem com o teto aplicado por suggestAmount; aqui só reforçamos se
  // houver teto configurado (0/vazio = sem teto).
  const tetoCfg2 = Number(appSettings.maxValorTrade);
  const amount = (Number.isFinite(tetoCfg2) && tetoCfg2 > 0) ? Math.min(sized, tetoCfg2) : sized;

  if (simBalance < amount) {
    logger.warn(`Saldo insuficiente: €${simBalance} < €${amount}`);
    return;
  }
  // Limite GLOBAL de posições abertas (todas as origens). Evita centenas de
  // posições quando o saldo de paper é enorme ($100k).
  const maxTotal = Number(appSettings.maxPosicoesTotal);
  if (Number.isFinite(maxTotal) && maxTotal > 0 && Object.keys(openPositions).length >= maxTotal) {
    logger.warn(`Limite global de ${maxTotal} posições abertas atingido — compra ignorada`);
    return;
  }
  if (totalInvested + amount > parseFloat(process.env.MAX_TOTAL_EUR || simCapital)) {
    logger.warn(`Limite total atingido`);
    return;
  }
  if (dailyLossHit) { logger.warn("Limite perda diária atingido — bloqueado"); return; }

  // Limite de posições de estratégia (só conta estratégias — AI-Brain, manual e
  // day-trade têm os seus próprios limites e não roubam vagas às estratégias).
  const maxStrat = appSettings.maxEstrategias || 5;
  const stratPositions = Object.values(openPositions).filter(
    p => p.stratId !== "manual" && p.stratId !== "daytrading" && p.stratId !== "ai-brain"
  );
  if (stratPositions.length >= maxStrat) {
    if (!appSettings.rotacaoAtiva) {
      // Limite cheio, rotação desligada → não compra
      return;
    }
    // ── ROTAÇÃO: vender a posição com mais lucro LÍQUIDO para abrir esta ──
    let bestWinner = null, bestNet = -Infinity, bestCur = 0, bestFee = 0;
    for (const pos of stratPositions) {
      const cur = prices.getFreshPrice(pos.assetId);
      if (!cur) continue; // sem preço real fresco → não avalia esta posição
      const fee = broker.roundTripFee(pos.assetId, pos.amount);
      const net = (cur - pos.entryPrice) * pos.units - fee;
      if (net > bestNet) { bestNet = net; bestWinner = pos; bestCur = cur; bestFee = fee; }
    }
    // Só roda se a melhor posição der um lucro LÍQUIDO MÍNIMO significativo.
    // Antes rodava com qualquer lucro > 0 (até +€0.01), causando um ciclo de
    // microtrading (abre/fecha/reabre sem parar = spam + comissões à toa).
    // Agora exige pelo menos ROT_MIN_PCT% do valor investido (defeito 1%).
    const rotMinPct = Number(appSettings.rotacaoMinPct ?? process.env.ROT_MIN_PCT ?? 1);
    const minGanho = bestWinner ? (bestWinner.amount * rotMinPct / 100) : 0;
    if (!bestWinner || bestNet < minGanho) {
      return; // nenhuma posição com lucro suficiente para justificar a rotação
    }
    // Fechar o vencedor (P&L líquido de comissões)
    const cur = bestCur;
    const bestPnl = +bestNet.toFixed(4);
    const bestBruto = +((bestCur - bestWinner.entryPrice) * bestWinner.units).toFixed(4);
    delete openPositions[bestWinner.id];
    totalInvested = Math.max(0, totalInvested - bestWinner.amount);
    simBalance = +(simBalance + bestWinner.amount + bestPnl).toFixed(2);
    const rotClosedTs = Date.now();
    await fb.updateTrade("server", bestWinner.id, { status: "ROTACAO", closePrice: cur, pnl: bestPnl, fee: bestFee, pnlBruto: bestBruto, closedAt: new Date().toLocaleString("pt-PT"), closedTs: rotClosedTs });
    await fb.saveBalance("server", simBalance);
    stats.addClosedTrade({ ...bestWinner, status: "ROTACAO", closePrice: cur, pnl: bestPnl, fee: bestFee, pnlBruto: bestBruto, closedTs: rotClosedTs });
    logger.win(`🔄 ROTAÇÃO: fechado ${bestWinner.assetSym} (líq. +€${bestPnl.toFixed(2)}${bestFee>0?`, após €${bestFee.toFixed(2)} comissão`:""}) para abrir ${assetId}`);
  }

  const units = +(amount / price).toFixed(7);
  // Ajuste por categoria: o SL/TP da estratégia é escalado pela volatilidade da
  // classe do ativo (ex.: crypto mais largo, forex mais apertado).
  const adj   = adjustedRisk(assetId, strategy.sl, strategy.tp, null);
  const dp    = assetId === "eurusd" || ASSET_CAT[assetId] === "Forex" ? 5 : 4;
  const sl    = +(price * (1 - adj.sl / 100)).toFixed(dp);
  const tp    = +(price * (1 + adj.tp / 100)).toFixed(dp);
  const posId = `${broker.isLive() ? "live" : "sim"}_${Date.now()}_${assetId}`;

  // Fix 3 (atomicidade): em LIVE, gravamos primeiro um registo PENDING no
  // Firestore ANTES de chamar a corretora. Se o bot crashar entre a ordem e a
  // gravação final, fica um rasto recuperável (PENDING) em vez de uma posição
  // real invisível. Em sim não é preciso (não há ordem externa a perder).
  if (broker.isLive()) {
    await fb.saveTrade("server", {
      id: posId, assetId, assetName: assetId, assetSym: assetId.toUpperCase(),
      entryPrice: price, units, amount, sl, tp,
      strategy: strategy.nome, stratId: strategy.id,
      openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(),
      status: "PENDING", mode: "live",
    }).catch(e => logger.warn(`Pré-registo PENDING falhou: ${e.message}`));
  }

  // ── Executar a ordem (real na Alpaca se MODE=paper/real; senão simulada) ──
  const exec = await broker.buy({ assetId, amount, price, sl, tp });
  if (!exec.ok) {
    logger.warn(`Compra ${assetId} não executada: ${exec.reason}`);
    // Limpar o registo PENDING que criámos (a ordem não foi aceite).
    if (broker.isLive()) await fb.updateTrade("server", posId, { status: "CANCELADA", closedTs: Date.now() }).catch(() => {});
    return;
  }
  // Fix 1/6: preço e unidades REAIS de execução. Se a corretora confirmou uma
  // quantidade preenchida, usamo-la; senão derivamos do fill price.
  const fillPrice = exec.fillPrice || price;
  const brokerFilled = (typeof exec.filledQty === "number" ? exec.filledQty
                      : typeof exec.filledUnits === "number" ? exec.filledUnits
                      : null);
  const realUnits = (typeof brokerFilled === "number" && brokerFilled > 0)
    ? brokerFilled
    : +(amount / fillPrice).toFixed(7);

  const position = {
    id:          posId,
    assetId,
    assetName:   assetId,
    assetSym:    assetId.toUpperCase(),
    entryPrice:  fillPrice,
    units:       realUnits,
    amount,
    peak:        fillPrice,
    sl, tp,
    strategy:    strategy.nome,
    stratId:     strategy.id,
    openedAt:    new Date().toLocaleString("pt-PT"), openedTs: Date.now(),
    status:      "ABERTA",
    mode:        broker.isLive() ? "live" : "sim",
    brokerOrderId: exec.brokerOrderId || null,
    broker:      exec.broker || null,
    brokerSymbol: exec.brokerSymbol || null,
    // Fix 5: se a corretora gere SL/TP nativamente (bracket em ações), o nosso
    // motor NÃO deve também fechar — senão disparam os dois (venda a descoberto).
    brokerSLTP:  !!exec.bracket,
    pendingFill: !!exec.pending, // fill provisório; reconciliação confirma depois
  };

  openPositions[posId] = position;
  totalInvested += amount;
  simBalance     = +(simBalance - amount).toFixed(2);

  // Guarda no Firestore — a app React vê em tempo real
  await fb.saveTrade("server", position);
  await fb.saveBalance("server", simBalance);
  queueOpen({ ...position, origemLabel: "🎯 Estratégias" }, broker.getMode());

  const _mBuy = `🛒 BUY ${assetId.toUpperCase()} | €${amount} @$${fillPrice} | SL $${sl} TP $${tp}`;
  logger.buy(_mBuy); logEvent("buy", _mBuy);
}

// ── Hooks usados pelo módulo de day trading ──────────────────────────────────
function countDayTrades() {
  return Object.values(openPositions).filter(p => p.stratId === "daytrading").length;
}
function hasOpen(assetId, stratId) {
  return Object.values(openPositions).some(p => p.assetId === assetId && p.stratId === stratId);
}
// Abre uma posição de day trading (já com SL/TP decididos pela IA). Devolve true se abriu.
async function openDayTrade({ assetId, assetName, assetSym, price, amount, sl, tp, previsao, confianca }) {
  if (dailyLossHit) return false;
  // Anti-duplicado: se já há um day-trade aberto neste ativo, não abrir outro.
  // (Evitava o spam de abrir o mesmo ativo a cada scan enquanto o sinal se mantém.)
  if (Object.values(openPositions).some(p => p.assetId === assetId && p.stratId === "daytrading")) return false;
  // Valor e teto por origem (day-trade). Valor fixo da origem (se definido)
  // sobrepõe o sugerido pela IA; teto da origem senão o global.
  const poDt = (appSettings.perOrigem || {}).daytrading || {};
  const valDt = Number(poDt.valorFixo) > 0 ? Number(poDt.valorFixo) : null;
  const tetoDtCfg = Number(poDt.maxValorTrade) > 0 ? Number(poDt.maxValorTrade) : Number(appSettings.maxValorTrade);
  let amt = valDt != null ? valDt : amount;
  if (Number.isFinite(tetoDtCfg) && tetoDtCfg > 0) amt = Math.min(amt, tetoDtCfg);
  if (simBalance < amt) return false;
  const maxTotDt = Number(appSettings.maxPosicoesTotal);
  if (Number.isFinite(maxTotDt) && maxTotDt > 0 && Object.keys(openPositions).length >= maxTotDt) {
    logger.warn(`Limite global de posições atingido — day-trade ${assetSym} ignorado`);
    return false;
  }
  if (totalInvested + amt > parseFloat(process.env.MAX_TOTAL_EUR || simCapital)) return false;

  const units = +(amt / price).toFixed(7);
  const posId = `daytrade_${Date.now()}_${assetId}`;
  const position = {
    id: posId, assetId, assetName, assetSym,
    entryPrice: price, units, amount: amt, peak: price, sl, tp,
    strategy: `⚡ DayTrade${confianca ? ` (${confianca}%)` : ""}${previsao ? ` — ${String(previsao).slice(0,40)}` : ""}`,
    stratId: "daytrading",
    openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(), status: "ABERTA", mode: "sim",
  };
  openPositions[posId] = position;
  totalInvested += amt;
  simBalance = +(simBalance - amt).toFixed(2);

  await fb.saveTrade("server", position);
  await fb.saveBalance("server", simBalance);
  queueOpen({ ...position, confianca, origemLabel: "⚡ Day Trading" }, broker.getMode());
  const _mDt = `⚡ DAYTRADE ${assetId.toUpperCase()} | €${amt} @$${price} | conf ${confianca}%`;
  logger.buy(_mDt); logEvent("buy", _mDt);
  return true;
}


const aiBrainCooldown = {}; // { assetId: ts }
async function runAiBrain(currentPrices) {
  if (!appSettings.aiBrain || dailyLossHit) return;
  const minConf  = appSettings.aiBrainConfianca || 78;
  const maxStrat = appSettings.maxEstrategias || 5;
  const slPct    = appSettings.stopLossPadrao || 6;
  const tpPct    = appSettings.takeProfitPadrao || 12;

  // Fonte de sinais: normalmente o Groq. Mas o Groq free-tier esgota e entra em
  // rate-limit — e era isso que deixava o AI-Brain (e o Day Trading) sem fazer
  // NADA, só sobrando as estratégias. FALLBACK: quando o Groq está indisponível,
  // o AI-Brain age por INDICADORES TÉCNICOS locais (o mesmo motor das estratégias).
  // Assim continua a operar sem depender de uma API instável.
  let sigs = aiSignals.getSignals();
  const groqHealth = aiSignals.getGroqHealth();
  const usingFallback = !groqHealth.ok || !sigs || Object.keys(sigs).length === 0;
  if (usingFallback) {
    sigs = {};
    for (const id of TRADEABLE) {
      const pd = currentPrices[id];
      if (!pd?.price) continue;
      const daily = dailySeries[id] || [];
      if (daily.length < 15) continue; // sem histórico não há sinal técnico fiável
      const serie = [...daily.slice(-89), pd.price];
      const tech = indicators.buySignal(serie, { dropTrigger: 1.5, rsiOversold: 35, smaLong: 50 });
      if (tech.buy) {
        // Converte o "score" técnico (0-100) em confiança equivalente do AI-Brain.
        sigs[id] = { id, sinal: "COMPRAR", confianca: tech.score, razao: `técnico: ${tech.reason}`, ts: Date.now(), _fallback: true };
      }
    }
    if (Object.keys(sigs).length && tickCount % 10 === 0) {
      logger.info(`🤖 AI-Brain em FALLBACK técnico (Groq ${groqHealth.rateLimited ? "rate-limited" : "indisponível"}): ${Object.keys(sigs).length} sinal(is)`);
    }
  }

  for (const sg of Object.values(sigs)) {
    if (!sg || sg.sinal !== "COMPRAR" || (sg.confianca || 0) < minConf) continue;
    // Limite global de posições abertas (0/vazio = sem limite)
    const maxTotAi = Number(appSettings.maxPosicoesTotal);
    if (Number.isFinite(maxTotAi) && maxTotAi > 0 && Object.keys(openPositions).length >= maxTotAi) break;
    if (!TRADEABLE.has(sg.id)) continue;
    // Não abrir em mercado fechado (evita flip-flop a preços congelados)
    if (!isMarketOpenFor(sg.id)) continue;
    const pd = currentPrices[sg.id];
    if (!pd?.price) continue;
    // Nunca abrir uma posição a um preço fantasma (base/stale): sem preço real
    // fresco, salta este ativo neste tick.
    if (!prices.isReal(sg.id)) continue;

    // ── Travão de sanidade: o Groq pode inflacionar confiança (diz 100% em
    //    ativos parados). Só entra se os INDICADORES TÉCNICOS também concordarem.
    //    Assim o AI Brain combina o "raciocínio" do LLM com dados objetivos. ──
    //    (Salta-se no fallback: o sinal JÁ é técnico, não precisa de re-confirmar.)
    if (!sg._fallback) {
      const daily = dailySeries[sg.id] || [];
      if (daily.length >= 15) {
        const serie = [...daily.slice(-89), pd.price];
        const tech = indicators.buySignal(serie, { dropTrigger: 1.0, rsiOversold: 45, smaLong: 50 });
        if (!tech.buy) {
          // Groq diz comprar mas os indicadores não confirmam → ignora (evita falsos sinais)
          continue;
        }
      }
      // (se não há histórico suficiente, confia só no Groq)
    }

    // cooldown 5 min por ativo
    if (Date.now() - (aiBrainCooldown[sg.id] || 0) < 5 * 60 * 1000) continue;
    // cooldown pós-perda (mais longo após um SL neste ativo)
    const aiLossCdMs = (parseInt(process.env.POSTLOSS_COOLDOWN_MIN || "30", 10)) * 60000;
    if (Date.now() - (lastLossTime[sg.id] || 0) < aiLossCdMs) continue;
    // não duplicar posição AI no mesmo ativo
    if (Object.values(openPositions).some(p => p.assetId === sg.id && p.stratId === "ai-brain")) continue;
    // limites — o Cérebro AI tem o SEU PRÓPRIO limite, separado das estratégias.
    // Antes partilhavam maxEstrategias: as estratégias (que correm primeiro no
    // tick) enchiam as vagas e o AI-Brain nunca abria. Agora conta só as suas.
    const brainPositions = Object.values(openPositions).filter(p => p.stratId === "ai-brain");
    const maxBrain = Number(appSettings.maxAiBrain) || 3;
    if (brainPositions.length >= maxBrain) continue;
    // Quantia por perfil+confiança+saldo (igual à app); fixo se modo != auto.
    const perTrade = Math.min(
      suggestAmount(sg.id, sg.confianca, { perTrade: appSettings.valorFixo || 100 }, "aibrain"),
      parseFloat(process.env.MAX_POSITION_EUR || "500")
    );
    if (simBalance < perTrade) continue;
    if (totalInvested + perTrade > parseFloat(process.env.MAX_TOTAL_EUR || simCapital)) continue;

    const price = pd.price;
    const units = +(perTrade / price).toFixed(7);
    const adjB  = adjustedRisk(sg.id, slPct, tpPct, null);
    const sl    = +(price * (1 - adjB.sl / 100)).toFixed(sg.id === "eurusd" ? 5 : 4);
    const tp    = +(price * (1 + adjB.tp / 100)).toFixed(sg.id === "eurusd" ? 5 : 4);
    const posId = `aibrain_${Date.now()}_${sg.id}`;
    // Distinguir a origem do sinal: Groq (LLM) vs fallback técnico (indicadores).
    // Útil para perceberes no histórico o que cada modo está a fazer.
    const viaTecnico = !!sg._fallback;
    const position = {
      id: posId, assetId: sg.id, assetName: sg.id, assetSym: sg.id.toUpperCase(),
      entryPrice: price, units, amount: perTrade, peak: price, sl, tp,
      strategy: viaTecnico ? `🧮 AI Técnico (${sg.confianca}%)` : `🤖 AI Brain (${sg.confianca}%)`,
      stratId: "ai-brain",
      aiSource: viaTecnico ? "tecnico" : "groq", // origem do sinal (para a app filtrar/etiquetar)
      openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(), status: "ABERTA", mode: "sim",
    };
    openPositions[posId] = position;
    totalInvested += perTrade;
    simBalance = +(simBalance - perTrade).toFixed(2);
    aiBrainCooldown[sg.id] = Date.now();

    await fb.saveTrade("server", position);
    await fb.saveBalance("server", simBalance);
    queueOpen({ ...position, confianca: sg.confianca, origemLabel: viaTecnico ? "🧮 AI Técnico" : "🤖 AI Brain" }, broker.getMode());
    const _mAi = `${viaTecnico ? "🧮 AI TÉCNICO" : "🤖 AI BRAIN"} ${sg.id.toUpperCase()} | €${perTrade} @$${price} | ${sg.confianca}%`;
    logger.buy(_mAi); logEvent("buy", _mAi);
  }
}

// ── Tick principal ────────────────────────────────────────────────────────────
async function tick() {
  try {
    tickCount++;
    // Rollover robusto: arquiva o dia anterior assim que o dia muda, mesmo que
    // o cron da meia-noite tenha falhado (bot em baixo nesse minuto). Barato.
    fb.checkDayRollover().then(r => {
      if (r && r.length) notify(`📁 *Arquivo automático*: ${r.length} dia(s) arquivado(s).`).catch(() => {});
    }).catch(() => {});
    // 1. Refresh preços
    await prices.refreshAll();
    const currentPrices = prices.getAll();

    // Atualizar histórico diário 1x/dia (a cada ~2880 ticks de 30s) para os indicadores
    if (tickCount % 2880 === 0) {
      prices.fetchHistory().then(h => {
        if (Object.keys(h).length) { dailySeries = h; logger.info("📈 Histórico diário atualizado"); }
      }).catch(() => {});
    }

    // Atualizar sinais AI (intervalo configurável) e persistir para a app os mostrar
    const sigsBefore = JSON.stringify(aiSignals.getSignals());
    await aiSignals.refresh();
    const sigsAfter = aiSignals.getSignals();
    if (JSON.stringify(sigsAfter) !== sigsBefore && Object.keys(sigsAfter).length) {
      fb.saveSetting("server", "marketSignals", sigsAfter).catch(() => {});
    }

    // Registar histórico
    Object.entries(currentPrices).forEach(([id, d]) => {
      if (d?.price) recordPrice(id, d.price);
    });

    // 2. Verificar SL/TP
    await checkSLTP(currentPrices);

    // 2b. Processar comandos manuais da app (compra/venda pedida pelo utilizador)
    await processCommands(currentPrices);

    // ── PAUSA: quando o bot está pausado (toggle na app, útil em deploys), NÃO
    // abre novas posições — mas continua a proteger as abertas (SL/TP acima já
    // correu) e a processar vendas/comandos. Pausar nunca desativa a proteção.
    if (botPaused) {
      if (tickCount % 10 === 0) logger.info("⏸ Bot PAUSADO — só gestão de posições abertas (SL/TP/vendas). Sem novas entradas.");
    } else {

    // 3. Verificar sinais das estratégias
    if (!dailyLossHit) {
      for (const strategy of strategies) {
        if (!strategy.ativo) continue;
        for (const assetId of (strategy.ativos || [])) {
          const priceData = currentPrices[assetId];
          if (!priceData?.price) continue;
          // Não comprar em mercado fechado (preços congelados → sinais falsos)
          if (!isMarketOpenFor(assetId)) continue;

          // Cooldown de re-entrada: não voltar ao mesmo ativo/estratégia durante
          // X min. Evita o vai-e-vem de trades de <1min que não chegam a valorizar
          // e o martelar de um ativo que a corretora rejeita. Configurável por env.
          const cdKey = `${strategy.id}_${assetId}`;
          const cooldownMs = (parseInt(process.env.REENTRY_COOLDOWN_MIN || "10", 10)) * 60000;
          const lastBuy = lastBuyTime[cdKey] || 0;
          if (Date.now() - lastBuy < cooldownMs) continue;
          // Cooldown pós-perda (mais longo): após um SL neste ativo, espera mais
          // antes de reentrar. Default = 3x o cooldown normal. Configurável.
          const lossCdMs = (parseInt(process.env.POSTLOSS_COOLDOWN_MIN || "30", 10)) * 60000;
          if (Date.now() - (lastLossTime[assetId] || 0) < lossCdMs) continue;

          // ── Sinal realista: combina histórico diário (RSI + média móvel)
          //    com a queda intradiária recente. Precisa de ≥2 critérios. ──
          // Série = histórico diário + o preço de hoje no fim (para refletir o agora)
          const daily = dailySeries[assetId] || [];
          const serie = daily.length ? [...daily.slice(-89), priceData.price] : [];

          // Queda de compra ajustada à volatilidade da categoria do ativo
          // (crypto exige queda maior para entrar; forex menor).
          const dropAdj = adjustedRisk(assetId, 1, 1, strategy.compra).drop;

          let sinal;
          if (serie.length >= 15) {
            // Temos histórico real → usa indicadores técnicos
            sinal = indicators.buySignal(serie, {
              dropTrigger: dropAdj,                   // gatilho de queda ajustado por categoria
              rsiOversold: strategy.risco === "alto" ? 45 : strategy.risco === "baixo" ? 30 : 38,
              smaLong:     50,
            });
          } else {
            // Fallback: ainda sem histórico → usa só a queda intradiária (como antes)
            const high = getRecentHigh(assetId);
            const dropPct = high ? ((high - priceData.price) / high) * 100 : 0;
            sinal = { buy: dropPct >= dropAdj, score: 60, reason: `queda ${dropPct.toFixed(1)}% (sem histórico)` };
          }

          if (sinal.buy) {
            logger.info(`🎯 Sinal: ${strategy.nome} → ${assetId} | ${sinal.reason} (força ${sinal.score})`);
            // Marca o cooldown ANTES de tentar — assim, mesmo que a ordem seja
            // rejeitada pela corretora ou feche logo, não voltamos a martelar o
            // mesmo ativo no ciclo seguinte (era a causa das dezenas de trades
            // ADA <1min). A trava vale para tentativa, não só para sucesso.
            lastBuyTime[cdKey] = Date.now();
            const aiSig = aiSignals.getSignal(assetId);
            const conf  = Math.max(sinal.score || 0, aiSig?.confianca || 0);
            await executeBuy(strategy, assetId, priceData.price, conf);
          }
        }
      }
    }

    // 3c. Cérebro AI autónomo — entra com base nos sinais de alta confiança
    await runAiBrain(currentPrices);

    // 3d. Day Trading 24/7 — scan com IA e abre posições rápidas (config vinda da app)
    await dayTrading.run(dtConfig, appSettings.maxDayTrading || 5, {
      openDayTrade, countDayTrades, hasOpen,
    }).catch(err => logger.warn(`DayTrading run: ${err.message}`));

    } // fim do gate de pausa (botPaused)

    // 3b. Log de diagnóstico (a cada 10 ticks) — mostra estado dos sinais
    if (tickCount % 10 === 0 && strategies.length > 0) {
      const diags = [];
      for (const strategy of strategies) {
        if (!strategy.ativo) continue;
        for (const assetId of (strategy.ativos || [])) {
          const pd = currentPrices[assetId];
          const high = getRecentHigh(assetId);
          if (pd?.price && high) {
            const drop = ((high - pd.price) / high) * 100;
            diags.push(`${assetId}: queda ${drop.toFixed(2)}%/${strategy.compra}%`);
          }
        }
      }
      const open = Object.keys(openPositions).length;
      logger.info(`📊 Estado: ${open} posições abertas | ${diags.join(" · ") || "a recolher preços"}`);
    }

    // 4. Atualizar P&L não realizado no Firestore — só quando muda ou 1x/min
    const unrealized = Object.values(openPositions).reduce((s, pos) => {
      const p = currentPrices[pos.assetId]?.price;
      return s + (p ? (p - pos.entryPrice) * pos.units : 0);
    }, 0);
    const simLive = {
      balance:       simBalance,
      unrealized:    +unrealized.toFixed(2),
      totalInvested: +totalInvested.toFixed(2),
      openPositions: Object.keys(openPositions).length,
    };
    // Compara por valores arredondados: pequenas oscilações de preço não forçam
    // escrita; só muda de estado real (nova posição, saldo, P&L ao euro) escreve
    // já. Caso contrário, escreve no máximo 1x por minuto.
    const simLiveJson = JSON.stringify({
      b: simLive.balance,
      u: Math.round(simLive.unrealized),
      i: Math.round(simLive.totalInvested),
      o: simLive.openPositions,
    });
    const now = Date.now();
    if (simLiveJson !== lastSimLiveJson || now - lastSimLiveAt >= SIMLIVE_MIN_MS) {
      await fb.saveSetting("server", "simLive", {
        ...simLive,
        lastTick: new Date().toISOString(),
      });
      lastSimLiveJson = simLiveJson;
      lastSimLiveAt   = now;
    }

    // 4b. Publica PREÇOS no Firestore (a cada 2 min) para a app os ler em vez de
    //     bater nas APIs ela própria — elimina chamadas duplicadas app↔bot.
    if (now - lastPricesAt >= PRICES_PUB_MS) {
      const all = prices.getAll();
      const slim = {};
      for (const a of prices.ASSETS) {
        const d = all[a.id];
        if (d?.price) slim[a.id] = { price: d.price, change: d.change ?? 0 };
      }
      // Otimização Firestore: só publica se os preços MUDARAM desde a última
      // publicação. Em mercado parado (noite/fim de semana) evita reescritas
      // inúteis — poupa escritas no free tier sem afetar a app (lê o último valor).
      const slimJson = JSON.stringify(slim);
      if (slimJson !== lastPricesJson) {
        await fb.saveSetting("server", "marketPrices", { prices: slim, ts: now }).catch(() => {});
        lastPricesJson = slimJson;
      }
      lastPricesAt = now;
    }

    // 5. Heartbeat — a app usa para saber que o bot está vivo (exige < 3 min).
    //    Escreve a cada 2 min, ou imediatamente se as features mudarem.
    const features = {
      aiBrain:      !!appSettings.aiBrain,
      trailingStop: !!appSettings.trailingStop,
      aiExitOnFlip: appSettings.aiExitOnFlip !== false,
      // AI-Brain a operar por indicadores técnicos porque o Groq está em baixo.
      aiBrainFallback: !!appSettings.aiBrain && !aiSignals.getGroqHealth().ok,
      scaleOutTP:   !!appSettings.scaleOutTP,
      paused:       botPaused,
    };
    const featuresJson = JSON.stringify(features);
    if (featuresJson !== lastFeaturesJson || now - lastHeartbeatAt >= HEARTBEAT_MS) {
      // Estado de saúde das APIs (para o health check na app)
      const ph = prices.getSourceHealth();
      const gh = aiSignals.getGroqHealth();
      const apiHealth = {
        groq:       { ok: gh.ok, rateLimited: gh.rateLimited, untilMs: gh.untilMs },
        binance:    { ok: ph.binance?.ok,    lastOk: ph.binance?.lastOk,    err: ph.binance?.lastErr },
        coingecko:  { ok: ph.coingecko.ok,   lastOk: ph.coingecko.lastOk,   err: ph.coingecko.lastErr },
        twelvedata: { ok: ph.twelvedata?.ok, lastOk: ph.twelvedata?.lastOk, err: ph.twelvedata?.lastErr, exhausted: !!ph.twelvedata?.exhausted },
        finnhub:    { ok: ph.finnhub?.ok,    lastOk: ph.finnhub?.lastOk,    err: ph.finnhub?.lastErr, disabled: !!ph.finnhub?.disabled },
        stooq:      { ok: ph.stooq.ok,       lastOk: ph.stooq.lastOk,       err: ph.stooq.lastErr, disabled: !!ph.stooq?.disabled },
      };
      await fb.saveSetting("server", "botStatus", {
        alive:    true,
        mode:     broker.getMode(),
        lastSeen: now,
        features,
        apiHealth,
      });
      lastHeartbeatAt  = now;
      lastFeaturesJson = featuresJson;

      // ── Saldos por broker (só em paper/real) → a app mostra-os no Portfólio ──
      if (broker.isLive() && broker.registry) {
        try {
          const balances = {};
          for (const a of broker.registry.available()) {
            try { const b = await a.getBalance(); if (b != null) balances[a.id] = +(+b).toFixed(2); }
            catch (e) { logger.warn(`Saldo ${a.id} falhou: ${e.message}`); }
          }
          if (Object.keys(balances).length) {
            await fb.saveSetting("server", "brokerBalances", balances);
          }
        } catch (e) { logger.warn(`brokerBalances não publicado: ${e.message}`); }
      }
    }

  } catch (err) {
    logger.error(`SimEngine tick erro: ${err.message}`);
    logEvent("error", `Erro no motor: ${err.message}`);
    await fb.logError("sim-engine-tick", err).catch(() => {});
  }
}

// ── Inicializar ───────────────────────────────────────────────────────────────
async function init() {
  logger.info("═══════════════════════════════════");
  logger.info("  TradeAI Sim Engine 24/7");
  logger.info(`  Modo: ${broker.getMode().toUpperCase()}`);
  logger.info(`  Capital: €${simCapital}`);
  logger.info("═══════════════════════════════════");

  stats.setBalance(simBalance);

  // ── Verificar a corretora (em modo paper/real) ──
  try {
    await broker.verifyConnection();
    if (broker.isReal()) {
      logger.warn("💵💵💵 ATENÇÃO: MODO REAL ATIVO — as ordens usam DINHEIRO REAL 💵💵💵");
      await notify("💵 *TradeAI em MODO REAL* — ordens com dinheiro real ativas.").catch(() => {});
    }
    // Em live, o saldo de referência vem da conta real
    const realBal = await broker.getBalance();
    if (realBal != null && realBal > 0) {
      simBalance = +realBal.toFixed(2);
      simCapital = simBalance;
      stats.setBalance(simBalance);
      logger.info(`Saldo da corretora: €${simBalance}`);
    }
  } catch (e) {
    logger.error(`Corretora indisponível: ${e.message}`);
    if (broker.isLive()) {
      // Em modo live, não arranca às cegas sem corretora
      throw new Error(`Não foi possível ligar à corretora em modo ${broker.getMode()}: ${e.message}`);
    }
  }

  // Carregar saldo guardado — APENAS em simulação. Em paper/real, o saldo de
  // referência é o da corretora (já lido acima); o saldo do Firestore não pode
  // sobrepor-se, senão o sizing por % usa um valor errado (era o "Saldo
  // restaurado €92410" a tapar o cash real da Alpaca).
  if (!broker.isLive()) {
    const savedBal = await fb.getBalance("server");
    if (savedBal && savedBal > 0) {
      simBalance = savedBal;
      simCapital = savedBal; // considera o atual como base se já havia
      stats.setBalance(simBalance);
      logger.info(`Saldo restaurado (sim): €${simBalance}`);
    }
  } else {
    logger.info(`Saldo de referência (corretora): €${simBalance}`);
  }

  // Recuperar posições abertas do Firestore (sobrevive a restarts/deploys)
  let recuperadas = 0;
  try {
    const abertas = await fb.loadOpenPositions("server");
    abertas.forEach(p => { openPositions[p.id] = p; });
    recuperadas = abertas.length;
    if (abertas.length) {
      logger.info(`♻ ${abertas.length} posições abertas recuperadas do Firestore`);
    } else {
      logger.info("Nenhuma posição aberta para recuperar");
    }
  } catch (e) {
    logger.error(`Falha a recuperar posições abertas: ${e.message}`);
  }

  // ── Fix 4: RECONCILIAÇÃO com a corretora (só em live) ───────────────────────
  // Compara o que o bot julga ter (Firestore) com o que a corretora REALMENTE
  // tem. Apanha divergências criadas por crashes a meio de uma ordem, brackets
  // que fecharam sozinhos, ou posições abertas fora do bot.
  if (broker.isLive()) {
    try {
      const reais = await broker.getPositions(); // [{ broker, symbol, qty, avgPrice }]
      if (reais) {
        const norm = s => String(s || "").toUpperCase().replace("/", "");
        const realBySym = new Map();
        reais.forEach(p => realBySym.set(norm(p.symbol), p));

        const avisos = [];
        // (a) Posições que o bot acha abertas mas a corretora já NÃO tem →
        //     foram fechadas fora do bot (ex.: bracket disparou). Marcar fechadas.
        for (const [id, pos] of Object.entries(openPositions)) {
          if (pos.mode !== "live") continue;
          const sym = norm(pos.brokerSymbol || pos.assetSym || pos.assetId);
          if (!realBySym.has(sym)) {
            avisos.push(`• ${pos.assetSym}: o bot tinha-a aberta mas a corretora já não a tem → marcada FECHADA-RECON`);
            await fb.updateTrade("server", id, { status: "FECHADA-RECON", closedAt: new Date().toLocaleString("pt-PT"), closedTs: Date.now() }).catch(() => {});
            delete openPositions[id];
          }
        }
        // (b) Posições reais na corretora que o bot NÃO conhece → órfãs do lado
        //     da corretora (ex.: crash entre ordem e gravação). Só avisamos —
        //     não inventamos uma posição com entrada/SL/TP que não sabemos.
        const conhecidas = new Set(Object.values(openPositions)
          .filter(p => p.mode === "live")
          .map(p => norm(p.brokerSymbol || p.assetSym || p.assetId)));
        for (const [sym, rp] of realBySym.entries()) {
          if (!conhecidas.has(sym)) {
            avisos.push(`• ${rp.symbol} (${rp.qty} @ $${rp.avgPrice}): existe na corretora mas o bot não a conhece → REQUER ATENÇÃO MANUAL (sem SL/TP gerido)`);
          }
        }

        if (avisos.length) {
          const msg = `⚠ *Reconciliação com a corretora* encontrou divergências:\n${avisos.join("\n")}`;
          logger.warn(msg.replace(/\*/g, ""));
          await notify(msg).catch(() => {});
        } else {
          logger.info("✓ Reconciliação com a corretora: tudo alinhado");
        }
      } else {
        logger.warn("Reconciliação: a corretora não devolveu posições (a saltar)");
      }
    } catch (e) {
      logger.error(`Reconciliação com a corretora falhou: ${e.message}`);
    }
  }

  // Vigiar trades abertos em tempo real — apanha compras MANUAIS feitas na app
  // (sem isto, o bot só as geria após um restart). Funde sem duplicar nem
  // sobrescrever as posições que o próprio bot já tem em memória.
  fb.watchOpenTrades(abertas => {
    const idsFirestore = new Set(abertas.map(p => p.id));
    abertas.forEach(p => {
      if (!openPositions[p.id]) {
        openPositions[p.id] = p; // nova posição (ex.: compra manual da app)
        logger.info(`➕ Posição externa detetada: ${p.assetSym || p.assetId} (${p.stratId || "?"})`);
      } else if (openPositions[p.id].hold !== p.hold) {
        // Sincronizar o flag 'hold' quando o utilizador o liga/desliga na app
        openPositions[p.id].hold = p.hold;
        logger.info(`${p.hold ? "🔒 HOLD ligado" : "🔓 HOLD desligado"}: ${p.assetSym || p.assetId}`);
        // Coerência do Hold: se a posição tem bracket nativo (ação/ETF) e o
        // utilizador LIGOU o Hold, a Alpaca fecharia na mesma quando o SL/TP
        // batesse (o Hold seria ignorado). Para o Hold ser coerente em todos os
        // ativos, cancelamos o bracket na corretora e passamos a gerir o SL/TP
        // pelo motor (que respeita o Hold: bloqueia TP/AI-EXIT, mantém o SL).
        if (p.hold === true && openPositions[p.id].brokerSLTP === true) {
          broker.cancelBracket(openPositions[p.id].assetId, openPositions[p.id].broker)
            .then(r => {
              if (r && r.ok && !r.nada) {
                openPositions[p.id].brokerSLTP = false; // motor assume o SL/TP
                logEvent("warn", `Hold em ${p.assetSym || p.assetId}: bracket cancelado na corretora, SL/TP agora geridos pelo bot`);
              }
            })
            .catch(() => {});
        }
      }
    });
    // Remover do estado as posições que já não estão abertas no Firestore
    // (ex.: fechadas manualmente na app), exceto as que o bot está a fechar agora.
    Object.keys(openPositions).forEach(id => {
      if (!idsFirestore.has(id) && openPositions[id]?.status === "ABERTA") {
        delete openPositions[id];
      }
    });
  });

  // Subscrever estratégias em tempo real
  fb.watchStrategies(newStrats => {
    strategies = newStrats;
    logger.info(`Estratégias: ${strategies.map(s => s.nome).join(", ") || "nenhuma"}`);
  });

  // Subscrever definições da app conforme o MODO do bot:
  //   sim   → settings/settings
  //   paper → settings/paperSettings  (fallback: liveSettings → settings)
  //   real  → settings/realSettings   (fallback: liveSettings → settings)
  // Assim cada modo tem o seu próprio conjunto de limites/risco, e o real nunca
  // herda acidentalmente definições agressivas de simulação.
  const MODE_NOW = broker.getMode();
  const SETTINGS_DOC = MODE_NOW === "real" ? "realSettings"
                     : MODE_NOW === "paper" ? "paperSettings"
                     : "settings";
  let settingsBaseLoaded = false; // trava o fallback assim que chega o doc específico
  const applySettings = (val) => {
    if (!val || typeof val !== "object") return;
    appSettings = {
      maxEstrategias:   val.maxEstrategias ?? 5,
      maxManuais:       val.maxManuais ?? 5,
      maxAiBrain:       val.maxAiBrain ?? 3,
      rotacaoAtiva:     val.rotacaoAtiva ?? false,
      rotacaoMinPct:    val.rotacaoMinPct ?? 1,
      aiBrain:          val.aiBrain ?? false,
      aiBrainConfianca: val.aiBrainConfianca ?? 78,
      trailingStop:     val.trailingStop ?? false,
      trailingStopPct:  val.trailingStopPct ?? 4,
      aiExitOnFlip:     val.aiExitOnFlip ?? true,
      stopLossPadrao:   val.stopLossPadrao ?? 6,
      takeProfitPadrao: val.takeProfitPadrao ?? 12,
      valorFixo:        val.valorFixo ?? 100,
      riscoPerfil:      (val.riscoPerfil || "moderado").toLowerCase(),
      modoValor:        val.modoValor || "fixo", // "fixo" | "percentagem"
      percentagem:      val.percentagem ?? 3,
      maxDayTrading:    val.maxDayTrading ?? 5,
      maxValorTrade:    val.maxValorTrade ?? 100,
      maxPosicoesTotal: val.maxPosicoesTotal ?? 40,
      aiSignalsMin:     val.aiSignalsMin ?? 15,
      scaleOutTP:       val.scaleOutTP ?? false,   // TP parcial (vende fração, deixa correr)
      scaleOutPct:      val.scaleOutPct ?? 50,     // % a vender no TP parcial
      catAjuste:        (val.catAjuste && typeof val.catAjuste === "object") ? val.catAjuste : appSettings.catAjuste,
      perOrigem:        (val.perOrigem && typeof val.perOrigem === "object") ? val.perOrigem : appSettings.perOrigem,
    };
    aiSignals.setRefreshMinutes(appSettings.aiSignalsMin);
    logger.info(`Definições [${SETTINGS_DOC}]: máx ${appSettings.maxEstrategias} | rotação ${appSettings.rotacaoAtiva ? "ON" : "OFF"} | AI Brain ${appSettings.aiBrain ? `ON@${appSettings.aiBrainConfianca}%` : "OFF"} | Trailing ${appSettings.trailingStop ? `ON@${appSettings.trailingStopPct}%` : "OFF"} | teto €${appSettings.maxValorTrade} | Sinais ${appSettings.aiSignalsMin}min`);
  };
  fb.watchSetting(SETTINGS_DOC, (val) => {
    if (val && typeof val === "object") { settingsBaseLoaded = true; applySettings(val); }
  });
  // Fallback de migração: enquanto o doc específico não existir, em paper/real
  // usamos o antigo "liveSettings"; em qualquer modo, "settings" como último recurso.
  if (SETTINGS_DOC !== "settings") {
    fb.watchSetting("liveSettings", (val) => { if (!settingsBaseLoaded && val) applySettings(val); });
  }

  // Subscrever controlo de pausa do bot (toggle na app). Pausar impede novas
  // entradas mas mantém SL/TP e vendas — seguro para usar antes de um deploy.
  fb.watchSetting("botControl", (val) => {
    if (val && typeof val === "object") {
      const next = !!val.paused;
      if (next !== botPaused) {
        botPaused = next;
        logger.info(`Bot ${botPaused ? "PAUSADO ⏸ (sem novas entradas)" : "RETOMADO ▶ (entradas ativas)"}`);
        notify(botPaused ? "⏸ *Bot pausado* — sem novas entradas. SL/TP continuam ativos." : "▶ *Bot retomado* — entradas ativas.").catch(() => {});
      }
    }
  });

  // Subscrever config de Day Trading (escrita pela app em settings/dtState)
  let lastDtLogged = null; // só loga quando a config relevante muda (evita spam)
  fb.watchSetting("dtState", (val) => {
    if (val && typeof val === "object") {
      dtConfig = {
        active:       !!val.active,
        profitTarget: val.profitTarget ?? 6,
        maxLoss:      val.maxLoss ?? 3,
        amount:       val.amount ?? 100,
        minConf:      val.minConf ?? 75,
        assets:       Array.isArray(val.assets) ? val.assets : [],
        dailyPnl:     val.dailyPnl ?? 0,
      };
      // Assinatura só dos campos de config (ignora dailyPnl/trades, que mudam
      // a toda a hora e re-disparavam este listener a cada 2s).
      const sig = JSON.stringify({
        a: dtConfig.active, p: dtConfig.profitTarget, m: dtConfig.maxLoss,
        amt: dtConfig.amount, c: dtConfig.minConf, as: dtConfig.assets,
      });
      if (sig !== lastDtLogged) {
        lastDtLogged = sig;
        logger.info(`Day Trading: ${dtConfig.active ? `ON · alvo ${dtConfig.profitTarget}% · SL ${dtConfig.maxLoss}% · €${dtConfig.amount} · conf ${dtConfig.minConf}%` : "OFF"}`);
      }
    }
  });

  // Aguardar carga inicial
  await new Promise(r => setTimeout(r, 2000));

  // Primeiro fetch de preços
  await prices.refreshAll();
  logger.info("Preços inicializados ✓");

  // Publicar a lista de ativos negociáveis para a app (sync app↔bot)
  try {
    const lista = prices.ASSETS.map(a => ({
      id: a.id, sym: a.sym, name: a.name, icon: a.icon, cat: a.cat,
    }));
    await fb.publishTradeableAssets(lista);
    logger.info(`📡 ${lista.length} ativos negociáveis publicados para a app`);
  } catch (e) {
    logger.warn(`Falha a publicar ativos: ${e.message}`);
  }

  // Carregar histórico diário para os indicadores (RSI, médias móveis)
  try {
    dailySeries = await prices.fetchHistory();
    const n = Object.keys(dailySeries).length;
    logger.info(`📈 Histórico carregado para ${n} ativos (indicadores prontos)`);
  } catch (e) {
    logger.warn(`Histórico indisponível: ${e.message} — indicadores acumulam ao vivo`);
  }

  // Loop principal
  const TICK_MS = parseInt(process.env.SIM_TICK_MS || "30000"); // 30s por defeito
  setInterval(tick, TICK_MS);
  logger.info(`Motor iniciado — tick cada ${TICK_MS / 1000}s ✓`);

  // Primeiro tick imediato
  await tick();

  return {
    mode:        broker.getMode(),
    balance:     simBalance,
    recovered:   recuperadas,
    tickSeconds: TICK_MS / 1000,
  };
}

// ── Fechar uma posição específica a pedido do utilizador (via comando) ────────
async function closePositionManual(posId, currentPrices) {
  const pos = openPositions[posId];
  if (!pos) return { ok: false, reason: "posição não encontrada (já fechada?)" };
  let closePrice = prices.isReal(pos.assetId) ? (currentPrices?.[pos.assetId]?.price || prices.getFreshPrice(pos.assetId)) : null;
  if (!closePrice) return { ok: false, reason: "sem preço real fresco — tenta daqui a pouco" };

  if (broker.isLive()) {
    const exec = await broker.sell({ assetId: pos.assetId, units: pos.units, price: closePrice, broker: pos.broker, hadBracket: !!pos.brokerSLTP });
    if (!exec.ok) return { ok: false, reason: `corretora recusou: ${exec.reason}` };
    if (typeof exec.fillPrice === "number" && exec.fillPrice > 0) closePrice = exec.fillPrice;
  }
  const pnlBruto = (closePrice - pos.entryPrice) * pos.units;
  const fee = broker.roundTripFee(pos.assetId, pos.amount);
  const pnl = +(pnlBruto - fee).toFixed(4);
  const closedTs = Date.now();
  const closedTrade = { ...pos, status: "MANUAL", closePrice, closedAt: new Date().toLocaleString("pt-PT"), closedTs, fee, pnlBruto: +pnlBruto.toFixed(4), pnl };
  delete openPositions[posId];
  totalInvested = Math.max(0, totalInvested - pos.amount);
  simBalance = +(simBalance + pos.amount + pnl).toFixed(2);
  await fb.updateTrade("server", posId, { status: "MANUAL", closePrice, pnl, fee, pnlBruto: closedTrade.pnlBruto, closedAt: closedTrade.closedAt, closedTs });
  await fb.saveBalance("server", simBalance);
  stats.addClosedTrade(closedTrade);
  await notify(tg.tradeClose(closedTrade, pnl, "MANUAL", broker.getMode()));
  const _linhaM = `✋ VENDA MANUAL (pedido da app) ${pos.assetSym} | P&L ${sign(pnl)}${eur(pnl)}`;
  if (pnl >= 0) logger.win(_linhaM); else logger.loss(_linhaM);
  return { ok: true, pnl };
}

// ── Comprar a pedido do utilizador (via comando) ─────────────────────────────
async function buyManual({ assetId, amount }) {
  const price = prices.getFreshPrice(assetId);
  if (!price) {
    const sym = (prices.ASSETS.find(a => a.id === assetId)?.sym) || assetId;
    const motivo = `Ordem recusada: sem preço de mercado para ${sym} (fonte em baixo)`;
    logEvent("warn", motivo);
    return { ok: false, reason: `sem preço de mercado atual para ${sym} (fonte de dados em baixo) — tenta novamente daqui a pouco` };
  }
  // Limite de posições MANUAIS imposto no bot (não só na app) — para o limite
  // ser fiável mesmo que o comando venha de outra origem.
  const maxMan = Number(appSettings.maxManuais) || 5;
  const manualAbertas = Object.values(openPositions).filter(p => p.stratId === "manual").length;
  if (manualAbertas >= maxMan) {
    return { ok: false, reason: `limite de ${maxMan} posições manuais atingido` };
  }
  // Reaproveita o caminho normal de compra, como uma "estratégia manual".
  const fakeStrat = { id: "manual", nome: "Compra manual", sl: appSettings.stopLossPadrao || 6, tp: appSettings.takeProfitPadrao || 12, compra: 0, risco: "manual", perTrade: amount };
  const before = Object.keys(openPositions).length;
  await executeBuy(fakeStrat, assetId, price, 70);
  const opened = Object.keys(openPositions).length > before;
  return opened ? { ok: true } : { ok: false, reason: "não abriu (corretora recusou ou limite atingido)" };
}

// ── Processar a fila de comandos da app (compra/venda manual) ────────────────
async function processCommands(currentPrices) {
  let cmds;
  try { cmds = await fb.fetchPendingCommands(); } catch { return; }
  if (!cmds || !cmds.length) return;
  for (const cmd of cmds) {
    try {
      if (cmd.type === "SELL" && cmd.posId) {
        const r = await closePositionManual(cmd.posId, currentPrices);
        await fb.markCommand(cmd.id, r.ok ? "FEITO" : "FALHOU", r.ok ? `P&L ${r.pnl}` : r.reason);
      } else if (cmd.type === "BUY" && cmd.assetId) {
        if (botPaused) { await fb.markCommand(cmd.id, "FALHOU", "bot pausado — sem novas entradas"); continue; }
        const amount = Math.max(10, Number(cmd.amount) || 0);
        const r = await buyManual({ assetId: cmd.assetId, amount });
        await fb.markCommand(cmd.id, r.ok ? "FEITO" : "FALHOU", r.ok ? "comprado" : r.reason);
      } else {
        await fb.markCommand(cmd.id, "FALHOU", "comando inválido");
      }
    } catch (e) {
      await fb.markCommand(cmd.id, "FALHOU", e.message).catch(() => {});
    }
  }
}

module.exports = { init, processCommands };
