// src/broker.js
// ─────────────────────────────────────────────────────────────────────────────
// ROUTER DE EXECUÇÃO — escolhe QUAL broker executa cada ativo.
// ─────────────────────────────────────────────────────────────────────────────
// O motor (sim-engine.js) continua a chamar broker.buy()/sell()/isLive() tal e
// qual como antes. ESTA camada é que decide, por ativo, qual o adaptador a usar
// (Alpaca, Binance, …), com failover automático se o broker preferido estiver
// em baixo ou não suportar o ativo. Adicionar/remover/trocar brokers faz-se em
// brokers/registry.js e no .env — nunca no motor.
//
// MODE:
//   "sim"   → tudo fictício, sem corretora (resolve aqui mesmo)
//   "paper" → ordens REAIS em conta paper (Alpaca paper) — Binance não tem paper
//   "real"  → ordens REAIS com DINHEIRO REAL
//
// ROUTING (env BROKER_ROUTING, opcional). Mapeia classe de ativo → ordem de
// preferência de brokers. Ex.:
//   BROKER_ROUTING="crypto:binance,alpaca; etf:alpaca; commodity:alpaca"
// Se não definires, usa o DEFAULT_ROUTING abaixo. Para cada ativo, o router tenta
// os brokers pela ordem dada e usa o primeiro que (a) está disponível
// (credenciais presentes) e (b) supports(assetId).

const logger   = require("./logger");
const registry = require("./brokers/registry");

const MODE = (process.env.MODE || "sim").toLowerCase();
const LIVE = MODE === "paper" || MODE === "real";

// ── Classe de ativo (para o routing) ─────────────────────────────────────────
const CRYPTO_IDS    = new Set(["btc","eth","bnb","sol","xrp","doge","ada","avax","dot","link"]);
const ETF_IDS       = new Set(["spy","qqq","iwm","gld","tlt","xle","eem","vti"]);
const COMMODITY_IDS = new Set(["gold","silver","wti","natgas","copper","xau","xag"]);
const FOREX_IDS     = new Set(["eurusd","gbpusd","usdjpy","usdchf","audusd","usdcad"]);

function assetClass(assetId) {
  if (CRYPTO_IDS.has(assetId))    return "crypto";
  if (ETF_IDS.has(assetId))       return "etf";
  if (COMMODITY_IDS.has(assetId)) return "commodity";
  if (FOREX_IDS.has(assetId))     return "forex";
  return "stock";
}

// Preferência por classe (ordem = prioridade). Failover segue esta ordem.
const DEFAULT_ROUTING = {
  crypto:    ["alpaca", "binance"], // crypto: Alpaca primeiro (tem paper); Binance se quiseres real
  etf:       ["alpaca"],
  stock:     ["alpaca"],
  commodity: ["alpaca"],
  forex:     ["ibkr"],              // (precisa de adaptador IBKR; sem ele, cai para qualquer um que suporte)
};

function parseRouting() {
  const raw = process.env.BROKER_ROUTING;
  if (!raw) return DEFAULT_ROUTING;
  const out = { ...DEFAULT_ROUTING };
  raw.split(";").forEach(part => {
    const [cls, list] = part.split(":").map(s => s && s.trim());
    if (cls && list) out[cls] = list.split(",").map(s => s.trim()).filter(Boolean);
  });
  return out;
}
const ROUTING = parseRouting();

// ── Escolhe o adaptador para um ativo ────────────────────────────────────────
// Tenta a ordem de preferência da classe; aceita o primeiro disponível que
// suporta o ativo. Se nenhum da lista servir, tenta QUALQUER disponível que
// suporte (failover total). Devolve null se ninguém puder.
function pickAdapter(assetId) {
  const cls   = assetClass(assetId);
  const prefs = ROUTING[cls] || [];
  const avail = registry.available();

  for (const id of prefs) {
    const a = avail.find(x => x.id === id && x.supports(assetId));
    if (a) return a;
  }
  // Failover: qualquer broker disponível que suporte este ativo.
  const fallback = avail.find(x => x.supports(assetId));
  if (fallback && prefs.length) {
    logger.warn(`Routing: nenhum broker preferido (${prefs.join(",")}) disponível para ${assetId} — failover para ${fallback.id}`);
  }
  return fallback || null;
}

