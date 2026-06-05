// src/brokers/binance.adapter.js
// Adaptador Binance — SÓ CRYPTO. API de trading com assinatura HMAC-SHA256.
// Usa a conta do utilizador (cria API key+secret em Binance → API Management).
// Comissões ~0,1% (menos com BNB). NÃO cobre ações/forex/commodities.
//
// Variáveis de ambiente:
//   BINANCE_API_KEY     — a API key
//   BINANCE_SECRET_KEY  — o secret
//   BINANCE_BASE_URL    — opcional; testnet = https://testnet.binance.vision
//                         produção (default) = https://api.binance.com
//
// Segurança: a Binance só executa ordens REAIS (não tem "paper" como a Alpaca).
// O testnet existe mas é separado. Por isso este adaptador só deve ser ativado
// quando QUISERES mesmo executar crypto real — em paper, usa a Alpaca.

const crypto = require("crypto");
const logger = require("../logger");

const API_KEY    = process.env.BINANCE_API_KEY;
const SECRET_KEY = process.env.BINANCE_SECRET_KEY;
const BASE_URL   = process.env.BINANCE_BASE_URL || "https://api.binance.com";

// asset id → par de trading Binance (todos contra USDT)
const SYMBOL_MAP = {
  btc: "BTCUSDT", eth: "ETHUSDT", bnb: "BNBUSDT", sol: "SOLUSDT",
  xrp: "XRPUSDT", doge: "DOGEUSDT", ada: "ADAUSDT", avax: "AVAXUSDT",
  dot: "DOTUSDT", link: "LINKUSDT",
};

function pair(assetId) { return SYMBOL_MAP[assetId] || null; }

// ── Assinatura HMAC para endpoints privados ──────────────────────────────────
function sign(queryString) {
  return crypto.createHmac("sha256", SECRET_KEY).update(queryString).digest("hex");
}

async function signedFetch(path, params = {}, method = "GET") {
  if (!API_KEY || !SECRET_KEY) throw new Error("BINANCE_API_KEY/SECRET_KEY não configurados");
  const qs = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 5000 }).toString();
  const sig = sign(qs);
  const url = `${BASE_URL}${path}?${qs}&signature=${sig}`;
  const r = await fetch(url, { method, headers: { "X-MBX-APIKEY": API_KEY } });
  const data = await r.json();
  if (!r.ok) throw new Error(`Binance [${r.status}] ${path}: ${data.msg || JSON.stringify(data)}`);
  return data;
}

// LOT_SIZE: a Binance exige quantidades arredondadas ao "step" de cada par.
// Cache dos filtros do exchangeInfo para arredondar corretamente.
let stepCache = {};
async function getStep(symbol) {
  if (stepCache[symbol]) return stepCache[symbol];
  const r = await fetch(`${BASE_URL}/api/v3/exchangeInfo?symbol=${symbol}`);
  const data = await r.json();
  const lot = data.symbols?.[0]?.filters?.find(f => f.filterType === "LOT_SIZE");
  const step = lot ? parseFloat(lot.stepSize) : 0.00001;
  stepCache[symbol] = step;
  return step;
}
function roundToStep(qty, step) {
  const precision = Math.max(0, Math.round(-Math.log10(step)));
  return Number((Math.floor(qty / step) * step).toFixed(precision));
}

module.exports = {
  id: "binance",
  name: "Binance",
  assetClasses: ["crypto"],

  supports(assetId) { return !!pair(assetId); },

  isConnected() { return !!(API_KEY && SECRET_KEY); },

  async verifyConnection() {
    if (!this.isConnected()) throw new Error("Binance não configurada — define BINANCE_API_KEY e BINANCE_SECRET_KEY");
    const acc = await signedFetch("/api/v3/account");
    const usdt = acc.balances?.find(b => b.asset === "USDT");
    const free = usdt ? parseFloat(usdt.free).toFixed(2) : "0.00";
    const testnet = BASE_URL.includes("testnet");
    logger.info(`  └ Binance ${testnet ? "TESTNET 🧪" : "LIVE 💵"} | USDT livre: $${free}`);
    return { ok: true, name: this.name, detail: { testnet, usdt: free } };
  },

  isLive() { return !BASE_URL.includes("testnet"); },

  async getBalance() {
    const acc = await signedFetch("/api/v3/account");
    const usdt = acc.balances?.find(b => b.asset === "USDT");
    return usdt ? parseFloat(usdt.free) : 0;
  },

  // Compra a mercado. Binance aceita quoteOrderQty (gastar X USDT) — ideal porque
  // o motor pensa em "€/$ a investir", não em unidades.
  async buy({ assetId, amount, price }) {
    const symbol = pair(assetId);
    if (!symbol) return { ok: false, reason: "unsupported_asset" };
    try {
      const order = await signedFetch("/api/v3/order", {
        symbol, side: "BUY", type: "MARKET",
        quoteOrderQty: amount.toFixed(2), // gasta este valor em USDT
      }, "POST");
      // fill médio: somatório dos fills / quantidade
      let fillPrice = price, qty = 0, cost = 0;
      (order.fills || []).forEach(f => { qty += parseFloat(f.qty); cost += parseFloat(f.qty) * parseFloat(f.price); });
      if (qty > 0) fillPrice = cost / qty;
      return { ok: true, fillPrice, brokerOrderId: String(order.orderId), simulated: false, filledUnits: qty };
    } catch (err) {
      logger.error(`[Binance] compra falhou (${symbol}): ${err.message}`);
      return { ok: false, reason: err.message };
    }
  },

  // Venda a mercado das unidades detidas (arredondadas ao LOT_SIZE).
  async sell({ assetId, units, price }) {
    const symbol = pair(assetId);
    if (!symbol) return { ok: false, reason: "unsupported_asset" };
    try {
      const step = await getStep(symbol);
      const qty  = roundToStep(units, step);
      if (qty <= 0) return { ok: false, reason: "qty_below_min" };
      const order = await signedFetch("/api/v3/order", {
        symbol, side: "SELL", type: "MARKET", quantity: qty,
      }, "POST");
      let fillPrice = price, q = 0, cost = 0;
      (order.fills || []).forEach(f => { q += parseFloat(f.qty); cost += parseFloat(f.qty) * parseFloat(f.price); });
      if (q > 0) fillPrice = cost / q;
      return { ok: true, fillPrice, simulated: false };
    } catch (err) {
      logger.error(`[Binance] venda falhou (${symbol}): ${err.message}`);
      return { ok: false, reason: err.message };
    }
  },
};
