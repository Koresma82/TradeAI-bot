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
const { notify, tg } = require("./telegram");

const uid = () => require("crypto").randomUUID();

// ── Estado em memória ─────────────────────────────────────────────────────────
let strategies    = [];
let openPositions = {};  // { posId: { ...position } }
let priceHistory  = {};  // { assetId: [{ price, ts }] } — intradiário (curto prazo)
let dailySeries   = {};  // { assetId: [fechos diários] } — para indicadores (RSI/MM)
let noPriceWarned = {};  // { assetId: ts } — controlo de avisos "sem preço"
let lastBuyTime   = {};  // cooldown por estratégia/ativo
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
const HEARTBEAT_MS     = 2 * 60 * 1000;   // heartbeat a cada 2 min (app exige < 3 min)
// Definições lidas do Firestore (a app controla isto)
let appSettings   = {
  maxEstrategias: 5,
  riscoPerfil: "moderado",
  modoValor: "fixo",
  rotacaoAtiva: false,
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
    const price = currentPrices[pos.assetId]?.price;
    if (!price) {
      // Posição aberta sem preço atual (fonte falhou ou ativo removido).
      // Não a perdemos — fica aberta e gerida assim que o preço voltar.
      // Avisa 1x por hora para não encher os logs.
      const k = `nopx_${pos.assetId}`;
      if (!noPriceWarned[k] || Date.now() - noPriceWarned[k] > 3600000) {
        logger.warn(`⚠ Sem preço para ${pos.assetSym || pos.assetId} (posição aberta continua segura, à espera de preço)`);
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
    // Só fecha SE houver lucro (a função é "proteger ganhos", não sair a zero/perda).
    const sg = aiSignals.getSignal(pos.assetId);
    const emLucro = price > pos.entryPrice;
    if (!onHold && podeAiExit && exitOnFlip && sg && sg.sinal === "VENDER" && (sg.confianca || 0) >= flipConf && emLucro && price > pos.sl) {
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
      reason = "TP";
      closePrice = Math.max(price, pos.tp); // idem: preço real, não o TP teórico
    }

    if (!reason) continue;

    const pnl = (closePrice - pos.entryPrice) * pos.units;
    const icon = pnl >= 0 ? "✅" : "🛑";

    // ── Executar a venda real na Alpaca se em modo live ──
    if (broker.isLive()) {
      const exec = await broker.sell({ assetId: pos.assetId, units: pos.units, price: closePrice, broker: pos.broker });
      if (!exec.ok) {
        logger.warn(`Venda ${pos.assetSym} falhou: ${exec.reason} — tenta no próximo tick`);
        continue; // não fecha localmente se a corretora recusou
      }
    }

    logger.info(`${icon} ${reason} ${pos.assetSym} | P&L ${sign(pnl)}${eur(pnl)}`);

    const closedTs = Date.now();
    const closedTrade = {
      ...pos,
      status:    reason,
      closePrice,
      closedAt:  new Date().toLocaleString("pt-PT"),
      closedTs,
      pnl,
    };

    // Remove posição + devolve saldo
    delete openPositions[posId];
    totalInvested = Math.max(0, totalInvested - pos.amount);
    simBalance    = +(simBalance + pos.amount + pnl).toFixed(2);

    // Guarda no Firestore
    await fb.updateTrade("server", posId, { status: reason, closePrice, pnl, closedAt: closedTrade.closedAt, closedTs });
    await fb.saveBalance("server", simBalance);
    stats.addClosedTrade(closedTrade);
    dailyLossHit = stats.checkDailyLossLimit();

    await notify(tg.tradeClose(closedTrade, pnl, reason));
  }
}

// ── Sugestão de quantia a investir — perfil de risco + confiança + saldo ──────
// Espelha a lógica da app. Em sim usa o saldo da simulação; em paper/live usaria
// o saldo do broker (via broker.getBalance, mas mantemos simples e seguro aqui).
function suggestAmount(assetId, confianca, strategy) {
  const avail = simBalance;
  if (!avail || avail <= 0) return strategy.perTrade || 10;

  // Modo "fixo": respeita o valor fixo da estratégia/definições (comportamento clássico).
  if (appSettings.modoValor !== "percentagem") {
    return Math.min(strategy.perTrade || appSettings.valorFixo || 10, avail);
  }

  // Modo "% da Banca": dimensiona pelo perfil de risco + confiança + saldo.
  const PERFIL = {
    conservador: { teto: 0.10, base: 0.04 },
    moderado:    { teto: 0.20, base: 0.08 },
    agressivo:   { teto: 0.33, base: 0.14 },
  };
  const cfg = PERFIL[appSettings.riscoPerfil] || PERFIL.moderado;
  const c = Math.max(0, Math.min(100, confianca || 0));
  const mult = c >= 90 ? 2.0 : c >= 80 ? 1.5 : c >= 70 ? 1.1 : c >= 60 ? 0.8 : 0.5;
  // Base: a % da banca definida nas Definições, escalada pela confiança, com teto do perfil.
  const pctBase = (appSettings.percentagem || 3) / 100;
  let amount = avail * pctBase * mult;
  amount = Math.min(amount, avail * cfg.teto);
  amount = Math.max(10, Math.min(amount, avail));
  return +amount.toFixed(2);
}

// ── Executar compra simulada ──────────────────────────────────────────────────
async function executeBuy(strategy, assetId, price, confianca) {
  // Quantia: por perfil+confiança+saldo se modoInvestimento="auto", senão fixo.
  const sized  = suggestAmount(assetId, confianca, strategy);
  const amount = Math.min(sized, parseFloat(process.env.MAX_POSITION_EUR || "500"));

  if (simBalance < amount) {
    logger.warn(`Saldo insuficiente: €${simBalance} < €${amount}`);
    return;
  }
  if (totalInvested + amount > parseFloat(process.env.MAX_TOTAL_EUR || simCapital)) {
    logger.warn(`Limite total atingido`);
    return;
  }
  if (dailyLossHit) { logger.warn("Limite perda diária atingido — bloqueado"); return; }

  // Limite de posições de estratégia (por tipo)
  const maxStrat = appSettings.maxEstrategias || 5;
  const stratPositions = Object.values(openPositions).filter(
    p => p.stratId !== "manual" && p.stratId !== "daytrading"
  );
  if (stratPositions.length >= maxStrat) {
    if (!appSettings.rotacaoAtiva) {
      // Limite cheio, rotação desligada → não compra
      return;
    }
    // ── ROTAÇÃO: vender a posição com mais lucro para abrir esta ──
    let bestWinner = null, bestPnl = -Infinity;
    for (const pos of stratPositions) {
      const cur = prices.getPrice(pos.assetId);
      if (!cur) continue;
      const pnl = (cur - pos.entryPrice) * pos.units;
      if (pnl > bestPnl) { bestPnl = pnl; bestWinner = pos; }
    }
    // Só roda se a melhor posição estiver em lucro
    if (!bestWinner || bestPnl <= 0) {
      return; // nenhuma em lucro para sacrificar
    }
    // Fechar o vencedor
    const cur = prices.getPrice(bestWinner.assetId);
    delete openPositions[bestWinner.id];
    totalInvested = Math.max(0, totalInvested - bestWinner.amount);
    simBalance = +(simBalance + bestWinner.amount + bestPnl).toFixed(2);
    const rotClosedTs = Date.now();
    await fb.updateTrade("server", bestWinner.id, { status: "ROTACAO", closePrice: cur, pnl: bestPnl, closedAt: new Date().toLocaleString("pt-PT"), closedTs: rotClosedTs });
    await fb.saveBalance("server", simBalance);
    stats.addClosedTrade({ ...bestWinner, status: "ROTACAO", closePrice: cur, pnl: bestPnl, closedTs: rotClosedTs });
    logger.info(`🔄 ROTAÇÃO: fechado ${bestWinner.assetSym} (+€${bestPnl.toFixed(2)}) para abrir ${assetId}`);
  }

  const units = +(amount / price).toFixed(7);
  const sl    = +(price * (1 - strategy.sl  / 100)).toFixed(4);
  const tp    = +(price * (1 + strategy.tp  / 100)).toFixed(4);
  const posId = `${broker.isLive() ? "live" : "sim"}_${Date.now()}_${assetId}`;

  // ── Executar a ordem (real na Alpaca se MODE=paper/real; senão simulada) ──
  const exec = await broker.buy({ assetId, amount, price, sl, tp });
  if (!exec.ok) {
    logger.warn(`Compra ${assetId} não executada: ${exec.reason}`);
    return;
  }
  const fillPrice = exec.fillPrice || price;
  const realUnits = +(amount / fillPrice).toFixed(7);

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
  };

  openPositions[posId] = position;
  totalInvested += amount;
  simBalance     = +(simBalance - amount).toFixed(2);

  // Guarda no Firestore — a app React vê em tempo real
  await fb.saveTrade("server", position);
  await fb.saveBalance("server", simBalance);
  await notify(tg.tradeOpen(position, broker.getMode()));

  logger.info(`BUY ${broker.getMode().toUpperCase()} ${assetId} | €${amount} | @$${fillPrice} | SL $${sl} | TP $${tp}`);
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
  const amt = Math.min(amount, parseFloat(process.env.MAX_POSITION_EUR || "500"));
  if (simBalance < amt) return false;
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
  await notify(tg.tradeOpen(position, "daytrade")).catch(() => {});
  logger.info(`⚡ DAYTRADE BUY ${assetId} | €${amt} @$${price} | SL $${sl} | TP $${tp} | conf ${confianca}%`);
  return true;
}


