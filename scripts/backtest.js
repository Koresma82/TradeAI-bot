#!/usr/bin/env node
// scripts/backtest.js
// ─────────────────────────────────────────────────────────────────────────────
// BACKTESTER do TradeAI — corre as TUAS regras de entrada/saída sobre HISTÓRICO
// real, para medires a EXPECTATIVA (€/trade) ANTES de arriscar em paper/live.
//
// Porquê: afinar parâmetros olhando para 11 dias de paper em tempo real é lento e
// estatisticamente fraco. Aqui simulas meses/anos em segundos. Reutiliza o MESMO
// indicators.js do bot (buySignal, sma, rsi) — por isso o que o backtest diz é o
// que o bot faria, não uma aproximação inventada.
//
// O QUE SIMULA (fiel ao sim-engine):
//   • Entrada: indicators.buySignal(serie, {dropTrigger, rsiOversold, smaLong})
//     com o MESMO veto de tendência de baixa.
//   • SL/TP por perfil × ajuste de categoria (Crypto 1.5×, ETF 0.7×, Forex 0.4×…)
//   • Custo de transação realista (comissão + slippage) por trade.
//   • Cooldown pós-perda por ativo (não recompra a faca a cair logo a seguir).
//   • Limite de posições simultâneas.
//
// O QUE NÃO SIMULA (e é honesto dizê-lo):
//   • Sinais do Groq/LLM — o backtest usa SÓ os indicadores técnicos. É de
//     propósito: os indicadores são reproduzíveis; o LLM não. Se quiseres provar
//     edge, tens de o ver nos indicadores. O LLM é, na melhor das hipóteses, um
//     filtro adicional — nunca a fonte do edge.
//   • Microestrutura intradiária (usa fechos diários). Bom para swing, não para
//     scalping de segundos.
//
// USO:
//   node scripts/backtest.js                      # perfil moderado, dados de exemplo
//   node scripts/backtest.js --perfil=scalper
//   node scripts/backtest.js --perfil=agressivo --custo=0.25 --data=./hist
//   node scripts/backtest.js --grid               # testa TODOS os perfis e compara
//   node scripts/backtest.js --fetch=btc,eth,spy  # baixa histórico real e corre
//
// FORMATO DOS DADOS (--data=PASTA): um ficheiro <id>.json por ativo, cada um:
//   { "id":"btc", "cat":"Crypto", "candles":[{"t":"2024-01-01","c":42000}, ...] }
// (só precisa de data + fecho. Mais antigo→recente.)
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");
const indicators = require("../src/indicators");

// ── Perfis (espelham os da app: sl, tp em %, compra = gatilho de queda) ────────
const PERFIS = {
  conservador: { sl: 4, tp: 8,  compra: 2.5, rsi: 30 },
  moderado:    { sl: 6, tp: 12, compra: 1.5, rsi: 35 },
  agressivo:   { sl: 9, tp: 18, compra: 0.8, rsi: 40 },
  scalper:     { sl: 3, tp: 4,  compra: 1.0, rsi: 35 },
  equilibrado: { sl: 5, tp: 6,  compra: 1.5, rsi: 35 },
  volatil:     { sl: 8, tp: 10, compra: 2.0, rsi: 35 },
};

// Ajuste de SL/TP/queda por categoria (igual ao catAjuste do sim-engine).
const CAT_AJUSTE = { Crypto: 1.5, Commodity: 1.0, ETF: 0.7, Forex: 0.4, "Ação": 1.1 };

// ── Args ──────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  })
);

const CUSTO_PCT = parseFloat(args.custo || "0.20"); // % round-trip: comissão+slippage
const MAX_POS   = parseInt(args.maxpos || "8", 10);  // posições simultâneas
const COOLDOWN  = parseInt(args.cooldown || "3", 10); // dias de cooldown pós-perda
const CAPITAL   = parseFloat(args.capital || "1000");
const VALOR     = parseFloat(args.valor || "100");   // € por trade (sizing fixo)
const LOGICA    = (args.logica || "queda").toLowerCase(); // "queda" (mean-rev) | "momentum"

