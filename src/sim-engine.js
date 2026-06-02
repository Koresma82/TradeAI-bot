// src/sim-engine.js
// Motor de simulação 24/7 — corre no servidor sem IBKR/Alpaca
// Lê estratégias do Firestore, executa lógica, guarda trades no Firestore
// A app React lê os resultados em tempo real via onSnapshot

const logger  = require("./logger");
const fb      = require("./firebase");
const prices  = require("./prices");
const stats   = require("./stats");
const aiSignals = require("./ai-signals");
const dayTrading = require("./day-trading");
const { notify, tg } = require("./telegram");

const uid = () => require("crypto").randomUUID();

// ── Estado em memória ─────────────────────────────────────────────────────────
let strategies    = [];
let openPositions = {};  // { posId: { ...position } }
let priceHistory  = {};  // { assetId: [{ price, ts }] }
let lastBuyTime   = {};  // cooldown por estratégia/ativo
let tickCount     = 0;
let totalInvested = 0;
let dailyLossHit  = false;
// Definições lidas do Firestore (a app controla isto)
let appSettings   = {
  maxEstrategias: 5,
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
// Ativos negociáveis (o cérebro AI só compra estes)
const TRADEABLE = new Set(["btc","eth","wti","gold","silver","spy","qqq","gld","eurusd","gbpusd"]);

// ── Helpers ───────────────────────────────────────────────────────────────────
const sign = v => v >= 0 ? "+" : "−";
const eur  = v => `€${Math.abs(v).toFixed(2)}`;

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
    if (!price) continue;

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

    // ── Saída antecipada se a IA virar para VENDER com confiança ──
    const sg = aiSignals.getSignal(pos.assetId);
    if (exitOnFlip && sg && sg.sinal === "VENDER" && (sg.confianca || 0) >= flipConf && price > pos.sl) {
      reason = "AI-EXIT"; closePrice = price;
    }
    else if (price <= pos.sl) {
      reason = (trailingOn && pos.sl > pos.entryPrice) ? "TRAIL" : "SL";
      closePrice = pos.sl;
    }
    else if (price >= pos.tp) { reason = "TP"; closePrice = pos.tp; }

    if (!reason) continue;

    const pnl = (closePrice - pos.entryPrice) * pos.units;
    const icon = pnl >= 0 ? "✅" : "🛑";
    logger.info(`${icon} ${reason} ${pos.assetSym} | P&L ${sign(pnl)}${eur(pnl)}`);

    const closedTrade = {
      ...pos,
      status:    reason,
      closePrice,
      closedAt:  new Date().toLocaleTimeString("pt-PT"),
      pnl,
    };

    // Remove posição + devolve saldo
    delete openPositions[posId];
    totalInvested = Math.max(0, totalInvested - pos.amount);
    simBalance    = +(simBalance + pos.amount + pnl).toFixed(2);

    // Guarda no Firestore
    await fb.updateTrade("server", posId, { status: reason, closePrice, pnl, closedAt: closedTrade.closedAt });
    await fb.saveBalance("server", simBalance);
    stats.addClosedTrade(closedTrade);
    dailyLossHit = stats.checkDailyLossLimit();

    await notify(tg.tradeClose(closedTrade, pnl, reason));
  }
}

