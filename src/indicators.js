// src/indicators.js
// Indicadores técnicos para deteção de sinal realista.
// Funções puras (sem efeitos) — fáceis de testar e raciocinar.

// Média móvel simples dos últimos `period` valores
function sma(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((s, p) => s + p, 0) / period;
}

// RSI (Relative Strength Index) — clássico de 14 períodos.
// < 30 = sobrevendido (possível compra), > 70 = sobrecomprado (possível venda).
function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  // Primeira média (período inicial)
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Queda percentual desde o máximo da janela
function dropFromHigh(prices) {
  if (!prices.length) return 0;
  const high = Math.max(...prices);
  const last = prices[prices.length - 1];
  return high > 0 ? ((high - last) / high) * 100 : 0;
}

// ── Sinal combinado de COMPRA ────────────────────────────────────────────────
// Recebe a série de preços (fecho, mais antigo→recente) e a config da estratégia.
// Devolve { buy: bool, reason: string, score: 0-100 } — score = força do sinal.
//
// Lógica (precisa de pelo menos 2 dos 3 critérios para comprar):
//  1. Queda desde o máximo >= o gatilho da estratégia (comprar na baixa)
//  2. RSI em sobrevenda (< limiar, default 35)
//  3. Preço acima da média longa (tendência de fundo ainda positiva)
function buySignal(prices, { dropTrigger = 1.5, rsiOversold = 35, smaLong = 50 } = {}) {
  if (prices.length < 15) return { buy: false, reason: "histórico insuficiente", score: 0 };

  const drop   = dropFromHigh(prices);
  const r       = rsi(prices, 14);
  const maLong  = sma(prices, Math.min(smaLong, prices.length));
  const last    = prices[prices.length - 1];

  let score = 0;
  const reasons = [];

  if (drop >= dropTrigger)            { score += 40; reasons.push(`queda ${drop.toFixed(1)}%`); }
  if (r != null && r < rsiOversold)   { score += 35; reasons.push(`RSI ${r.toFixed(0)}`); }
  if (maLong != null && last > maLong){ score += 25; reasons.push("acima da MM"); }

  // Precisa de pelo menos 2 critérios (score >= 60) para comprar
  return {
    buy:    score >= 60,
    score,
    reason: reasons.join(" + ") || "sem sinal",
    rsi:    r,
  };
}

module.exports = { sma, rsi, dropFromHigh, buySignal };