// ── Simula UM perfil sobre um conjunto de séries ───────────────────────────────
// series: { id, cat, candles:[{t, c}] }
function simular(perfil, allSeries, logica = LOGICA) {
  const cfg = PERFIS[perfil];
  if (!cfg) throw new Error(`perfil desconhecido: ${perfil}`);

  const trades = [];           // { id, entryDate, exitDate, entry, exit, pnlPct, pnlEur, reason }
  const open   = {};           // posições abertas { id: {entry, entryIdx, sl, tp} }
  const lastLoss = {};         // cooldown pós-perda por ativo (índice da última perda)

  // Alinha todas as séries por data. Usamos um calendário-união ordenado.
  const datas = new Set();
  for (const s of allSeries) for (const c of s.candles) datas.add(c.t);
  const calendario = [...datas].sort();
  const idxByDate = Object.fromEntries(calendario.map((d, i) => [d, i]));

  // Preço de cada ativo por data (lookup rápido)
  const priceAt = {};
  for (const s of allSeries) {
    priceAt[s.id] = {};
    for (const c of s.candles) priceAt[s.id][c.t] = c.c;
  }

  // Avança dia a dia
  for (let di = 0; di < calendario.length; di++) {
    const hoje = calendario[di];

    // 1) Gerir posições abertas (SL/TP no fecho do dia)
    for (const id of Object.keys(open)) {
      const px = priceAt[id]?.[hoje];
      if (px == null) continue;
      const pos = open[id];
      let reason = null, exit = px;
      if (px <= pos.sl)      { reason = "SL"; exit = pos.sl; }
      else if (px >= pos.tp) { reason = "TP"; exit = pos.tp; }
      if (reason) {
        const pnlPct = ((exit - pos.entry) / pos.entry) * 100 - CUSTO_PCT;
        const pnlEur = VALOR * (pnlPct / 100);
        trades.push({ id, cat: pos.cat, entryDate: pos.entryDate, exitDate: hoje, entry: pos.entry, exit, pnlPct, pnlEur, reason });
        if (pnlEur < 0) lastLoss[id] = di;
        delete open[id];
      }
    }

    // 2) Procurar novas entradas (se houver vaga)
    if (Object.keys(open).length >= MAX_POS) continue;

    for (const s of allSeries) {
      if (open[s.id]) continue;                          // já tem posição
      if (Object.keys(open).length >= MAX_POS) break;
      if (di - (lastLoss[s.id] ?? -999) < COOLDOWN) continue; // cooldown pós-perda

      // Série de fechos até hoje (inclusive)
      const serie = s.candles.filter(c => c.t <= hoje).map(c => c.c);
      if (serie.length < 15) continue;

      // Ajuste de categoria (igual ao sim-engine)
      const fator = CAT_AJUSTE[s.cat] ?? 1.0;
      const dropAdj = +(cfg.compra * fator).toFixed(2);
      const slPct   = +(cfg.sl * fator).toFixed(2);
      const tpPct   = +(cfg.tp * fator).toFixed(2);

      // O MESMO buySignal do bot (com veto de tendência de baixa)
      // ou a variante MOMENTUM, conforme --logica.
      let sig;
      if (logica === "momentum") {
        sig = indicators.momentumSignal(serie, { mom: 10, smaShort: 10, smaLong: 50, rsiLow: 50, rsiHigh: 72 });
      } else {
        sig = indicators.buySignal(serie, {
          dropTrigger: dropAdj,
          rsiOversold: cfg.rsi,
          smaLong: 50,
        });
      }
      if (!sig.buy) continue;

      const px = priceAt[s.id][hoje];
      open[s.id] = {
        cat: s.cat, entry: px, entryDate: hoje,
        sl: +(px * (1 - slPct / 100)),
        tp: +(px * (1 + tpPct / 100)),
      };
    }
  }

  // Fechar posições ainda abertas no fim (mark-to-market ao último preço)
  for (const id of Object.keys(open)) {
    const pos = open[id];
    const last = pos.entry; // sem fecho — conta como break-even-ish; melhor ignorar
    // (não contamos no P&L para não inflacionar; marcamos como "aberta no fim")
  }

  return analisar(perfil, trades, Object.keys(open).length);
}

// ── Estatística da simulação ───────────────────────────────────────────────────
function analisar(perfil, trades, abertasNoFim) {
  const n = trades.length;
  if (n === 0) {
    return { perfil, n: 0, abertasNoFim, pnlTotal: 0, expectancy: 0, winRate: 0,
             profitFactor: 0, maxDD: 0, sharpe: 0, wins: 0, losses: 0 };
  }
  const wins   = trades.filter(t => t.pnlEur > 0);
  const losses = trades.filter(t => t.pnlEur <= 0);
  const pnlTotal = trades.reduce((s, t) => s + t.pnlEur, 0);
  const grossWin  = wins.reduce((s, t) => s + t.pnlEur, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlEur, 0));
  const expectancy = pnlTotal / n;
  const winRate = (wins.length / n) * 100;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  // Curva de capital + max drawdown
  let equity = CAPITAL, peak = CAPITAL, maxDD = 0;
  const rets = [];
  for (const t of trades) {
    equity += t.pnlEur;
    rets.push(t.pnlEur);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  // Sharpe simplificado (por-trade, anualização ignorada — comparativo entre perfis)
  const mean = rets.reduce((s, r) => s + r, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / n) || 1;
  const sharpe = mean / sd;

  return {
    perfil, n, abertasNoFim, pnlTotal, expectancy, winRate, profitFactor,
    maxDD, sharpe, wins: wins.length, losses: losses.length,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    melhor: trades.reduce((m, t) => t.pnlEur > (m?.pnlEur ?? -Infinity) ? t : m, null),
    pior:   trades.reduce((m, t) => t.pnlEur < (m?.pnlEur ??  Infinity) ? t : m, null),
  };
}