// ── Executar compra simulada ──────────────────────────────────────────────────
async function executeBuy(strategy, assetId, price) {
  const amount = Math.min(strategy.perTrade, parseFloat(process.env.MAX_POSITION_EUR || "500"));

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
    await fb.updateTrade("server", bestWinner.id, { status: "ROTACAO", closePrice: cur, pnl: bestPnl, closedAt: new Date().toLocaleTimeString("pt-PT") });
    await fb.saveBalance("server", simBalance);
    stats.addClosedTrade({ ...bestWinner, status: "ROTACAO", closePrice: cur, pnl: bestPnl });
    logger.info(`🔄 ROTAÇÃO: fechado ${bestWinner.assetSym} (+€${bestPnl.toFixed(2)}) para abrir ${assetId}`);
  }

  const units = +(amount / price).toFixed(7);
  const sl    = +(price * (1 - strategy.sl  / 100)).toFixed(4);
  const tp    = +(price * (1 + strategy.tp  / 100)).toFixed(4);
  const posId = `sim_${Date.now()}_${assetId}`;

  const position = {
    id:          posId,
    assetId,
    assetName:   assetId,
    assetSym:    assetId.toUpperCase(),
    entryPrice:  price,
    units,
    amount,
    peak:        price,
    sl, tp,
    strategy:    strategy.nome,
    stratId:     strategy.id,
    openedAt:    new Date().toLocaleTimeString("pt-PT"),
    status:      "ABERTA",
    mode:        "sim",
  };

  openPositions[posId] = position;
  totalInvested += amount;
  simBalance     = +(simBalance - amount).toFixed(2);

  // Guarda no Firestore — a app React vê em tempo real
  await fb.saveTrade("server", position);
  await fb.saveBalance("server", simBalance);
  await notify(tg.tradeOpen(position, "demo"));

  logger.info(`BUY SIM ${assetId} | €${amount} | @$${price} | SL $${sl} | TP $${tp}`);
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
    openedAt: new Date().toLocaleTimeString("pt-PT"), status: "ABERTA", mode: "sim",
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
  const perTrade = Math.min(appSettings.valorFixo || 100, parseFloat(process.env.MAX_POSITION_EUR || "500"));
  const slPct    = appSettings.stopLossPadrao || 6;
  const tpPct    = appSettings.takeProfitPadrao || 12;

  const sigs = aiSignals.getSignals();
  for (const sg of Object.values(sigs)) {
    if (!sg || sg.sinal !== "COMPRAR" || (sg.confianca || 0) < minConf) continue;
    if (!TRADEABLE.has(sg.id)) continue;
    const pd = currentPrices[sg.id];
    if (!pd?.price) continue;

    // cooldown 5 min por ativo
    if (Date.now() - (aiBrainCooldown[sg.id] || 0) < 5 * 60 * 1000) continue;
    // não duplicar posição AI no mesmo ativo
    if (Object.values(openPositions).some(p => p.assetId === sg.id && p.stratId === "ai-brain")) continue;
    // limites
    const brainPositions = Object.values(openPositions).filter(p => p.stratId === "ai-brain");
    const allStratPos = Object.values(openPositions).filter(p => p.stratId !== "manual" && p.stratId !== "daytrading");
    if (allStratPos.length >= maxStrat) continue;
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
      openedAt: new Date().toLocaleTimeString("pt-PT"), status: "ABERTA", mode: "sim",
    };
    openPositions[posId] = position;
    totalInvested += perTrade;
    simBalance = +(simBalance - perTrade).toFixed(2);
    aiBrainCooldown[sg.id] = Date.now();

    await fb.saveTrade("server", position);
    await fb.saveBalance("server", simBalance);
    await notify(tg.aiBrainOpen(position, sg));
    logger.info(`🤖 AI BRAIN BUY ${sg.id} | €${perTrade} @$${price} | confiança ${sg.confianca}%`);
  }
}

