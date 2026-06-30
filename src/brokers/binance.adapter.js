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

// Filtros do par: a Binance exige (a) quantidade múltipla do "step" (LOT_SIZE),
// (b) quantidade ≥ minQty, e (c) valor da ordem ≥ minNotional (senão rejeita com
// -1013 "Filter failure: NOTIONAL"). Cache do exchangeInfo para validar ordens.
let filterCache = {};
async function getFilters(symbol) {
  if (filterCache[symbol]) return filterCache[symbol];
  const r = await fetch(`${BASE_URL}/api/v3/exchangeInfo?symbol=${symbol}`);
  const data = await r.json();
  const filters = data.symbols?.[0]?.filters || [];
  const lot = filters.find(f => f.filterType === "LOT_SIZE");
  const notional = filters.find(f => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");
  const out = {
    step:        lot ? parseFloat(lot.stepSize) : 0.00001,
    minQty:      lot ? parseFloat(lot.minQty)   : 0,
    minNotional: notional ? parseFloat(notional.minNotional ?? notional.notional ?? 0) : 0,
  };
  filterCache[symbol] = out;
  return out;
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
    const testnet = BASE_URL.includes("testnet");
    // Regista o MODO já, antes do saldo — assim aparece nos logs mesmo que a
    // chamada de saldo falhe (ex.: chaves erradas, conta testnet sem fundos).
    logger.info(`  └ Binance ${testnet ? "TESTNET 🧪" : "LIVE 💵"} | base=${BASE_URL}`);
    try {
      const acc = await signedFetch("/api/v3/account");
      const usdt = acc.balances?.find(b => b.asset === "USDT");
      const free = usdt ? parseFloat(usdt.free).toFixed(2) : "0.00";
      logger.info(`  └ Binance ${testnet ? "TESTNET 🧪" : "LIVE 💵"} ligado | USDT livre: $${free}`);
      return { ok: true, name: this.name, detail: { testnet, usdt: free } };
    } catch (e) {
      logger.warn(`  └ Binance ${testnet ? "TESTNET" : "LIVE"}: saldo falhou (${e.message}). Verifica as chaves ${testnet ? "do TESTNET (testnet.binance.vision)" : "de produção"} e se a conta tem USDT.`);
      throw e;
    }
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
      // Validar MIN_NOTIONAL antes de enviar: a Binance rejeita ordens cujo valor
      // (quoteOrderQty) seja inferior ao mínimo do par (tipicamente ~$5-10).
      // Falhar aqui com mensagem clara é melhor do que um -1013 críptico.
      const f = await getFilters(symbol);
      if (f.minNotional > 0 && amount < f.minNotional) {
        logger.warn(`[Binance] BUY ${symbol} ignorada: valor $${amount.toFixed(2)} < mínimo $${f.minNotional} (MIN_NOTIONAL)`);
        return { ok: false, reason: `below_min_notional:${f.minNotional}` };
      }
      const order = await signedFetch("/api/v3/order", {
        symbol, side: "BUY", type: "MARKET",
        quoteOrderQty: amount.toFixed(2), // gasta este valor em USDT
      }, "POST");
      // fill médio: somatório dos fills / quantidade
      let fillPrice = price, qty = 0, cost = 0;
      (order.fills || []).forEach(f => { qty += parseFloat(f.qty); cost += parseFloat(f.qty) * parseFloat(f.price); });
      if (qty > 0) fillPrice = cost / qty;
      // Devolve as unidades REAIS preenchidas — o motor deve guardar ESTAS (não
      // amount/price), senão tenta vender mais do que tem (dust preso). Crítico
      // porque a Binance cobra a comissão em unidades da própria crypto.
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
      const f   = await getFilters(symbol);
      const qty = roundToStep(units, f.step);
      if (qty <= 0 || (f.minQty > 0 && qty < f.minQty)) {
        // "Dust": a posição que sobra é tão pequena que fica abaixo do mínimo
        // vendável da Binance. Não dá erro — sinaliza para o motor poder fechar a
        // posição contabilisticamente (não vamos conseguir vender estas migalhas).
        logger.warn(`[Binance] SELL ${symbol}: ${units} → ${qty} abaixo do mínimo vendável (dust). Posição fechada contabilisticamente.`);
        return { ok: true, dust: true, fillPrice: price, filledUnits: 0, simulated: false };
      }
      // Validar também o MIN_NOTIONAL na venda (valor = qty × preço).
      if (f.minNotional > 0 && price && qty * price < f.minNotional) {
        logger.warn(`[Binance] SELL ${symbol}: valor $${(qty*price).toFixed(2)} < mínimo $${f.minNotional} (dust). Posição fechada contabilisticamente.`);
        return { ok: true, dust: true, fillPrice: price, filledUnits: 0, simulated: false };
      }
      const order = await signedFetch("/api/v3/order", {
        symbol, side: "SELL", type: "MARKET", quantity: qty,
      }, "POST");
      let fillPrice = price, q = 0, cost = 0;
      (order.fills || []).forEach(f => { q += parseFloat(f.qty); cost += parseFloat(f.qty) * parseFloat(f.price); });
      if (q > 0) fillPrice = cost / q;
      return { ok: true, fillPrice, filledUnits: q, simulated: false };
    } catch (err) {
      logger.error(`[Binance] venda falhou (${symbol}): ${err.message}`);
      return { ok: false, reason: err.message };
    }
  },
};