const aiBrainCooldown = {}; // { assetId: ts }
async function runAiBrain(currentPrices) {
  if (!appSettings.aiBrain || dailyLossHit) return;
  const minConf  = appSettings.aiBrainConfianca || 78;
  const maxStrat = appSettings.maxEstrategias || 5;
  const slPct    = appSettings.stopLossPadrao || 6;
  const tpPct    = appSettings.takeProfitPadrao || 12;

  const sigs = aiSignals.getSignals();
  for (const sg of Object.values(sigs)) {
    if (!sg || sg.sinal !== "COMPRAR" || (sg.confianca || 0) < minConf) continue;
    if (!TRADEABLE.has(sg.id)) continue;
    // Não abrir em mercado fechado (evita flip-flop a preços congelados)
    if (!isMarketOpenFor(sg.id)) continue;
    const pd = currentPrices[sg.id];
    if (!pd?.price) continue;

    // ── Travão de sanidade: o Groq pode inflacionar confiança (diz 100% em
    //    ativos parados). Só entra se os INDICADORES TÉCNICOS também concordarem.
    //    Assim o AI Brain combina o "raciocínio" do LLM com dados objetivos. ──
    const daily = dailySeries[sg.id] || [];
    if (daily.length >= 15) {
      const serie = [...daily.slice(-89), pd.price];
      const tech = indicators.buySignal(serie, { dropTrigger: 1.0, rsiOversold: 45, smaLong: 50 });
      if (!tech.buy) {
        // Groq diz comprar mas os indicadores não confirmam → ignora (evita falsos sinais)
        continue;
      }
    }
    // (se não há histórico suficiente, confia só no Groq — fallback)

    // cooldown 5 min por ativo
    if (Date.now() - (aiBrainCooldown[sg.id] || 0) < 5 * 60 * 1000) continue;
    // não duplicar posição AI no mesmo ativo
    if (Object.values(openPositions).some(p => p.assetId === sg.id && p.stratId === "ai-brain")) continue;
    // limites
    const brainPositions = Object.values(openPositions).filter(p => p.stratId === "ai-brain");
    const allStratPos = Object.values(openPositions).filter(p => p.stratId !== "manual" && p.stratId !== "daytrading");
    if (allStratPos.length >= maxStrat) continue;
    // Quantia por perfil+confiança+saldo (igual à app); fixo se modo != auto.
    const perTrade = Math.min(
      suggestAmount(sg.id, sg.confianca, { perTrade: appSettings.valorFixo || 100 }),
      parseFloat(process.env.MAX_POSITION_EUR || "500")
    );
    if (simBalance < perTrade) continue;
    if (totalInvested + perTrade > parseFloat(process.env.MAX_TOTAL_EUR || simCapital)) continue;

    const price = pd.price;
    const units = +(perTrade / price).toFixed(7);
    const sl    = +(price * (1 - slPct / 100)).toFixed(sg.id === "eurusd" ? 5 : 4);
    const tp    = +(price * (1 + tpPct / 100)).toFixed(sg.id === "eurusd" ? 5 : 4);
    const posId = `aibrain_${Date.now()}_${sg.id}`;
    const position = {
      id: posId, assetId: sg.id, assetName: sg.id, assetSym: sg.id.toUpperCase(),
      entryPrice: price, units, amount: perTrade, peak: price, sl, tp,
      strategy: `🤖 AI Brain (${sg.confianca}%)`, stratId: "ai-brain",
      openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(), status: "ABERTA", mode: "sim",
    };
    openPositions[posId] = position;
    totalInvested += perTrade;
    simBalance = +(simBalance - perTrade).toFixed(2);
    aiBrainCooldown[sg.id] = Date.now();

    await fb.saveTrade("server", position);
    await fb.saveBalance("server", simBalance);
    await notify(tg.tradeOpen(position, broker.getMode())).catch(() => {});
    logger.info(`🤖 AI BRAIN BUY ${sg.id} | €${perTrade} @$${price} | confiança ${sg.confianca}%`);
  }
}

