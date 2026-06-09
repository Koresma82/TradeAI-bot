// src/brokers/alpaca.adapter.js
// Adaptador Alpaca — embrulha o src/alpaca.js existente no contrato comum.
// Cobre crypto + ações/ETFs US. Comissão $0 em ações; crypto com spread.

const logger = require("../logger");
const alpaca = require("../alpaca");

// IDs de crypto que a Alpaca negoceia (formato de ordem "BTC/USD").
const CRYPTO_IDS = new Set(["btc", "eth", "bnb", "sol", "xrp", "doge", "ada", "avax", "dot", "link"]);
// Ativos não-crypto que a Alpaca cobre via ETF/ticker (ver SYMBOL_MAP em alpaca.js).
const NON_CRYPTO_SUPPORTED = new Set([
  "spy", "qqq", "iwm", "gld", "tlt", "xle", "eem", "vti",
  "gold", "silver", "wti", "natgas", "copper",
]);

function isCrypto(assetId) { return CRYPTO_IDS.has(assetId); }

function orderSymbol(assetId) {
  const base = alpaca.getAlpacaSymbol(assetId); // ex.: BTCUSD, SPY, GLD
  return isCrypto(assetId) ? base.replace(/USD$/, "/USD") : base;
}

// ── Colisões de símbolo ──────────────────────────────────────────────────────
// Vários assetIds podem mapear para o MESMO símbolo da corretora (ex.: gold→GLD
// e gld→GLD). Em live isso corrompe a contabilidade: a Alpaca vê UMA posição GLD
// mas o bot julga ter duas. Detetamos isto e recusamos abrir a segunda em live.
const SUPPORTED_FOR_COLLISION = ["btc","eth","bnb","sol","xrp","doge","spy","qqq","iwm","gld","tlt","xle","eem","vti","gold","silver","wti","natgas","copper"];
function brokerSymbolKey(assetId) {
  // Normaliza para a posição real da corretora (sem o "/" do crypto).
  return orderSymbol(assetId).replace("/", "");
}
function collidesWith(assetId) {
  const key = brokerSymbolKey(assetId);
  return SUPPORTED_FOR_COLLISION.filter(id => id !== assetId && brokerSymbolKey(id) === key);
}

module.exports = {
  id: "alpaca",
  name: "Alpaca Markets",
  assetClasses: ["crypto", "etf", "stock", "commodity"],
  orderSymbol,
  brokerSymbolKey,
  collidesWith,

  supports(assetId) {
    return isCrypto(assetId) || NON_CRYPTO_SUPPORTED.has(assetId);
  },

  isConnected() { return alpaca.isConnected(); },

  async verifyConnection() {
    if (!alpaca.isConnected()) {
      throw new Error("Alpaca não configurada — define ALPACA_API_KEY e ALPACA_SECRET_KEY");
    }
    const acc  = await alpaca.getAccount();
    const live = alpaca.isLive();
    logger.info(`  └ Alpaca ${live ? "LIVE 💵" : "PAPER 📝"} | Conta: $${parseFloat(acc.portfolio_value).toFixed(2)} | Compra: $${parseFloat(acc.buying_power).toFixed(2)}`);
    return { ok: true, name: this.name, detail: { live, account: acc } };
  },

  isLive() { return alpaca.isLive(); },

  async getBalance() {
    const acc = await alpaca.getAccount();
    return parseFloat(acc.cash);
  },

  // Posições reais na corretora (para reconciliação no arranque).
  async getPositions() {
    try {
      const raw = await alpaca.getPositions();
      return (raw || []).map(p => ({
        symbol: p.symbol,
        qty:    parseFloat(p.qty),
        avgPrice: parseFloat(p.avg_entry_price),
        marketValue: parseFloat(p.market_value),
      }));
    } catch (err) {
      logger.warn(`[Alpaca] getPositions falhou: ${err.message}`);
      return null;
    }
  },

  async buy({ assetId, amount, price, sl, tp }) {
    const symbol = orderSymbol(assetId);
    // Fix 2: bloquear abertura se o símbolo colidir com outro ativo já mapeado.
    const col = collidesWith(assetId);
    if (col.length) {
      logger.error(`[Alpaca] BUY ${assetId} bloqueada: símbolo ${brokerSymbolKey(assetId)} colide com ${col.join(",")} — risco de contabilidade. Usa só um destes ativos em live.`);
      return { ok: false, reason: `symbol_collision:${col.join(",")}` };
    }
    if (!isCrypto(assetId)) {
      const open = await alpaca.isMarketOpen();
      if (!open) {
        logger.warn(`Mercado fechado para ${symbol} — ordem adiada`);
        return { ok: false, reason: "market_closed" };
      }
    }
    const qty = amount / price;
    try {
      const orderParams = { symbol, qty, side: "buy" };
      // Bracket (SL+TP nativo) só em ações; crypto é gerida pelo nosso motor.
      // Fix 5: em ações, o bracket da Alpaca passa a ser a ÚNICA autoridade de
      // SL/TP (o motor deixa de fechar estas — ver brokerHandlesSLTP no engine).
      if (!isCrypto(assetId)) { orderParams.takeProfit = tp; orderParams.stopLoss = sl; }
      const order = await alpaca.placeOrder(orderParams);
      // Fix 6: tentar confirmar o fill real; se a ordem ainda não preencheu,
      // sinaliza pending=true para o motor saber que o preço/units são provisórios.
      const filledPrice = order.filled_avg_price ? parseFloat(order.filled_avg_price) : null;
      const filledQty   = order.filled_qty ? parseFloat(order.filled_qty) : null;
      return {
        ok: true,
        fillPrice: filledPrice || price,
        filledQty: filledQty,                 // null se ainda não preencheu
        pending:   !filledPrice,              // true → preço/units provisórios
        brokerOrderId: order.id,
        brokerSymbol:  brokerSymbolKey(assetId),
        bracket:   !isCrypto(assetId),        // SL/TP geridos pela corretora
        simulated: false,
      };
    } catch (err) {
      logger.error(`[Alpaca] compra falhou (${symbol}): ${err.message}`);
      return { ok: false, reason: err.message };
    }
  },

  async sell({ assetId, units, price }) {
    const symbol = orderSymbol(assetId);
    try {
      // Fix 1: fechar pela QUANTIDADE da nossa posição (não a posição inteira do
      // símbolo, que poderia incluir outras), e capturar o preço REAL de fill.
      const closeSym = isCrypto(assetId) ? symbol.replace("/", "") : symbol;
      const order = await alpaca.closePositionQty(closeSym, units);
      const fillPrice = order?.filled_avg_price ? parseFloat(order.filled_avg_price) : (price || null);
      const filledQty = order?.filled_qty ? parseFloat(order.filled_qty) : null;
      return {
        ok: true,
        fillPrice: fillPrice || price,
        filledQty,
        pending: !order?.filled_avg_price,
        brokerOrderId: order?.id || null,
        simulated: false,
      };
    } catch (err) {
      logger.error(`[Alpaca] venda falhou (${symbol}): ${err.message}`);
      return { ok: false, reason: err.message };
    }
  },
};