// ── Interface pública (igual à de antes — o motor não muda) ──────────────────
function getMode() { return MODE; }
function isLive()  { return LIVE; }
function isReal()  { return MODE === "real"; }

async function verifyConnection() {
  if (!LIVE) {
    logger.info("Broker: modo SIMULAÇÃO (sem corretora)");
    return { ok: true, mode: "sim" };
  }
  const avail = registry.available();
  if (avail.length === 0) {
    throw new Error("Nenhum broker configurado — define as credenciais de pelo menos um (ex.: ALPACA_API_KEY/SECRET ou BINANCE_API_KEY/SECRET)");
  }
  logger.info(`Broker: modo ${MODE.toUpperCase()} | ${avail.length} broker(s) disponível(eis): ${avail.map(a => a.id).join(", ")}`);

  // Guarda de segurança paper/real para a Alpaca (mantém o comportamento antigo).
  const alpaca = registry.byId("alpaca");
  if (alpaca && alpaca.isConnected()) {
    const alpacaLive = alpaca.isLive?.() ?? false;
    if (MODE === "paper" && alpacaLive) {
      throw new Error("MODE=paper mas ALPACA_BASE_URL aponta para LIVE — abortado por segurança. Corrige a URL.");
    }
    if (MODE === "real" && !alpacaLive) {
      logger.warn("⚠ MODE=real mas ALPACA_BASE_URL aponta para PAPER. Alpaca executará em PAPER.");
    }
  }

  // Verifica cada broker disponível (não aborta se um falhar — regista e segue).
  for (const a of avail) {
    try { await a.verifyConnection(); }
    catch (e) { logger.warn(`Broker ${a.id} não verificou: ${e.message}`); }
  }
  return { ok: true, mode: MODE, brokers: avail.map(a => a.id) };
}

// Saldo: soma o saldo dos brokers disponíveis (em sim devolve null).
async function getBalance() {
  if (!LIVE) return null;
  let total = 0, any = false;
  for (const a of registry.available()) {
    try { const b = await a.getBalance(); if (b != null) { total += b; any = true; } }
    catch (e) { logger.warn(`getBalance ${a.id} falhou: ${e.message}`); }
  }
  return any ? total : null;
}

// ── COMPRA ───────────────────────────────────────────────────────────────────
async function buy({ assetId, amount, price, sl, tp }) {
  if (!LIVE) {
    return { ok: true, fillPrice: price, brokerOrderId: null, simulated: true };
  }
  const a = pickAdapter(assetId);
  if (!a) return { ok: false, reason: `sem broker para ${assetId}` };
  const res = await a.buy({ assetId, amount, price, sl, tp });
  if (res.ok) logger.info(`↗ ${a.id} BUY ${assetId} | €${amount} @ $${res.fillPrice}`);
  return { ...res, broker: a.id };
}

// ── VENDA / FECHO ──────────────────────────────────────────────────────────────
async function sell({ assetId, units, price, broker: preferred }) {
  if (!LIVE) {
    return { ok: true, fillPrice: price, simulated: true };
  }
  // Se a posição guardou em que broker foi aberta, fecha NO MESMO broker.
  let a = preferred ? registry.byId(preferred) : null;
  if (!a || !a.isConnected() || !a.supports(assetId)) a = pickAdapter(assetId);
  if (!a) return { ok: false, reason: `sem broker para ${assetId}` };
  const res = await a.sell({ assetId, units, price });
  if (res.ok) logger.info(`↘ ${a.id} SELL ${assetId} | ${units} @ $${res.fillPrice}`);
  return { ...res, broker: a.id };
}

// Diagnóstico: que broker trataria cada ativo (útil em logs/arranque).
function explainRouting(assetIds = []) {
  return assetIds.map(id => {
    const a = pickAdapter(id);
    return { assetId: id, class: assetClass(id), broker: a ? a.id : "—" };
  });
}

// Para manter compatibilidade com código que importava isCrypto/orderSymbol.
function isCrypto(assetId) { return CRYPTO_IDS.has(assetId); }

module.exports = {
  getMode, isLive, isReal, verifyConnection, getBalance,
  buy, sell, isCrypto, assetClass, pickAdapter, explainRouting,
  registry,
};
