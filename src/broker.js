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

// ── Comissões por classe de ativo (fração do valor da ordem, por LADO) ───────
// Alpaca: ações/ETF = $0; cripto = 0.25% por lado (taker, nível normal).
// Commodities/ações via ETF (GLD, USO…) → tratadas como ETF (comissão 0).
// Forex não é negociado pela Alpaca/Binance aqui — fica a 0 por agora.
// Configurável por env (CRYPTO_FEE_BPS em pontos-base) para afinar sem código.
const CRYPTO_FEE = (parseFloat(process.env.CRYPTO_FEE_BPS || "25")) / 10000; // 25 bps = 0.25%
const FEE_BY_CLASS = {
  crypto:    CRYPTO_FEE,
  etf:       0,
  stock:     0,
  commodity: 0, // negociadas via ETF (GLD/USO/…) → comissão 0 na Alpaca
  forex:     0,
};

// Comissão estimada (€) para UM lado (compra OU venda) de uma ordem de `amount` €.
function feeRate(assetId) {
  return FEE_BY_CLASS[assetClass(assetId)] ?? 0;
}
function estimateFee(assetId, amount) {
  return +(Math.abs(amount || 0) * feeRate(assetId)).toFixed(4);
}
// Comissão ida-e-volta (compra + venda) — útil para o "lucro mínimo".
function roundTripFee(assetId, amount) {
  return +(estimateFee(assetId, amount) * 2).toFixed(4);
}

// Preferência por classe (ordem = prioridade). Failover segue esta ordem.
// Intenção do utilizador em REAL: crypto→Binance, ações/ETF/commodity→Alpaca.
// Em PAPER a Binance não está configurada (não tem paper), por isso o failover
// leva a crypto para a Alpaca paper automaticamente — sem precisar de mudar nada.
// Para forçar outra rota, define BROKER_ROUTING no .env (ver parseRouting).
const DEFAULT_ROUTING = {
  crypto:    ["binance", "alpaca"], // REAL: Binance. PAPER: cai p/ Alpaca (failover).
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
//
// GUARDA DE SEGURANÇA paper↔real: a Binance NÃO tem conta paper — só executa
// ordens REAIS (ou testnet). Por isso, em MODE=paper, recusamos qualquer broker
// que esteja a apontar para produção live (ex.: Binance com chaves reais). Isto
// impede o cenário perigoso de "estou em paper mas a crypto foi para a Binance
// real". Em MODE=real, todos os brokers live são permitidos.
function adapterAllowedInMode(a) {
  if (MODE === "real") return true;            // real → tudo permitido
  if (!LIVE) return true;                       // sim → não executa de qualquer forma
  // MODE === "paper": só permitir adaptadores que NÃO estejam em produção live.
  // Alpaca paper → isLive() é false (URL contém "paper") → permitido.
  // Binance com chaves reais → isLive() é true → BLOQUEADO em paper.
  // Binance testnet → isLive() é false → permitido.
  try {
    if (typeof a.isLive === "function" && a.isLive()) {
      return false;
    }
  } catch { /* se não souber, é mais seguro permitir só não-live abaixo */ }
  return true;
}

function pickAdapter(assetId) {
  const cls   = assetClass(assetId);
  const prefs = ROUTING[cls] || [];
  const avail = registry.available().filter(adapterAllowedInMode);

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

// Saldo: em sim devolve null. Com UM broker, devolve o cash desse broker.
// Fix 7: com VÁRIOS brokers, NÃO soma (somar dá uma falsa sensação de capital
// disponível e leva a sobre-alavancagem). Devolve o MENOR cash disponível como
// referência conservadora e regista o detalhe.
async function getBalance() {
  if (!LIVE) return null;
  const avail = registry.available();
  const saldos = [];
  for (const a of avail) {
    try { const b = await a.getBalance(); if (b != null) saldos.push({ id: a.id, bal: b }); }
    catch (e) { logger.warn(`getBalance ${a.id} falhou: ${e.message}`); }
  }
  if (!saldos.length) return null;
  if (saldos.length === 1) return saldos[0].bal;
  const min = Math.min(...saldos.map(s => s.bal));
  logger.warn(`getBalance: ${saldos.length} brokers (${saldos.map(s => `${s.id}:$${s.bal.toFixed(0)}`).join(", ")}) — a usar o menor ($${min.toFixed(0)}) como referência conservadora (NÃO somado).`);
  return min;
}

// Posições reais agregadas de todos os brokers (para reconciliação no arranque).
// Devolve [{ broker, symbol, qty, avgPrice }] ou null se nenhum broker souber.
async function getPositions() {
  if (!LIVE) return null;
  const out = [];
  let any = false;
  for (const a of registry.available()) {
    if (typeof a.getPositions !== "function") continue;
    try {
      const ps = await a.getPositions();
      if (ps) { any = true; ps.forEach(p => out.push({ broker: a.id, ...p })); }
    } catch (e) { logger.warn(`getPositions ${a.id} falhou: ${e.message}`); }
  }
  return any ? out : null;
}

// ── COMPRA ───────────────────────────────────────────────────────────────────
async function buy({ assetId, amount, price, sl, tp }) {
  if (!LIVE) {
    return { ok: true, fillPrice: price, brokerOrderId: null, simulated: true, bracket: false, pending: false };
  }
  const a = pickAdapter(assetId);
  if (!a) return { ok: false, reason: `sem broker para ${assetId}` };
  const res = await a.buy({ assetId, amount, price, sl, tp });
  if (res.ok) logger.info(`↗ ${a.id} BUY ${assetId} | €${amount} @ $${res.fillPrice}${res.pending ? " (fill pendente)" : ""}`);
  return { ...res, broker: a.id };
}

// ── VENDA / FECHO ──────────────────────────────────────────────────────────────
async function sell({ assetId, units, price, broker: preferred, hadBracket }) {
  if (!LIVE) {
    return { ok: true, fillPrice: price, simulated: true };
  }
  // Se a posição guardou em que broker foi aberta, fecha NO MESMO broker.
  let a = preferred ? registry.byId(preferred) : null;
  if (!a || !a.isConnected() || !a.supports(assetId)) a = pickAdapter(assetId);
  if (!a) return { ok: false, reason: `sem broker para ${assetId}` };
  const res = await a.sell({ assetId, units, price, hadBracket });
  if (res.ok) logger.info(`↘ ${a.id} SELL ${assetId} | ${units} @ $${res.fillPrice}`);
  return { ...res, broker: a.id };
}

// Cancela ordens de bracket (SL/TP nativo) pendentes de um ativo na corretora.
// Usado quando o utilizador liga Hold numa posição com bracket: o bot passa a
// gerir o SL/TP ele próprio, em vez de a corretora os disparar.
async function cancelBracket(assetId, preferred) {
  if (!LIVE) return { ok: true, simulated: true };
  let a = preferred ? registry.byId(preferred) : null;
  if (!a || !a.isConnected() || !a.supports(assetId)) a = pickAdapter(assetId);
  if (!a || typeof a.cancelBracket !== "function") return { ok: false, reason: "adapter não suporta cancelBracket" };
  return a.cancelBracket(assetId);
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
  getMode, isLive, isReal, verifyConnection, getBalance, getPositions,
  buy, sell, cancelBracket, isCrypto, assetClass, pickAdapter, explainRouting,
  estimateFee, roundTripFee, feeRate,
  registry,
};