// ── Impressão ──────────────────────────────────────────────────────────────────
const fmt = (v, d = 2) => (v >= 0 ? "+" : "") + v.toFixed(d);
function imprimir(r) {
  if (r.n === 0) { console.log(`  ${r.perfil.padEnd(12)} → 0 trades gerados (parâmetros muito restritivos ou histórico curto)`); return; }
  const pf = r.profitFactor === Infinity ? "∞" : r.profitFactor.toFixed(2);
  const verd = r.expectancy > 0.05 ? "✅ POSITIVA" : r.expectancy > -0.05 ? "≈ neutra" : "❌ NEGATIVA";
  console.log(`  ${r.perfil.padEnd(12)} │ ${String(r.n).padStart(4)} trades │ exp ${fmt(r.expectancy).padStart(7)}€/t │ WR ${r.winRate.toFixed(0).padStart(2)}% │ PF ${pf.padStart(4)} │ DD ${r.maxDD.toFixed(0).padStart(2)}% │ P&L ${fmt(r.pnlTotal).padStart(8)}€ │ ${verd}`);
}

// ── Loader de dados ────────────────────────────────────────────────────────────
function carregarPasta(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  return files.map(f => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    return { id: j.id, cat: j.cat || "Crypto", candles: j.candles };
  });
}

// Dados sintéticos de exemplo (random-walk com regimes), só para demonstrar o motor
// quando ainda não tens histórico real. NÃO uses para decidir — usa --fetch ou --data.
function dadosExemplo() {
  function walk(id, cat, base, vol, n = 400, drift = 0) {
    const candles = []; let p = base;
    const start = new Date("2024-01-01");
    for (let i = 0; i < n; i++) {
      // regimes alternados: 80 dias alta, 80 baixa…
      const regime = Math.sin(i / 80) * 0.0008;
      p *= 1 + drift + regime + (Math.random() - 0.5) * vol;
      const d = new Date(start); d.setDate(d.getDate() + i);
      candles.push({ t: d.toISOString().slice(0, 10), c: +p.toFixed(p > 100 ? 2 : 4) });
    }
    return { id, cat, candles };
  }
  return [
    walk("btc", "Crypto", 42000, 0.035),
    walk("eth", "Crypto", 2300, 0.04),
    walk("sol", "Crypto", 95, 0.05),
    walk("spy", "ETF", 470, 0.012, 400, 0.0003),
    walk("gold", "Commodity", 2050, 0.011),
    walk("eurusd", "Forex", 1.09, 0.005),
  ];
}

// ── fetch de histórico real (Binance p/ crypto — domínio data-api.binance.vision)
async function fetchBinance(symbol, dias = 365) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1d&limit=${dias}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${r.status} para ${symbol}`);
  const rows = await r.json();
  return rows.map(k => ({ t: new Date(k[0]).toISOString().slice(0, 10), c: parseFloat(k[4]) }));
}

const FETCH_MAP = {
  btc: ["BTCUSDT", "Crypto"], eth: ["ETHUSDT", "Crypto"], sol: ["SOLUSDT", "Crypto"],
  xrp: ["XRPUSDT", "Crypto"], ada: ["ADAUSDT", "Crypto"], bnb: ["BNBUSDT", "Crypto"],
  doge: ["DOGEUSDT", "Crypto"], avax: ["AVAXUSDT", "Crypto"], dot: ["DOTUSDT", "Crypto"],
  link: ["LINKUSDT", "Crypto"],
};

// Ativos não-crypto via Stooq (CSV diário, sem API key). Mapeia id → [símbolo stooq, categoria].
const STOOQ_MAP = {
  // ETFs (.us)
  spy: ["spy.us", "ETF"], qqq: ["qqq.us", "ETF"], gld: ["gld.us", "ETF"],
  iwm: ["iwm.us", "ETF"], tlt: ["tlt.us", "ETF"], xle: ["xle.us", "ETF"],
  // Commodities (futuros)
  wti: ["cl.f", "Commodity"], gold: ["gc.f", "Commodity"], silver: ["si.f", "Commodity"],
  // Forex
  eurusd: ["eurusd", "Forex"], gbpusd: ["gbpusd", "Forex"], usdjpy: ["usdjpy", "Forex"],
};

// Stooq devolve CSV: Date,Open,High,Low,Close,Volume. Usamos só Date + Close.
async function fetchStooq(symbol, dias = 365) {
  const url = `https://stooq.com/q/d/l/?s=${symbol}&i=d`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Stooq ${r.status} para ${symbol}`);
  const csv = await r.text();
  if (!csv || csv.startsWith("<") || !csv.includes(",")) throw new Error(`Stooq sem dados para ${symbol}`);
  const linhas = csv.trim().split("\n").slice(1); // tira header
  const candles = linhas.map(l => {
    const cols = l.split(",");
    return { t: cols[0], c: parseFloat(cols[4]) };
  }).filter(c => c.t && !isNaN(c.c));
  // Stooq dá histórico longo; cortamos aos últimos `dias`.
  return candles.slice(-dias);
}