// ── Tick principal ────────────────────────────────────────────────────────────
async function tick() {
  try {
    tickCount++;
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

    // 3. Verificar sinais das estratégias
    if (!dailyLossHit) {
      for (const strategy of strategies) {
        if (!strategy.ativo) continue;
        for (const assetId of (strategy.ativos || [])) {
          const priceData = currentPrices[assetId];
          if (!priceData?.price) continue;
          // Não comprar em mercado fechado (preços congelados → sinais falsos)
          if (!isMarketOpenFor(assetId)) continue;

          // Cooldown: não comprar o mesmo ativo/estratégia mais que 1x por 2 min
          const cdKey = `${strategy.id}_${assetId}`;
          const lastBuy = lastBuyTime[cdKey] || 0;
          if (Date.now() - lastBuy < 120000) continue;

          // ── Sinal realista: combina histórico diário (RSI + média móvel)
          //    com a queda intradiária recente. Precisa de ≥2 critérios. ──
          // Série = histórico diário + o preço de hoje no fim (para refletir o agora)
          const daily = dailySeries[assetId] || [];
          const serie = daily.length ? [...daily.slice(-89), priceData.price] : [];

          let sinal;
          if (serie.length >= 15) {
            // Temos histórico real → usa indicadores técnicos
            sinal = indicators.buySignal(serie, {
              dropTrigger: strategy.compra,           // gatilho de queda da estratégia
              rsiOversold: strategy.risco === "alto" ? 45 : strategy.risco === "baixo" ? 30 : 38,
              smaLong:     50,
            });
          } else {
            // Fallback: ainda sem histórico → usa só a queda intradiária (como antes)
            const high = getRecentHigh(assetId);
            const dropPct = high ? ((high - priceData.price) / high) * 100 : 0;
            sinal = { buy: dropPct >= strategy.compra, score: 60, reason: `queda ${dropPct.toFixed(1)}% (sem histórico)` };
          }

          if (sinal.buy) {
            logger.info(`🎯 Sinal: ${strategy.nome} → ${assetId} | ${sinal.reason} (força ${sinal.score})`);
            const before = Object.keys(openPositions).length;
            // Confiança para o sizing: usa o score do sinal técnico, reforçado pela
            // confiança da IA para o ativo se existir e for maior.
            const aiSig = aiSignals.getSignal(assetId);
            const conf  = Math.max(sinal.score || 0, aiSig?.confianca || 0);
            await executeBuy(strategy, assetId, priceData.price, conf);
            if (Object.keys(openPositions).length > before) lastBuyTime[cdKey] = Date.now();
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
      await fb.saveSetting("server", "marketPrices", { prices: slim, ts: now }).catch(() => {});
      lastPricesAt = now;
    }

    // 5. Heartbeat — a app usa para saber que o bot está vivo (exige < 3 min).
    //    Escreve a cada 2 min, ou imediatamente se as features mudarem.
    const features = {
      aiBrain:      !!appSettings.aiBrain,
      trailingStop: !!appSettings.trailingStop,
      aiExitOnFlip: appSettings.aiExitOnFlip !== false,
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
        twelvedata: { ok: ph.twelvedata?.ok, lastOk: ph.twelvedata?.lastOk, err: ph.twelvedata?.lastErr },
        stooq:      { ok: ph.stooq.ok,       lastOk: ph.stooq.lastOk,       err: ph.stooq.lastErr },
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

  // Carregar saldo guardado
  const savedBal = await fb.getBalance("server");
  if (savedBal && savedBal > 0) {
    simBalance = savedBal;
    simCapital = savedBal; // considera o atual como base se já havia
    stats.setBalance(simBalance);
    logger.info(`Saldo restaurado: €${simBalance}`);
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

  // Subscrever definições da app (limites, rotação, automação AI)
  fb.watchSetting("settings", (val) => {
    if (val && typeof val === "object") {
      appSettings = {
        maxEstrategias:   val.maxEstrategias ?? 5,
        rotacaoAtiva:     val.rotacaoAtiva ?? false,
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
        aiSignalsMin:     val.aiSignalsMin ?? 15,
      };
      // Aplicar intervalo de sinais AI em tempo real
      aiSignals.setRefreshMinutes(appSettings.aiSignalsMin);
      logger.info(`Definições: máx ${appSettings.maxEstrategias} | rotação ${appSettings.rotacaoAtiva ? "ON" : "OFF"} | AI Brain ${appSettings.aiBrain ? `ON@${appSettings.aiBrainConfianca}%` : "OFF"} | Trailing ${appSettings.trailingStop ? `ON@${appSettings.trailingStopPct}%` : "OFF"} | Sinais ${appSettings.aiSignalsMin}min`);
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

module.exports = { init };