// ── Tick principal ────────────────────────────────────────────────────────────
async function tick() {
  try {
    // 1. Refresh preços
    await prices.refreshAll();
    const currentPrices = prices.getAll();

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

          // Cooldown: não comprar o mesmo ativo/estratégia mais que 1x por 2 min
          const cdKey = `${strategy.id}_${assetId}`;
          const lastBuy = lastBuyTime[cdKey] || 0;
          if (Date.now() - lastBuy < 120000) continue;

          // Verificar sinal: queda do máximo recente
          const high = getRecentHigh(assetId);
          if (!high) continue;
          const dropPct = ((high - priceData.price) / high) * 100;
          if (dropPct >= strategy.compra) {
            logger.info(`🎯 Sinal: ${strategy.nome} → ${assetId} (queda ${dropPct.toFixed(2)}% ≥ ${strategy.compra}%)`);
            const before = Object.keys(openPositions).length;
            await executeBuy(strategy, assetId, priceData.price);
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
    tickCount++;
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

    // 4. Atualizar P&L não realizado no Firestore (a cada tick)
    const unrealized = Object.values(openPositions).reduce((s, pos) => {
      const p = currentPrices[pos.assetId]?.price;
      return s + (p ? (p - pos.entryPrice) * pos.units : 0);
    }, 0);
    await fb.saveSetting("server", "simLive", {
      balance:       simBalance,
      unrealized:    +unrealized.toFixed(2),
      totalInvested: +totalInvested.toFixed(2),
      openPositions: Object.keys(openPositions).length,
      lastTick:      new Date().toISOString(),
    });

    // 5. Heartbeat — a app usa isto para saber que o bot está vivo e desligar o seu próprio motor
    await fb.saveSetting("server", "botStatus", {
      alive:    true,
      mode:     "sim",
      lastSeen: Date.now(),
      features: {
        aiBrain:      !!appSettings.aiBrain,
        trailingStop: !!appSettings.trailingStop,
        aiExitOnFlip: appSettings.aiExitOnFlip !== false,
      },
    });

  } catch (err) {
    logger.error(`SimEngine tick erro: ${err.message}`);
    await fb.logError("sim-engine-tick", err).catch(() => {});
  }
}

// ── Inicializar ───────────────────────────────────────────────────────────────
async function init() {
  logger.info("═══════════════════════════════════");
  logger.info("  TradeAI Sim Engine 24/7");
  logger.info(`  Capital: €${simCapital}`);
  logger.info("═══════════════════════════════════");

  stats.setBalance(simBalance);

  // Carregar saldo guardado
  const savedBal = await fb.getBalance("server");
  if (savedBal && savedBal > 0) {
    simBalance = savedBal;
    simCapital = savedBal; // considera o atual como base se já havia
    stats.setBalance(simBalance);
    logger.info(`Saldo restaurado: €${simBalance}`);
  }

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
        maxDayTrading:    val.maxDayTrading ?? 5,
        aiSignalsMin:     val.aiSignalsMin ?? 15,
      };
      // Aplicar intervalo de sinais AI em tempo real
      aiSignals.setRefreshMinutes(appSettings.aiSignalsMin);
      logger.info(`Definições: máx ${appSettings.maxEstrategias} | rotação ${appSettings.rotacaoAtiva ? "ON" : "OFF"} | AI Brain ${appSettings.aiBrain ? `ON@${appSettings.aiBrainConfianca}%` : "OFF"} | Trailing ${appSettings.trailingStop ? `ON@${appSettings.trailingStopPct}%` : "OFF"} | Sinais ${appSettings.aiSignalsMin}min`);
    }
  });

  // Subscrever config de Day Trading (escrita pela app em settings/dtState)
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
      logger.info(`Day Trading: ${dtConfig.active ? `ON · alvo ${dtConfig.profitTarget}% · SL ${dtConfig.maxLoss}% · €${dtConfig.amount} · conf ${dtConfig.minConf}%` : "OFF"}`);
    }
  });

  // Aguardar carga inicial
  await new Promise(r => setTimeout(r, 2000));

  // Primeiro fetch de preços
  await prices.refreshAll();
  logger.info("Preços inicializados ✓");

  // Loop principal
  const TICK_MS = parseInt(process.env.SIM_TICK_MS || "30000"); // 30s por defeito
  setInterval(tick, TICK_MS);
  logger.info(`Motor iniciado — tick cada ${TICK_MS / 1000}s ✓`);

  // Primeiro tick imediato
  await tick();
}

module.exports = { init };
