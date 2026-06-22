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
//
// VETO DE TENDÊNCIA (correção do buraco da ADA, −83€ em 4 dias): por muito alto
// que seja o score de "queda + RSI baixo", NÃO compramos um ativo em tendência
// de baixa CLARA. Isto impede o padrão "apanhar a faca a cair" — recomprar um
// ativo dia após dia enquanto desce (queda + RSI baixo davam sempre sinal, e o
// SL batia sempre). Um ativo em queda continuada não está "barato", está a cair.
function buySignal(prices, { dropTrigger = 1.5, rsiOversold = 35, smaLong = 50 } = {}) {
  if (prices.length < 15) return { buy: false, reason: "histórico insuficiente", score: 0 };

  const drop   = dropFromHigh(prices);
  const r       = rsi(prices, 14);
  const maLong  = sma(prices, Math.min(smaLong, prices.length));
  const maShort = sma(prices, Math.min(10, prices.length));
  const last    = prices[prices.length - 1];

  // ── VETO: tendência de baixa estrutural ──
  // Considera-se "em queda" se: (a) o preço está abaixo da média longa E
  // (b) a média curta está abaixo da longa (as médias confirmam a descida) E
  // (c) o preço de hoje é menor que o de há ~5 períodos (continua a descer).
  // Estar sobrevendido (RSI baixo) numa tendência destas NÃO é oportunidade —
  // é o ativo a cair. Bloqueamos a compra independentemente do score.
  const ref5 = prices[Math.max(0, prices.length - 6)];
  const abaixoMM   = maLong  != null && last < maLong;
  const mmCruzada  = maLong  != null && maShort != null && maShort < maLong;
  const aDescer    = ref5 != null && last < ref5;
  const tendenciaBaixa = abaixoMM && mmCruzada && aDescer;
  if (tendenciaBaixa) {
    return { buy: false, score: 0, reason: "veto: tendência de baixa (não apanhar faca a cair)", rsi: r, vetoTrend: true };
  }

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

// ── Sinal de COMPRA por MOMENTUM / BREAKOUT ───────────────────────────────────
// A hipótese oposta ao buySignal (que compra QUEDAS / mean-reversion). Aqui
// compramos FORÇA: entrada quando o ativo está em tendência de ALTA confirmada.
// Em crypto, momentum historicamente bate mean-reversion — "comprar quedas" num
// mercado lateral/baixista é apanhar facas a cair (foi o que o backtest mostrou:
// todos os perfis negativos com a lógica de queda).
//
// Critérios (precisa de score >= 60, i.e. ≥2 dos 3):
//  1. Preço acima da MM longa E média curta acima da longa (tendência de alta)
//  2. Momento positivo: preço de hoje > preço de há ~`mom` períodos (a subir)
//  3. RSI numa zona de força mas não esticado (entre rsiLow e rsiHigh) — evita
//     comprar exatamente no topo sobrecomprado.
//
// VETO DE EXAUSTÃO: não compra se o RSI estiver > rsiHigh (sobrecomprado
// extremo) — entrar aí é comprar o topo. Simétrico ao veto de tendência do
// buySignal, mas para o lado oposto.
function momentumSignal(prices, { mom = 10, smaShort = 10, smaLong = 50, rsiLow = 50, rsiHigh = 72 } = {}) {
  if (prices.length < 15) return { buy: false, reason: "histórico insuficiente", score: 0 };

  const r       = rsi(prices, 14);
  const maLong  = sma(prices, Math.min(smaLong, prices.length));
  const maShort = sma(prices, Math.min(smaShort, prices.length));
  const last    = prices[prices.length - 1];
  const refMom  = prices[Math.max(0, prices.length - 1 - mom)];

  // ── VETO: sobrecompra extrema (não comprar o topo) ──
  if (r != null && r > rsiHigh) {
    return { buy: false, score: 0, reason: `veto: sobrecomprado (RSI ${r.toFixed(0)} > ${rsiHigh})`, rsi: r, vetoOverbought: true };
  }

  let score = 0;
  const reasons = [];

  // 1. Tendência de alta estrutural (preço acima da MM longa E curta > longa)
  const tendenciaAlta = maLong != null && maShort != null && last > maLong && maShort > maLong;
  if (tendenciaAlta) { score += 45; reasons.push("tendência de alta"); }

  // 2. Momento positivo (a subir vs há `mom` períodos)
  const aSubir = refMom != null && last > refMom;
  if (aSubir) { score += 30; reasons.push(`+momentum ${mom}d`); }

  // 3. RSI em zona de força (acima de rsiLow, abaixo do veto)
  if (r != null && r >= rsiLow) { score += 25; reasons.push(`RSI ${r.toFixed(0)}`); }

  return {
    buy:    score >= 60,
    score,
    reason: reasons.join(" + ") || "sem sinal",
    rsi:    r,
  };
}

module.exports = { sma, rsi, dropFromHigh, buySignal, momentumSignal };