async function carregarFetch(ids, dias) {
  const out = [];
  for (const id of ids) {
    const key = id.toLowerCase();
    const crypto = FETCH_MAP[key];
    const stooq  = STOOQ_MAP[key];
    try {
      let candles, cat;
      if (crypto) {
        candles = await fetchBinance(crypto[0], dias); cat = crypto[1];
      } else if (stooq) {
        candles = await fetchStooq(stooq[0], dias); cat = stooq[1];
      } else {
        console.log(`  ⚠ ${id}: sem fonte conhecida (crypto via Binance, resto via Stooq)`); continue;
      }
      if (!candles.length) { console.log(`  ✗ ${id}: 0 candles devolvidos`); continue; }
      out.push({ id, cat, candles });
      console.log(`  ✓ ${id} (${cat}): ${candles.length} candles (${candles[0].t} → ${candles[candles.length-1].t})`);
    } catch (e) { console.log(`  ✗ ${id}: ${e.message}`); }
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  console.log("\n╔═══════════════════════════════════════════════════════════════════════════╗");
  console.log("║  BACKTESTER TradeAI — expectativa real das tuas regras sobre histórico     ║");
  console.log("╚═══════════════════════════════════════════════════════════════════════════╝\n");

  let series;
  if (args.fetch) {
    const ids = String(args.fetch).split(",").map(s => s.trim());
    const dias = parseInt(args.dias || "365", 10);
    console.log(`Baixando histórico real (${dias}d) via Binance:`);
    series = await carregarFetch(ids, dias);
    if (!series.length) { console.log("\nSem dados. Aborto.\n"); process.exit(1); }
  } else if (args.data) {
    series = carregarPasta(String(args.data));
    console.log(`Carregados ${series.length} ativos de ${args.data}`);
  } else {
    series = dadosExemplo();
    console.log("⚠ A usar DADOS SINTÉTICOS de exemplo (random-walk). Só para ver o motor.");
    console.log("  Para resultados reais: --fetch=btc,eth,sol  ou  --data=./pasta_historico\n");
  }

  const periodo = (() => {
    const ds = series.flatMap(s => s.candles.map(c => c.t)).sort();
    return `${ds[0]} → ${ds[ds.length-1]}  (${new Set(ds).size} dias)`;
  })();
  console.log(`\nPeríodo: ${periodo}`);
  console.log(`Lógica de entrada: ${LOGICA === "momentum" ? "MOMENTUM (comprar força)" : "QUEDA (mean-reversion — a atual do bot)"}`);
  console.log(`Parâmetros: custo ${CUSTO_PCT}%/trade · max ${MAX_POS} posições · cooldown ${COOLDOWN}d · €${VALOR}/trade · capital €${CAPITAL}\n`);
  console.log("─".repeat(79));

  if (args.compara) {
    // Corre as DUAS lógicas (queda vs momentum) lado a lado, por perfil.
    console.log("COMPARAÇÃO — QUEDA (mean-reversion) vs MOMENTUM (comprar força):\n");
    const perfis = Object.keys(PERFIS);
    console.log("  " + "perfil".padEnd(12) + " │ " + "QUEDA (exp €/t · WR · PF)".padEnd(30) + " │ MOMENTUM (exp €/t · WR · PF)");
    console.log("  " + "─".repeat(74));
    let bestMom = null, bestQueda = null;
    for (const p of perfis) {
      const rq = simular(p, series, "queda");
      const rm = simular(p, series, "momentum");
      const cell = (r) => r.n === 0 ? "sem trades".padEnd(28)
        : `${fmt(r.expectancy).padStart(6)}€ · ${r.winRate.toFixed(0).padStart(2)}% · PF ${(r.profitFactor === Infinity ? "∞" : r.profitFactor.toFixed(2)).padStart(4)}`.padEnd(28);
      console.log(`  ${p.padEnd(12)} │ ${cell(rq)} │ ${cell(rm)}`);
      if (rq.n && (!bestQueda || rq.expectancy > bestQueda.expectancy)) bestQueda = { ...rq, perfil: p };
      if (rm.n && (!bestMom   || rm.expectancy > bestMom.expectancy))   bestMom   = { ...rm, perfil: p };
    }
    console.log("\n" + "─".repeat(79));
    if (bestQueda) console.log(`QUEDA    → melhor: ${bestQueda.perfil} (${fmt(bestQueda.expectancy)}€/trade, ${bestQueda.n} trades)`);
    if (bestMom)   console.log(`MOMENTUM → melhor: ${bestMom.perfil} (${fmt(bestMom.expectancy)}€/trade, ${bestMom.n} trades)`);
    const vencedor = (bestMom?.expectancy ?? -Infinity) > (bestQueda?.expectancy ?? -Infinity) ? "MOMENTUM" : "QUEDA";
    const venc = vencedor === "MOMENTUM" ? bestMom : bestQueda;
    console.log(`\n🏆 Lógica vencedora: ${vencedor} (${venc ? fmt(venc.expectancy) + "€/trade no perfil " + venc.perfil : "—"})`);
    if (venc && venc.expectancy > 0.05) {
      console.log(`\n✅ A lógica ${vencedor} tem expectativa POSITIVA — vale a pena implementá-la no bot.`);
    } else {
      console.log(`\n⚠ Mesmo a melhor lógica continua sem expectativa positiva clara neste histórico.`);
      console.log(`  Próximo passo: testar outros parâmetros (mom, smaLong) ou filtros de regime.`);
    }
  } else if (args.grid) {
    console.log("GRID — todos os perfis comparados nas MESMAS condições:\n");
    const resultados = Object.keys(PERFIS).map(p => simular(p, series));
    resultados.sort((a, b) => b.expectancy - a.expectancy);
    resultados.forEach(imprimir);
    console.log("\n" + "─".repeat(79));
    const best = resultados[0];
    console.log(`\n🏆 Melhor expectativa: ${best.perfil} (${fmt(best.expectancy)}€/trade)`);
    const positivos = resultados.filter(r => r.expectancy > 0.05);
    if (!positivos.length) {
      console.log("\n⚠ NENHUM perfil tem expectativa positiva neste histórico.");
      console.log("  Isto é o sinal mais importante: as regras de ENTRADA não têm edge.");
      console.log("  Antes de live, é preciso mudar a LÓGICA de entrada/saída, não só os parâmetros.");
    }
  } else {
    const perfil = args.perfil || "moderado";
    const r = simular(perfil, series);
    console.log(`PERFIL: ${perfil}\n`);
    imprimir(r);
    if (r.n > 0) {
      console.log("\nDetalhe:");
      console.log(`  Trades ganhos:  ${r.wins}  (média ${fmt(r.avgWin)}€)`);
      console.log(`  Trades perdidos:${r.losses}  (média ${fmt(-r.avgLoss)}€)`);
      console.log(`  Profit factor:  ${r.profitFactor === Infinity ? "∞" : r.profitFactor.toFixed(2)}  (>1 = lucrativo, >1.5 = bom)`);
      console.log(`  Max drawdown:   ${r.maxDD.toFixed(1)}%  (maior queda do pico)`);
      console.log(`  Sharpe/trade:   ${r.sharpe.toFixed(3)}  (>0 bom, >0.1 muito bom)`);
      if (r.melhor) console.log(`  Melhor trade:   ${r.melhor.id} ${fmt(r.melhor.pnlEur)}€ (${r.melhor.reason})`);
      if (r.pior)   console.log(`  Pior trade:     ${r.pior.id} ${fmt(r.pior.pnlEur)}€ (${r.pior.reason})`);
      console.log(`  Posições abertas no fim: ${r.abertasNoFim} (não contadas no P&L)`);
    }
  }
  console.log("\n" + "─".repeat(79));
  console.log("Nota: o backtest usa SÓ indicadores técnicos (sem Groq). É de propósito —");
  console.log("se há edge, tem de aparecer aqui. O LLM só pode FILTRAR, nunca criar edge.\n");
})();
