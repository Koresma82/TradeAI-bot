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
const dcaEngine = require("./dca-engine");
const newsSentiment = require("./news-sentiment");
const broker  = require("./broker");
const { notify, queueOpen, tg } = require("./telegram");

// Publica um evento no tab Mensagens da app (via Firestore logs/{dia}).
// Não bloqueia o tick — falhas são silenciosas. level: buy|sell|warn|error|info.
function logEvent(level, msg) {
  fb.appendLog("server", { level, msg }).catch(() => {});
}

// Calcula estatísticas históricas por ativo a partir do dailySeries (90 dias de
// fechos que o bot já tem) e publica-as no Firestore para a app mostrar nos
// cartões de Mercados. Sem chamadas novas a APIs — reusa dados existentes.
function publishPriceStats() {
  try {
    const stats = {};
    for (const [id, serie] of Object.entries(dailySeries)) {
      if (!Array.isArray(serie) || serie.length < 2) continue;
      const max90 = Math.max(...serie);
      const min90 = Math.min(...serie);
      const media = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
      const semana = media(serie.slice(-7));   // média dos últimos 7 dias
      const mes    = media(serie.slice(-30));   // média dos últimos 30 dias
      stats[id] = {
        max90: +max90.toFixed(6), min90: +min90.toFixed(6),
        avgWeek: semana != null ? +semana.toFixed(6) : null,
        avgMonth: mes != null ? +mes.toFixed(6) : null,
        dias: serie.length,
      };
    }
    if (Object.keys(stats).length) {
      fb.saveSetting("server", "priceStats", { stats, ts: Date.now() }).catch(() => {});
      logger.info(`📊 Estatísticas de preço publicadas (${Object.keys(stats).length} ativos)`);
    }
  } catch (e) { logger.warn(`publishPriceStats falhou: ${e.message}`); }
}

const uid = () => require("crypto").randomUUID();

// ── Estado em memória ─────────────────────────────────────────────────────────
let strategies    = [];
let openPositions = {};  // { posId: { ...position } }
let priceHistory  = {};  // { assetId: [{ price, ts }] } — intradiário (curto prazo)
let dailySeries   = {};  // { assetId: [fechos diários] } — para indicadores (RSI/MM)
let noPriceWarned = {};  // { assetId: ts } — controlo de avisos "sem preço"
let lastBuyTime   = {};  // cooldown por estratégia/ativo
let lastLossTime  = {};  // cooldown pós-perda por ativo (mais longo após um SL)
let lastRotAt     = 0;   // timestamp da última ROTAÇÃO (throttle anti-microtrading)
let botPaused     = false; // pausa de novas entradas (toggle na app; SL/TP continua)
let tickCount     = 0;
let totalInvested = 0;
let dailyLossHit  = false;
// ── Controlo de escritas ao Firestore (poupar quota/custos) ──────────────────
let lastSimLiveJson    = "";   // último simLive escrito (só reescreve se mudar)
let lastSimLiveAt      = 0;    // timestamp da última escrita de simLive
let lastHeartbeatAt    = 0;    // timestamp do último botStatus escrito
let brokerReportCache  = [];   // relatório por broker (capacidades + saldo), cacheado
let lastBrokerReportAt = 0;    // quando foi atualizado pela última vez
let lastFeaturesJson   = "";   // últimas features escritas no botStatus
const SIMLIVE_MIN_MS   = 60 * 1000;       // no máx. 1 escrita de simLive por minuto
const PRICES_PUB_MS    = 2 * 60 * 1000;   // publica preços p/ a app a cada 2 min
let lastPricesAt       = 0;
let lastPricesJson     = "";   // último marketPrices publicado (só reescreve se mudar)
const HEARTBEAT_MS     = 2 * 60 * 1000;   // heartbeat a cada 2 min (app exige < 3 min)
let lastBrokerBalJson  = "";   // últimos brokerBalances escritos (só reescreve se mudar)
let lastBrokerBalAt    = 0;    // timestamp da última leitura de saldos da corretora
const BROKERBAL_MS     = 5 * 60 * 1000;   // lê saldos da corretora no máx. a cada 5 min
// Definições lidas do Firestore (a app controla isto)
let appSettings   = {
  maxEstrategias: 5,
  maxManuais: 5,           // limite de posições abertas por compras manuais
  maxAiBrain: 3,           // limite SÓ para o Cérebro AI (separado das estratégias)
  riscoPerfil: "moderado",
  modoValor: "fixo",
  rotacaoAtiva: false,
  rotacaoMinPct: 1,        // lucro mínimo (%) para a rotação disparar (evita microtrading)
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
  maxValorTrade: 100,      // teto ABSOLUTO em € por trade (independente do saldo)
  maxPosicoesTotal: 40,    // limite GLOBAL de posições abertas ao mesmo tempo
  scaleOutTP: false,       // TP parcial desligado por defeito
  scaleOutPct: 50,
  // Ajuste de SL/TP/queda por CATEGORIA de ativo. O perfil global dá os valores
  // base; estes multiplicadores adaptam-nos à volatilidade típica de cada classe.
  // Ex.: perfil SL 6% × crypto 1.5 = SL 9% para crypto; × forex 0.4 = SL 2.4%.
  // 1.0 = usa o valor do perfil tal e qual. Editável na app.
  catAjuste: {
    Crypto:    1.5,
    Commodity: 1.0,
    ETF:       0.7,
    Forex:     0.4,
    Ação:      1.1,
  },
  // Valor (€) e teto (€) por trade SEPARADOS por origem. Cada origem pode ter o
  // seu próprio valor fixo e teto; 0/null/ausente = herda o global (valorFixo /
  // maxValorTrade). Isto permite, ex.: estratégias €50, AI €30, day-trade €20.
  perOrigem: {
    estrategias: { valorFixo: 0, maxValorTrade: 0 },
    aibrain:     { valorFixo: 0, maxValorTrade: 0 },
    daytrading:  { valorFixo: 0, maxValorTrade: 0 },
    manual:      { valorFixo: 0, maxValorTrade: 0 },
  },
  // ── Modo dinâmico por regime de mercado ──────────────────────────────────
  // Quando ligado, o bot REDUZ exposição e APERTA entradas automaticamente em
  // regime de baixa (BTC e SPY ambos abaixo da MM50 e a descer). Não mexe em
  // SL/TP (isso seria curve-fitting). Os limites do utilizador são o TETO; o
  // modo dinâmico só os reduz, nunca aumenta. Sempre visível e desligável.
  regimeDinamico: false,   // interruptor mestre (off = limites fixos de sempre)
  // ── Camada de notícias (independente do modo dinâmico técnico) ────────────
  // Quando ligado, o sentiment de notícias (news-sentiment.js) ajusta a
  // EXPOSIÇÃO (nº de posições, € por trade, confiança exigida) dentro dos tetos.
  // NUNCA mexe em SL/TP. Clima negativo aperta; clima positivo afrouxa até 1.0.
  newsTilt: false,
  // ── DCA (núcleo passivo) — defaults; sobrepostos pelas settings da app ──
  dcaAtivo: true, aiTradeAtivo: false, dcaPctCapital: 80,
  // Controlo granular do trading ativo (null = herda aiTradeAtivo p/ retrocompat).
  // aiBrainMestre = chave-mestra (opção C): nada de trading ativo sem ele ON.
  aiBrainMestre: false, aiEstrategias: false, aiManualAutonomo: false, aiDayTrading: false,
  // ── DCA multi-plano ──
  dcaValorMensal: 100,        // o "bolo" por período repartido pelos planos
  dcaPlanos: [],              // [{ id, nome, carteira, alocacao, frequencia, ... }]
  dcaAiTradePct: 20,          // % do capital reservado ao trading ativo
  dcaAiTradeValor: 0,         // OU € fixo (>0 sobrepõe a %)
  dcaValorPeriodico: 50, dcaFrequencia: "semanal", dcaCarteira: [],
  dcaReequilibrar: true, dcaDerivaPct: 5, dcaProximaCompra: null,
};
// Estado do regime de mercado (recalculado periodicamente, não a cada tick).
let regimeAtual    = "neutro";   // "alta" | "neutro" | "baixa"
let regimeDetalhe  = "";          // texto explicativo p/ app e logs
let lastRegimeAt   = 0;
const REGIME_MS    = 10 * 60 * 1000; // reavalia o regime a cada 10 min
let dtConfig = null; // config de day trading lida da app (dtState)
let newsFeed = null; // { headlines:[], manualBias?, manualLabel? } lido de settings/newsFeed
let simBalance    = parseFloat(process.env.SIM_CAPITAL || "1000");
let simCapital    = simBalance;
// Ativos negociáveis: derivados da lista do prices.js (fonte única de verdade).
// Todos têm fonte de preço real (CoinGecko ou Stooq), por isso o bot consegue
// mesmo negociá-los. A app lê esta lista publicada no Firestore.
const TRADEABLE = new Set(prices.ASSETS.map(a => a.id));

// ── Helpers ───────────────────────────────────────────────────────────────────
const sign = v => v >= 0 ? "+" : "−";

// ── Regime de mercado ─────────────────────────────────────────────────────────
// Deteta o "humor" do mercado a partir de dois sinais INDEPENDENTES: BTC (cripto)
// e SPY (ações). Usar dois reduz falsos positivos — um dip só do BTC não dispara
// o modo defensivo. Critério por ativo (sobre os fechos diários):
//   • abaixo da MM50  → preço < média móvel de 50 dias (tendência de fundo fraca)
//   • a descer        → fecho de hoje < fecho de há ~5 dias
// Regime:
//   • "baixa"  → AMBOS (BTC e SPY) abaixo da MM50 e a descer  → reduzir risco
//   • "alta"   → AMBOS acima da MM50 e a subir                → normal/favorável
//   • "neutro" → tudo o resto (sinais mistos)                 → cautela ligeira
// Só recalcula a cada REGIME_MS (não a cada tick) — é uma leitura de fundo, não
// de tick. Resultado guardado em regimeAtual/regimeDetalhe (visível na app).
function avaliaRegime() {
  const lerAtivo = (id) => {
    const serie = dailySeries[id] || [];
    if (serie.length < 20) return null; // histórico insuficiente → ignora este sinal
    const ma = indicators.sma(serie, Math.min(50, serie.length));
    const last = serie[serie.length - 1];
    const ref = serie[Math.max(0, serie.length - 6)];
    if (ma == null) return null;
    return { abaixoMM: last < ma, aDescer: last < ref, acimaMM: last > ma, aSubir: last > ref };
  };
  const btc = lerAtivo("btc");
  const spy = lerAtivo("spy");
  // Se não temos os dois sinais, não arriscamos uma leitura — fica neutro.
  if (!btc || !spy) {
    regimeAtual = "neutro";
    regimeDetalhe = "histórico insuficiente para avaliar regime";
    return;
  }
  const baixa = (btc.abaixoMM && btc.aDescer) && (spy.abaixoMM && spy.aDescer);
  const alta  = (btc.acimaMM  && btc.aSubir)  && (spy.acimaMM  && spy.aSubir);
  if (baixa)      { regimeAtual = "baixa";  regimeDetalhe = "BTC e SPY abaixo da MM50 e a descer — modo defensivo"; }
  else if (alta)  { regimeAtual = "alta";   regimeDetalhe = "BTC e SPY acima da MM50 e a subir — condições favoráveis"; }
  else            { regimeAtual = "neutro"; regimeDetalhe = "sinais mistos entre cripto e ações"; }
}

// Multiplicadores de EXPOSIÇÃO por regime. Aplicam-se SÓ para REDUZIR (≤ 1.0):
// o utilizador define o teto; o regime só aperta. Base matemática: numa queda,
// reduzir o nº de posições e o valor por trade baixa a perda esperada por dia
// proporcionalmente, sem precisar de prever nada. Em alta, mantém-se (1.0) — não
// aumentamos além do que o utilizador definiu. Bónus à confiança AI em baixa:
// exigir sinais mais fortes filtra as entradas marginais que mais perdem.
//
// CAMADA DE NOTÍCIAS: se newsTilt estiver ligado, o sentiment de notícias
// (news-sentiment.js) acrescenta um VIÉS de exposição — mas só ajusta QUANTO se
// arrisca, nunca os níveis de SL/TP. Um clima muito negativo aperta ainda mais;
// um clima muito positivo pode afrouxar até (no máximo) ao TETO técnico de 1.0 —
// nunca acima, porque "a IA está otimista" não autoriza arriscar mais do que o
// utilizador definiu. Direção é do mercado; tamanho é do risco.
function regimeFatores() {
  // Base técnica do regime.
  let base;
  if (!appSettings.regimeDinamico) {
    base = { posicoes: 1.0, valor: 1.0, confExtra: 0, regime: "fixo" };
  } else {
    switch (regimeAtual) {
      case "baixa":
        // Defensivo: metade das posições simultâneas, 60% do valor por trade, e
        // +8 pontos de confiança mínima exigida ao AI-Brain/estratégias.
        base = { posicoes: 0.5, valor: 0.6, confExtra: 8, regime: "baixa" }; break;
      case "alta":
        base = { posicoes: 1.0, valor: 1.0, confExtra: 0, regime: "alta" }; break;
      default: // neutro: cautela ligeira
        base = { posicoes: 0.8, valor: 0.9, confExtra: 3, regime: "neutro" };
    }
  }

  // Camada de notícias (opcional, independente do modo dinâmico técnico).
  if (appSettings.newsTilt) {
    const nf = newsSentiment.fatores();
    // Combina multiplicando, depois faz CLAMP ao teto técnico de 1.0: o viés
    // positivo das notícias só pode RECUPERAR a exposição que o regime apertou,
    // nunca ultrapassar 1.0 (o teto do utilizador). O viés negativo aperta livre.
    base = {
      posicoes: Math.min(1.0, +(base.posicoes * nf.posicoes).toFixed(3)),
      valor:    Math.min(1.0, +(base.valor    * nf.valor).toFixed(3)),
      confExtra: base.confExtra + nf.confExtra,
      regime: base.regime,
      newsBias: nf.bias, newsLabel: nf.label,
    };
  }
  return base;
}

// Aplica o fator de exposição a um limite de Nº de posições (arredonda para baixo,
// mas nunca abaixo de 1 se o limite original era ≥ 1 — não queremos parar tudo).
function limitePosicoes(base) {
  const f = regimeFatores().posicoes;
  const n = Math.floor(Number(base) * f);
  return Number(base) >= 1 ? Math.max(1, n) : n;
}
// Aplica o fator de valor a um valor (€) por trade.
function valorAjustado(base) {
  return +(Number(base) * regimeFatores().valor).toFixed(2);
}
// Confiança mínima efetiva (base + extra do regime), nunca acima de 95.
function confMinima(base) {
  return Math.min(95, Number(base) + regimeFatores().confExtra);
}

// "Carimbo" do regime no momento da abertura de um trade, para gravar no próprio
// trade. Assim a comparação "com vs sem modo dinâmico" é DIRETA (filtra trades
// por este campo) e não depende de cruzar datas com o registo de liga/desliga.
//   regimeDinamico: o modo dinâmico estava ligado quando o trade abriu?
//   regimeEstado:   que regime estava ativo ("alta"/"neutro"/"baixa"/"fixo")
function regimeSnapshot() {
  return {
    regimeDinamico: !!appSettings.regimeDinamico,
    regimeEstado:   appSettings.regimeDinamico ? regimeAtual : "fixo",
  };
}
const eur  = v => `€${Math.abs(v).toFixed(2)}`;

// Categorias por ativo (para saber se o mercado está aberto)
const ASSET_CAT = Object.fromEntries(prices.ASSETS.map(a => [a.id, a.cat]));

// Devolve o fator de ajuste de SL/TP/queda para a categoria de um ativo.
// O perfil global dá o valor base; aqui multiplica-se pela volatilidade típica
// da classe. Crypto mexe muito (SL/TP largos), forex pouco (apertados).
function catFactor(assetId) {
  const cat = ASSET_CAT[assetId];
  const m = (appSettings.catAjuste || {})[cat];
  return (typeof m === "number" && m > 0) ? m : 1.0;
}
// SL/TP/queda efetivos para um ativo: valor do perfil × fator da categoria.
// clamps para evitar valores absurdos (SL/TP entre 0.3% e 60%, queda 0.1%-15%).
function adjustedRisk(assetId, baseSl, baseTp, baseDrop) {
  const f = catFactor(assetId);
  const sl   = Math.min(60, Math.max(0.3, baseSl  * f));
  const tp   = Math.min(60, Math.max(0.3, baseTp  * f));
  const drop = baseDrop == null ? null : Math.min(15, Math.max(0.1, baseDrop * f));
  return { sl, tp, drop, factor: f };
}

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
    // Posições DCA são HOLD passivo — sem SL/TP, NUNCA fechadas por esta lógica.
    // O motor DCA (dca-engine.js) é que as gere (compra/reequilíbrio). Saltar aqui
    // é o que mantém o núcleo passivo intocado pelo trading ativo.
    if (pos.stratId === "dca") continue;

    // Só geримос com preço REAL e fresco. Um preço "seed" (base estático) ou
    // stale não pode disparar SL/TP/AI-EXIT — senão comparávamos a entrada real
    // com um preço fantasma e fechávamos a posição ao valor errado.
    const price = prices.isReal(pos.assetId) ? currentPrices[pos.assetId]?.price : null;
    if (!price) {
      // Posição aberta sem preço REAL atual (fonte falhou, preço só em base, ou
      // ativo removido). Não a perdemos — fica aberta e gerida assim que voltar
      // um preço fresco de feed. Avisa 1x por hora para não encher os logs.
      const k = `nopx_${pos.assetId}`;
      if (!noPriceWarned[k] || Date.now() - noPriceWarned[k] > 3600000) {
        logger.warn(`⚠ Sem preço real fresco para ${pos.assetSym || pos.assetId} (posição aberta continua segura, à espera de preço de feed)`);
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

    // Fix 5: se a corretora gere SL/TP desta posição (bracket nativo em ações),
    // o motor NÃO mexe — quem fecha é a corretora. Evita o duplo-fecho (bot +
    // bracket) que resultaria numa venda a descoberto. A reconciliação no
    // arranque/periódica deteta quando o bracket fechou a posição.
    if (pos.brokerSLTP) continue;

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
    // AI-EXIT BIDIRECIONAL (corrige a assimetria ganho/perda):
    //   • EM LUCRO  → realiza o ganho (como antes), mas só se o lucro LÍQUIDO
    //                 (após comissões) tiver margem mínima — evita "ganhar" no
    //                 papel mas perder nas taxas (sobretudo cripto a 0.25%/lado).
    //   • EM PERDA  → CORTA a perda mais cedo. Antes, uma posição perdedora só
    //                 saía no SL completo (−3%), enquanto as vencedoras saíam a
    //                 +0.4% → ganho médio +0.40€ vs perda média −3.00€ (rácio 1:7).
    //                 Agora, se a IA vira para VENDER com confiança ALTA, fechamos
    //                 a meio da queda em vez de esperar o SL — reduz a perda média.
    // Para cortar perdas exigimos confiança MAIOR (flipConf + margem) do que para
    // realizar lucros, porque fechar no vermelho é uma decisão mais cara: só o
    // fazemos quando o sinal de reversão é forte, não a qualquer hesitação da IA.
    const sg = aiSignals.getSignal(pos.assetId);
    const rtFee = broker.roundTripFee(pos.assetId, pos.amount); // comissão compra+venda (€)
    const lucroLiquidoSeFechar = (price - pos.entryPrice) * pos.units - rtFee;
    const margem = pos.amount * 0.0010;                  // 0.10% de margem mínima
    const emLucro = lucroLiquidoSeFechar >= margem;       // lucro líq. acima da margem
    const conf = sg?.confianca || 0;
    const cutLossConf = Math.min(95, flipConf + 7);       // exige sinal mais forte p/ cortar perda
    const aiVende = !onHold && podeAiExit && exitOnFlip && sg && sg.sinal === "VENDER";
    if (aiVende && emLucro && conf >= flipConf && price > pos.sl) {
      // Realiza lucro: a IA virou e estamos no verde com margem.
      reason = "AI-EXIT"; closePrice = price;
    }
    else if (aiVende && !emLucro && conf >= cutLossConf && price > pos.sl) {
      // Corta perda: a IA virou com confiança ALTA e a posição está no vermelho.
      // Sair aqui (acima do SL) perde MENOS do que esperar o SL completo.
      reason = "AI-CUT"; closePrice = price;
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
      // O TP só fecha se o lucro líquido (após comissões) for positivo com margem.
      // Em TPs largos (12%) isto passa sempre; em TPs apertados (scalper/ajuste
      // baixo) evita "ganhar" no TP mas perder depois das taxas. NÃO afeta o SL.
      const feeTP = broker.roundTripFee(pos.assetId, pos.amount);
      const liqTP = (price - pos.entryPrice) * pos.units - feeTP;
      if (liqTP < (pos.amount * 0.0010)) {
        // ainda não cobre taxas + margem → não fecha, deixa o preço subir mais
        continue;
      }
      // ── TAKE-PROFIT PARCIAL (scale-out) — opcional, melhora retorno ────────
      // Em vez de "tudo ou nada" no TP, vende uma fração (default 50%) e deixa
      // o resto correr com o SL movido para break-even (entryPrice). Captura
      // lucro garantido e mantém exposição ao upside. Só em crypto (não mexe
      // em posições com bracket nativo) e só uma vez por posição.
      const scaleOn = appSettings.scaleOutTP === true && !pos.brokerSLTP && !pos.scaledOut;
      if (scaleOn) {
        const frac = Math.min(0.9, Math.max(0.1, (appSettings.scaleOutPct ?? 50) / 100));
        const sellUnits = +(pos.units * frac).toFixed(7);
        let partialClose = Math.max(price, pos.tp);
        if (broker.isLive()) {
          const exec = await broker.sell({ assetId: pos.assetId, units: sellUnits, price: partialClose, broker: pos.broker, hadBracket: false });
          if (!exec.ok) { logger.warn(`Scale-out ${pos.assetSym} falhou: ${exec.reason}`); /* tenta fecho normal abaixo */ }
          else if (typeof exec.fillPrice === "number" && exec.fillPrice > 0) partialClose = exec.fillPrice;
        }
        const soldAmount = pos.amount * frac;
        const feeP = broker.roundTripFee(pos.assetId, soldAmount);
        const pnlP = +(((partialClose - pos.entryPrice) * sellUnits) - feeP).toFixed(4);
        // Atualiza a posição: fica com o restante e SL em break-even.
        pos.units  = +(pos.units - sellUnits).toFixed(7);
        pos.amount = +(pos.amount - soldAmount).toFixed(2);
        pos.sl     = Math.max(pos.sl, pos.entryPrice); // protege o lucro já feito
        pos.tp     = +(pos.tp * (1 + ((appSettings.takeProfitPadrao || 12) / 100))).toFixed(6); // novo alvo mais alto
        pos.scaledOut = true;
        totalInvested = Math.max(0, totalInvested - soldAmount);
        simBalance = +(simBalance + soldAmount + pnlP).toFixed(2);
        await fb.updateTrade("server", posId, { units: pos.units, amount: pos.amount, sl: pos.sl, tp: pos.tp, scaledOut: true, partialPnl: pnlP }).catch(() => {});
        await fb.saveBalance("server", simBalance);
        stats.addClosedTrade({ ...pos, id: `${posId}_p`, units: sellUnits, amount: soldAmount, status: "TP-PARCIAL", closePrice: partialClose, pnl: pnlP, fee: feeP, closedTs: Date.now() });
        logger.info(`📊 TP parcial ${pos.assetSym}: vendeu ${(frac*100).toFixed(0)}% (+${eur(pnlP)}), resto corre com SL em break-even`);
        await notify(`📊 *TP parcial* ${pos.assetSym}\nVendido ${(frac*100).toFixed(0)}% · +${eur(pnlP)}\nResto a correr (SL em break-even)`).catch(() => {});
        continue; // não fecha tudo — o resto continua aberto
      }
      reason = "TP";
      closePrice = Math.max(price, pos.tp); // idem: preço real, não o TP teórico
    }

    if (!reason) continue;

    // ── Executar a venda real na Alpaca se em modo live ──
    if (broker.isLive()) {
      const exec = await broker.sell({ assetId: pos.assetId, units: pos.units, price: closePrice, broker: pos.broker, hadBracket: !!pos.brokerSLTP });
      if (!exec.ok) {
        logger.warn(`Venda ${pos.assetSym} falhou: ${exec.reason} — tenta no próximo tick`);
        continue; // não fecha localmente se a corretora recusou
      }
      // Fix 1: usar o preço REAL de execução para o P&L (não o teórico).
      if (typeof exec.fillPrice === "number" && exec.fillPrice > 0) closePrice = exec.fillPrice;
    }

    // P&L LÍQUIDO: lucro bruto menos comissões ida-e-volta. Em sim isto torna o
    // resultado realista (igual ao paper/real); em ações/ETF a comissão é 0.
    const pnlBruto = (closePrice - pos.entryPrice) * pos.units;
    const fee = broker.roundTripFee(pos.assetId, pos.amount);
    const pnl = +(pnlBruto - fee).toFixed(4);
    const icon = pnl >= 0 ? "✅" : "🛑";

    logger.info(`${icon} ${reason} ${pos.assetSym} | P&L ${sign(pnl)}${eur(pnl)}${fee > 0 ? ` (após €${fee.toFixed(2)} comissão)` : ""}`);

    const closedTs = Date.now();
    const closedTrade = {
      ...pos,
      status:    reason,
      closePrice,
      closedAt:  new Date().toLocaleString("pt-PT"),
      closedTs,
      fee,
      pnlBruto: +pnlBruto.toFixed(4),
      pnl,
    };

    // Remove posição + devolve saldo (líquido de comissões)
    delete openPositions[posId];
    totalInvested = Math.max(0, totalInvested - pos.amount);
    simBalance    = +(simBalance + pos.amount + pnl).toFixed(2);

    // Cooldown pós-perda: se fechámos a perder (SL), regista para impor uma
    // pausa MAIOR antes de reentrar neste ativo. Evita o "apanhar a faca a cair"
    // — reentrar repetidamente num ativo em queda livre (o padrão SOL/XRP).
    if (pnl < 0) lastLossTime[pos.assetId] = Date.now();

    // Guarda no Firestore
    await fb.updateTrade("server", posId, { status: reason, closePrice, pnl, fee, pnlBruto: closedTrade.pnlBruto, closedAt: closedTrade.closedAt, closedTs });
    await fb.saveBalance("server", simBalance);
    stats.addClosedTrade(closedTrade);
    dailyLossHit = stats.checkDailyLossLimit();

    // Log colorido para localizar vendas facilmente nos logs do Railway.
    const pct = pos.entryPrice ? ((closePrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
    const linha = `💰 VENDA [${reason}] ${pos.assetSym} | P&L ${pnl >= 0 ? "+" : ""}€${pnl.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) | $${pos.entryPrice} → $${closePrice}`;
    if (pnl >= 0) logger.win(linha); else logger.loss(linha);
    logEvent("sell", linha);

    await notify(tg.tradeClose(closedTrade, pnl, reason, broker.getMode()));
  }
}

// ── Sugestão de quantia a investir — perfil de risco + confiança + saldo ──────
// Espelha a lógica da app. Em sim usa o saldo da simulação; em paper/live usaria
// o saldo do broker (via broker.getBalance, mas mantemos simples e seguro aqui).
function suggestAmount(assetId, confianca, strategy, origem) {
  const avail = simBalance;
  if (!avail || avail <= 0) return strategy.perTrade || 10;

  // Valor e teto por ORIGEM (estrategias/aibrain/daytrading/manual). Se a origem
  // não tiver valor próprio (0/null), herda o global. Permite afinar cada motor.
  const po = (appSettings.perOrigem || {})[origem] || {};
  const valOrigem = Number(po.valorFixo) > 0 ? Number(po.valorFixo) : null;
  const tetoOrigem = Number(po.maxValorTrade) > 0 ? Number(po.maxValorTrade) : null;

  // Teto ABSOLUTO em € por trade: origem (se definido) senão global. 0/vazio = sem teto.
  const tetoCfg = tetoOrigem != null ? tetoOrigem : Number(appSettings.maxValorTrade);
  const tetoAbs = (Number.isFinite(tetoCfg) && tetoCfg > 0) ? tetoCfg : Infinity;

  // Modo "fixo": valor da origem > valor da estratégia > valorFixo global.
  if (appSettings.modoValor !== "percentagem") {
    const base = valOrigem != null ? valOrigem : (strategy.perTrade || appSettings.valorFixo || 10);
    // valorAjustado() reduz o valor por trade em regime de baixa (modo dinâmico).
    return Math.min(valorAjustado(base), avail, tetoAbs);
  }

  // Modo "% da Banca": dimensiona pelo perfil de risco + confiança + saldo.
  const PERFIL = {
    conservador: { teto: 0.10, base: 0.04 },
    scalper:     { teto: 0.12, base: 0.05 },
    moderado:    { teto: 0.20, base: 0.08 },
    equilibrado: { teto: 0.18, base: 0.07 },
    volatil:     { teto: 0.22, base: 0.09 },
    agressivo:   { teto: 0.33, base: 0.14 },
  };
  const cfg = PERFIL[appSettings.riscoPerfil] || PERFIL.moderado;
  const c = Math.max(0, Math.min(100, confianca || 0));
  const mult = c >= 90 ? 2.0 : c >= 80 ? 1.5 : c >= 70 ? 1.1 : c >= 60 ? 0.8 : 0.5;
  const pctBase = (appSettings.percentagem || 3) / 100;
  let amount = avail * pctBase * mult;
  amount = Math.min(amount, avail * cfg.teto);
  amount = Math.max(10, Math.min(amount, avail, tetoAbs)); // ← teto absoluto aplicado aqui
  // valorAjustado() reduz o valor por trade em regime de baixa (modo dinâmico).
  return +valorAjustado(amount).toFixed(2);
}

// ── Executar compra simulada ──────────────────────────────────────────────────
async function executeBuy(strategy, assetId, price, confianca) {
  // Travão de segurança: nunca abrir a um preço fantasma (base estático/stale).
  // Se o preço passado não é real e fresco, não abre — protege contra entradas
  // a valores irreais quando as fontes de preço falham.
  if (!prices.isReal(assetId)) {
    logger.warn(`Compra ${assetId} ignorada: sem preço real fresco (a evitar entrada a preço fantasma)`);
    return;
  }
  // Quantia: por perfil+confiança+saldo se modoInvestimento="auto", senão fixo.
  // Origem para sizing por-origem: manual vs estratégia (o AI-Brain chama
  // suggestAmount diretamente com "aibrain"; o day-trade tem o seu próprio fluxo).
  const origem = strategy.id === "manual" ? "manual" : "estrategias";
  const sized  = suggestAmount(assetId, confianca, strategy, origem);
  // sized já vem com o teto aplicado por suggestAmount; aqui só reforçamos se
  // houver teto configurado (0/vazio = sem teto).
  const tetoCfg2 = Number(appSettings.maxValorTrade);
  const amount = (Number.isFinite(tetoCfg2) && tetoCfg2 > 0) ? Math.min(sized, tetoCfg2) : sized;

  if (simBalance < amount) {
    logger.warn(`Saldo insuficiente: €${simBalance} < €${amount}`);
    return;
  }
  // Teto da fatia AI Trade: o trading ativo não pode invadir o capital reservado
  // aos planos DCA. Se a compra excede a reserva disponível, não abre.
  if (aiTradeSaldoDisponivel() < amount) {
    logger.warn(`Fatia AI Trade esgotada (€${aiTradeSaldoDisponivel().toFixed(2)} < €${amount}) — compra de estratégia ignorada para proteger o DCA`);
    return;
  }
  // Limite GLOBAL de posições abertas do TRADING ATIVO (todas as origens menos
  // DCA). As posições DCA são HOLD passivo com a sua própria fatia de capital —
  // não devem consumir o orçamento de posições do trading ativo, senão o DCA, ao
  // ir acumulando, bloquearia as entradas ativas.
  const maxTotal = Number(appSettings.maxPosicoesTotal);
  const ativasNaoDca = Object.values(openPositions).filter(p => p.stratId !== "dca").length;
  if (Number.isFinite(maxTotal) && maxTotal > 0 && ativasNaoDca >= maxTotal) {
    logger.warn(`Limite global de ${maxTotal} posições ativas atingido — compra ignorada`);
    return;
  }
  if (totalInvested + amount > parseFloat(process.env.MAX_TOTAL_EUR || simCapital)) {
    logger.warn(`Limite total atingido`);
    return;
  }
  if (dailyLossHit) { logger.warn("Limite perda diária atingido — bloqueado"); return; }

  // Limite de posições de estratégia (só conta estratégias — AI-Brain, manual e
  // day-trade têm os seus próprios limites e não roubam vagas às estratégias).
  // limitePosicoes() reduz este teto em regime de baixa (modo dinâmico).
  const maxStrat = limitePosicoes(appSettings.maxEstrategias || 5);
  const stratPositions = Object.values(openPositions).filter(
    p => p.stratId !== "manual" && p.stratId !== "daytrading" && p.stratId !== "ai-brain" && p.stratId !== "dca"
  );
  if (stratPositions.length >= maxStrat) {
    if (!appSettings.rotacaoAtiva) {
      // Limite cheio, rotação desligada → não compra
      return;
    }
    // Throttle global de rotações: no máximo 1 rotação por ROT_COOLDOWN_MIN (def. 5
    // min). Sem isto, vários sinais no mesmo tick podiam disparar uma cascata de
    // rotações (abre/fecha em série) — a assinatura dos 424 trades/dia. A trava é
    // sobre o ATO de rodar, independente do ativo: evita o ciclo de microtrading.
    const rotCdMs = (parseInt(process.env.ROT_COOLDOWN_MIN || "5", 10)) * 60000;
    if (Date.now() - lastRotAt < rotCdMs) {
      return; // rodou há pouco — não roda outra vez já
    }
    // ── ROTAÇÃO: vender a posição com mais lucro LÍQUIDO para abrir esta ──
    let bestWinner = null, bestNet = -Infinity, bestCur = 0, bestFee = 0;
    for (const pos of stratPositions) {
      const cur = prices.getFreshPrice(pos.assetId);
      if (!cur) continue; // sem preço real fresco → não avalia esta posição
      const fee = broker.roundTripFee(pos.assetId, pos.amount);
      const net = (cur - pos.entryPrice) * pos.units - fee;
      if (net > bestNet) { bestNet = net; bestWinner = pos; bestCur = cur; bestFee = fee; }
    }
    // Só roda se a melhor posição der um lucro LÍQUIDO MÍNIMO significativo.
    // Antes rodava com qualquer lucro > 0 (até +€0.01), causando um ciclo de
    // microtrading (abre/fecha/reabre sem parar = spam + comissões à toa).
    // Agora exige pelo menos ROT_MIN_PCT% do valor investido (defeito 1%).
    const rotMinPct = Number(appSettings.rotacaoMinPct ?? process.env.ROT_MIN_PCT ?? 1);
    const minGanho = bestWinner ? (bestWinner.amount * rotMinPct / 100) : 0;
    if (!bestWinner || bestNet < minGanho) {
      return; // nenhuma posição com lucro suficiente para justificar a rotação
    }
    // Marca o throttle ASSIM que decidimos rodar (antes de qualquer await), para
    // que ticks concorrentes não disparem outra rotação em paralelo.
    lastRotAt = Date.now();
    // Põe o ativo VENDIDO em cooldown de reentrada — impede o vai-e-vem de o
    // recomprar no tick seguinte (rodava-o para fora e voltava a entrar nele).
    lastBuyTime[`${bestWinner.stratId}_${bestWinner.assetId}`] = Date.now();
    // Fechar o vencedor (P&L líquido de comissões)
    const cur = bestCur;
    const bestPnl = +bestNet.toFixed(4);
    const bestBruto = +((bestCur - bestWinner.entryPrice) * bestWinner.units).toFixed(4);
    delete openPositions[bestWinner.id];
    totalInvested = Math.max(0, totalInvested - bestWinner.amount);
    simBalance = +(simBalance + bestWinner.amount + bestPnl).toFixed(2);
    const rotClosedTs = Date.now();
    await fb.updateTrade("server", bestWinner.id, { status: "ROTACAO", closePrice: cur, pnl: bestPnl, fee: bestFee, pnlBruto: bestBruto, closedAt: new Date().toLocaleString("pt-PT"), closedTs: rotClosedTs });
    await fb.saveBalance("server", simBalance);
    stats.addClosedTrade({ ...bestWinner, status: "ROTACAO", closePrice: cur, pnl: bestPnl, fee: bestFee, pnlBruto: bestBruto, closedTs: rotClosedTs });
    logger.win(`🔄 ROTAÇÃO: fechado ${bestWinner.assetSym} (líq. +€${bestPnl.toFixed(2)}${bestFee>0?`, após €${bestFee.toFixed(2)} comissão`:""}) para abrir ${assetId}`);
  }

  const units = +(amount / price).toFixed(7);
  // Ajuste por categoria: o SL/TP da estratégia é escalado pela volatilidade da
  // classe do ativo (ex.: crypto mais largo, forex mais apertado).
  const adj   = adjustedRisk(assetId, strategy.sl, strategy.tp, null);
  const dp    = assetId === "eurusd" || ASSET_CAT[assetId] === "Forex" ? 5 : 4;
  const sl    = +(price * (1 - adj.sl / 100)).toFixed(dp);
  const tp    = +(price * (1 + adj.tp / 100)).toFixed(dp);
  const posId = `${broker.isLive() ? "live" : "sim"}_${Date.now()}_${assetId}`;

  // Fix 3 (atomicidade): em LIVE, gravamos primeiro um registo PENDING no
  // Firestore ANTES de chamar a corretora. Se o bot crashar entre a ordem e a
  // gravação final, fica um rasto recuperável (PENDING) em vez de uma posição
  // real invisível. Em sim não é preciso (não há ordem externa a perder).
  if (broker.isLive()) {
    await fb.saveTrade("server", {
      id: posId, assetId, assetName: assetId, assetSym: assetId.toUpperCase(),
      entryPrice: price, units, amount, sl, tp,
      strategy: strategy.nome, stratId: strategy.id,
      openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(),
      status: "PENDING", mode: "live",
    }).catch(e => logger.warn(`Pré-registo PENDING falhou: ${e.message}`));
  }

  // ── Executar a ordem (real na Alpaca se MODE=paper/real; senão simulada) ──
  const exec = await broker.buy({ assetId, amount, price, sl, tp });
  if (!exec.ok) {
    logger.warn(`Compra ${assetId} não executada: ${exec.reason}`);
    // Limpar o registo PENDING que criámos (a ordem não foi aceite) — apagar em
    // vez de marcar CANCELADA, para não poluir o histórico com ordens que nunca abriram.
    if (broker.isLive()) await fb.deleteTrade("server", posId).catch(() => {});
    return;
  }
  // Fix 1/6: preço e unidades REAIS de execução. Se a corretora confirmou uma
  // quantidade preenchida, usamo-la; senão derivamos do fill price.
  const fillPrice = exec.fillPrice || price;
  const brokerFilled = (typeof exec.filledQty === "number" ? exec.filledQty
                      : typeof exec.filledUnits === "number" ? exec.filledUnits
                      : null);
  const realUnits = (typeof brokerFilled === "number" && brokerFilled > 0)
    ? brokerFilled
    : +(amount / fillPrice).toFixed(7);

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
    brokerSymbol: exec.brokerSymbol || null,
    // Fix 5: se a corretora gere SL/TP nativamente (bracket em ações), o nosso
    // motor NÃO deve também fechar — senão disparam os dois (venda a descoberto).
    brokerSLTP:  !!exec.bracket,
    pendingFill: !!exec.pending, // fill provisório; reconciliação confirma depois
    ...regimeSnapshot(),         // carimbo do regime de mercado na abertura
  };

  openPositions[posId] = position;
  totalInvested += amount;
  simBalance     = +(simBalance - amount).toFixed(2);

  // Guarda no Firestore — a app React vê em tempo real
  await fb.saveTrade("server", position);
  await fb.saveBalance("server", simBalance);
  queueOpen({ ...position, origemLabel: "🎯 Estratégias" }, broker.getMode());

  const _mBuy = `🛒 BUY ${assetId.toUpperCase()} | €${amount} @$${fillPrice} | SL $${sl} TP $${tp}`;
  logger.buy(_mBuy); logEvent("buy", _mBuy);
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
  // Anti-duplicado: se já há um day-trade aberto neste ativo, não abrir outro.
  // (Evitava o spam de abrir o mesmo ativo a cada scan enquanto o sinal se mantém.)
  if (Object.values(openPositions).some(p => p.assetId === assetId && p.stratId === "daytrading")) return false;
  // Valor e teto por origem (day-trade). Valor fixo da origem (se definido)
  // sobrepõe o sugerido pela IA; teto da origem senão o global.
  const poDt = (appSettings.perOrigem || {}).daytrading || {};
  const valDt = Number(poDt.valorFixo) > 0 ? Number(poDt.valorFixo) : null;
  const tetoDtCfg = Number(poDt.maxValorTrade) > 0 ? Number(poDt.maxValorTrade) : Number(appSettings.maxValorTrade);
  let amt = valDt != null ? valDt : amount;
  if (Number.isFinite(tetoDtCfg) && tetoDtCfg > 0) amt = Math.min(amt, tetoDtCfg);
  if (simBalance < amt) return false;
  if (aiTradeSaldoDisponivel() < amt) {
    logger.warn(`Fatia AI Trade esgotada — day-trade ${assetSym} ignorado (protege o DCA)`);
    return false;
  }
  const maxTotDt = Number(appSettings.maxPosicoesTotal);
  if (Number.isFinite(maxTotDt) && maxTotDt > 0 && Object.values(openPositions).filter(p => p.stratId !== "dca").length >= maxTotDt) {
    logger.warn(`Limite global de posições atingido — day-trade ${assetSym} ignorado`);
    return false;
  }
  if (totalInvested + amt > parseFloat(process.env.MAX_TOTAL_EUR || simCapital)) return false;

  const units = +(amt / price).toFixed(7);
  const posId = `${broker.isLive() ? "live" : "sim"}_dt_${Date.now()}_${assetId}`;

  // Em LIVE, pré-registo PENDING antes da ordem (atomicidade — rasto recuperável).
  if (broker.isLive()) {
    await fb.saveTrade("server", {
      id: posId, assetId, assetName, assetSym,
      entryPrice: price, units, amount: amt, sl, tp,
      strategy: `⚡ DayTrade${confianca ? ` (${confianca}%)` : ""}`, stratId: "daytrading",
      openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(),
      status: "PENDING", mode: "live",
    }).catch(e => logger.warn(`Pré-registo PENDING (day-trade) falhou: ${e.message}`));
  }

  // Executar a ordem (real na Alpaca se paper/real; simulada em sim).
  const exec = await broker.buy({ assetId, amount: amt, price, sl, tp });
  if (!exec.ok) {
    logger.warn(`Day-trade ${assetSym} não executado: ${exec.reason}`);
    if (broker.isLive()) await fb.deleteTrade("server", posId).catch(() => {});
    return false;
  }
  const fillPrice = exec.fillPrice || price;
  const realUnits = (typeof exec.filledQty === "number" && exec.filledQty > 0) ? exec.filledQty : units;

  const position = {
    id: posId, assetId, assetName, assetSym,
    entryPrice: fillPrice, units: realUnits, amount: amt, peak: fillPrice, sl, tp,
    strategy: `⚡ DayTrade${confianca ? ` (${confianca}%)` : ""}${previsao ? ` — ${String(previsao).slice(0,40)}` : ""}`,
    stratId: "daytrading",
    openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(), status: "ABERTA",
    mode: broker.isLive() ? "live" : "sim",
    brokerOrderId: exec.brokerOrderId || null, broker: exec.broker || null,
    brokerSLTP: !!exec.bracket, pendingFill: !!exec.pending,
    ...regimeSnapshot(),         // carimbo do regime de mercado na abertura
  };
  openPositions[posId] = position;
  totalInvested += amt;
  simBalance = +(simBalance - amt).toFixed(2);

  await fb.saveTrade("server", position);
  await fb.saveBalance("server", simBalance);
  queueOpen({ ...position, confianca, origemLabel: "⚡ Day Trading" }, broker.getMode());
  const _mDt = `⚡ DAYTRADE ${assetId.toUpperCase()} | €${amt} @$${fillPrice} | conf ${confianca}%`;
  logger.buy(_mDt); logEvent("buy", _mDt);
  return true;
}


const aiBrainCooldown = {}; // { assetId: ts }
async function runAiBrain(currentPrices) {
  if (!appSettings.aiBrain || dailyLossHit) return;
  // confMinima() sobe a confiança exigida em regime de baixa (filtra entradas marginais).
  const minConf  = confMinima(appSettings.aiBrainConfianca || 78);
  const maxStrat = appSettings.maxEstrategias || 5;
  const slPct    = appSettings.stopLossPadrao || 6;
  const tpPct    = appSettings.takeProfitPadrao || 12;

  // Fonte de sinais: normalmente o Groq. Mas o Groq free-tier esgota e entra em
  // rate-limit — e era isso que deixava o AI-Brain (e o Day Trading) sem fazer
  // NADA, só sobrando as estratégias. FALLBACK: quando o Groq está indisponível,
  // o AI-Brain age por INDICADORES TÉCNICOS locais (o mesmo motor das estratégias).
  // Assim continua a operar sem depender de uma API instável.
  let sigs = aiSignals.getSignals();
  const groqHealth = aiSignals.getGroqHealth();
  const usingFallback = !groqHealth.ok || !sigs || Object.keys(sigs).length === 0;
  if (usingFallback) {
    sigs = {};
    for (const id of TRADEABLE) {
      const pd = currentPrices[id];
      if (!pd?.price) continue;
      const daily = dailySeries[id] || [];
      if (daily.length < 15) continue; // sem histórico não há sinal técnico fiável
      const serie = [...daily.slice(-89), pd.price];
      const tech = indicators.buySignal(serie, { dropTrigger: 1.5, rsiOversold: 35, smaLong: 50 });
      if (tech.buy) {
        // Converte o "score" técnico (0-100) em confiança equivalente do AI-Brain.
        sigs[id] = { id, sinal: "COMPRAR", confianca: tech.score, razao: `técnico: ${tech.reason}`, ts: Date.now(), _fallback: true };
      }
    }
    if (Object.keys(sigs).length && tickCount % 10 === 0) {
      logger.info(`🤖 AI-Brain em FALLBACK técnico (Groq ${groqHealth.rateLimited ? "rate-limited" : "indisponível"}): ${Object.keys(sigs).length} sinal(is)`);
    }
  }

  for (const sg of Object.values(sigs)) {
    if (!sg || sg.sinal !== "COMPRAR" || (sg.confianca || 0) < minConf) continue;
    // Limite global de posições abertas (0/vazio = sem limite)
    const maxTotAi = Number(appSettings.maxPosicoesTotal);
    if (Number.isFinite(maxTotAi) && maxTotAi > 0 && Object.values(openPositions).filter(p => p.stratId !== "dca").length >= maxTotAi) break;
    if (!TRADEABLE.has(sg.id)) continue;
    // Não abrir em mercado fechado (evita flip-flop a preços congelados)
    if (!isMarketOpenFor(sg.id)) continue;
    const pd = currentPrices[sg.id];
    if (!pd?.price) continue;
    // Nunca abrir uma posição a um preço fantasma (base/stale): sem preço real
    // fresco, salta este ativo neste tick.
    if (!prices.isReal(sg.id)) continue;

    // ── Travão de sanidade: o Groq pode inflacionar confiança (diz 100% em
    //    ativos parados). Só entra se os INDICADORES TÉCNICOS também concordarem.
    //    Assim o AI Brain combina o "raciocínio" do LLM com dados objetivos. ──
    //    (Salta-se no fallback: o sinal JÁ é técnico, não precisa de re-confirmar.)
    if (!sg._fallback) {
      const daily = dailySeries[sg.id] || [];
      if (daily.length >= 15) {
        const serie = [...daily.slice(-89), pd.price];
        const tech = indicators.buySignal(serie, { dropTrigger: 1.0, rsiOversold: 45, smaLong: 50 });
        if (!tech.buy) {
          // Groq diz comprar mas os indicadores não confirmam → ignora (evita falsos sinais)
          continue;
        }
      }
      // (se não há histórico suficiente, confia só no Groq)
    }

    // cooldown 5 min por ativo
    if (Date.now() - (aiBrainCooldown[sg.id] || 0) < 5 * 60 * 1000) continue;
    // cooldown pós-perda (mais longo após um SL neste ativo)
    const aiLossCdMs = (parseInt(process.env.POSTLOSS_COOLDOWN_MIN || "30", 10)) * 60000;
    if (Date.now() - (lastLossTime[sg.id] || 0) < aiLossCdMs) continue;
    // não duplicar posição AI no mesmo ativo
    if (Object.values(openPositions).some(p => p.assetId === sg.id && p.stratId === "ai-brain")) continue;
    // limites — o Cérebro AI tem o SEU PRÓPRIO limite, separado das estratégias.
    // Antes partilhavam maxEstrategias: as estratégias (que correm primeiro no
    // tick) enchiam as vagas e o AI-Brain nunca abria. Agora conta só as suas.
    const brainPositions = Object.values(openPositions).filter(p => p.stratId === "ai-brain");
    const maxBrain = limitePosicoes(Number(appSettings.maxAiBrain) || 3);
    if (brainPositions.length >= maxBrain) continue;
    // Quantia por perfil+confiança+saldo (igual à app); fixo se modo != auto.
    const perTrade = Math.min(
      suggestAmount(sg.id, sg.confianca, { perTrade: appSettings.valorFixo || 100 }, "aibrain"),
      parseFloat(process.env.MAX_POSITION_EUR || "500")
    );
    if (simBalance < perTrade) continue;
    if (aiTradeSaldoDisponivel() < perTrade) {
      if (tickCount % 30 === 0) logger.info("Fatia AI Trade esgotada — Cérebro AI em pausa (protege o DCA)");
      continue;
    }
    if (totalInvested + perTrade > parseFloat(process.env.MAX_TOTAL_EUR || simCapital)) continue;

    const price = pd.price;
    const units = +(perTrade / price).toFixed(7);
    const adjB  = adjustedRisk(sg.id, slPct, tpPct, null);
    const sl    = +(price * (1 - adjB.sl / 100)).toFixed(sg.id === "eurusd" ? 5 : 4);
    const tp    = +(price * (1 + adjB.tp / 100)).toFixed(sg.id === "eurusd" ? 5 : 4);
    const posId = `${broker.isLive() ? "live" : "sim"}_ai_${Date.now()}_${sg.id}`;
    // Distinguir a origem do sinal: Groq (LLM) vs fallback técnico (indicadores).
    const viaTecnico = !!sg._fallback;

    // Em LIVE, pré-registo PENDING antes da ordem (atomicidade).
    if (broker.isLive()) {
      await fb.saveTrade("server", {
        id: posId, assetId: sg.id, assetName: sg.id, assetSym: sg.id.toUpperCase(),
        entryPrice: price, units, amount: perTrade, sl, tp,
        strategy: viaTecnico ? `🧮 AI Técnico (${sg.confianca}%)` : `🤖 AI Brain (${sg.confianca}%)`,
        stratId: "ai-brain", aiSource: viaTecnico ? "tecnico" : "groq",
        openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(),
        status: "PENDING", mode: "live",
      }).catch(e => logger.warn(`Pré-registo PENDING (AI) falhou: ${e.message}`));
    }

    // Executar a ordem (real na Alpaca se paper/real; simulada em sim).
    const exec = await broker.buy({ assetId: sg.id, amount: perTrade, price, sl, tp });
    if (!exec.ok) {
      logger.warn(`AI-Brain ${sg.id} não executado: ${exec.reason}`);
      // COOLDOWN NA FALHA: impõe a mesma pausa que num sucesso, para NÃO retentar
      // o mesmo ativo a cada tick (evita o loop de centenas de tentativas — ex.:
      // GLD a ser tentado sem parar quando a corretora rejeita).
      aiBrainCooldown[sg.id] = Date.now();
      // Apaga o pré-registo PENDING (em vez de o deixar como CANCELADA) — assim
      // uma ordem que nunca chegou a abrir não polui o histórico.
      if (broker.isLive()) await fb.deleteTrade("server", posId).catch(() => {});
      continue;
    }
    const fillPrice = exec.fillPrice || price;
    const realUnits = (typeof exec.filledQty === "number" && exec.filledQty > 0) ? exec.filledQty : units;

    const position = {
      id: posId, assetId: sg.id, assetName: sg.id, assetSym: sg.id.toUpperCase(),
      entryPrice: fillPrice, units: realUnits, amount: perTrade, peak: fillPrice, sl, tp,
      strategy: viaTecnico ? `🧮 AI Técnico (${sg.confianca}%)` : `🤖 AI Brain (${sg.confianca}%)`,
      stratId: "ai-brain",
      aiSource: viaTecnico ? "tecnico" : "groq",
      openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(), status: "ABERTA",
      mode: broker.isLive() ? "live" : "sim",
      brokerOrderId: exec.brokerOrderId || null, broker: exec.broker || null,
      brokerSLTP: !!exec.bracket, pendingFill: !!exec.pending,
      ...regimeSnapshot(),         // carimbo do regime de mercado na abertura
    };
    openPositions[posId] = position;
    totalInvested += perTrade;
    simBalance = +(simBalance - perTrade).toFixed(2);
    aiBrainCooldown[sg.id] = Date.now();

    await fb.saveTrade("server", position);
    await fb.saveBalance("server", simBalance);
    queueOpen({ ...position, confianca: sg.confianca, origemLabel: viaTecnico ? "🧮 AI Técnico" : "🤖 AI Brain" }, broker.getMode());
    const _mAi = `${viaTecnico ? "🧮 AI TÉCNICO" : "🤖 AI BRAIN"} ${sg.id.toUpperCase()} | €${perTrade} @$${fillPrice} | ${sg.confianca}%`;
    logger.buy(_mAi); logEvent("buy", _mAi);
  }
}

// ── Helpers DCA: compra/venda de posições HOLD (núcleo passivo) ───────────────
// As posições DCA são HOLD: sem SL/TP, marcadas com stratId "dca". A fatia de
// capital DCA é separada — o trading ativo nunca lhe toca, e vice-versa.

// As posições DCA são HOLD: sem SL/TP, marcadas com stratId "dca" e planId.
// No modelo multi-plano, o DCA usa o saldo disponível (limitado pelo total), e a
// fatia AI Trade é definida pelo utilizador como reserva para o trading ativo.

function dcaInvestido() {
  return Object.values(openPositions)
    .filter(p => p.stratId === "dca")
    .reduce((a, p) => a + (p.amount || 0), 0);
}
function aiTradeInvestido() {
  return Object.values(openPositions)
    .filter(p => p.stratId !== "dca")
    .reduce((a, p) => a + (p.amount || 0), 0);
}
// Saldo que o DCA pode usar = o que sobra depois de reservar a fatia AI Trade.
// A fatia AI Trade é dcaAiTradeValor (€ fixo) ou dcaAiTradePct (% do capital).
function reservaAiTrade() {
  if (Number(appSettings.dcaAiTradeValor) > 0) return Number(appSettings.dcaAiTradeValor);
  const pct = Number(appSettings.dcaAiTradePct);
  if (Number.isFinite(pct) && pct > 0) return (pct / 100) * simCapital;
  // Retrocompat: se ainda houver dcaPctCapital, a reserva AI = 100 − dcaPctCapital.
  const legacy = Number(appSettings.dcaPctCapital);
  if (Number.isFinite(legacy) && legacy > 0) return ((100 - legacy) / 100) * simCapital;
  return 0;
}
function dcaSaldoDisponivel() {
  const reserva = reservaAiTrade();
  // O DCA pode usar tudo menos a reserva AI Trade (e nunca mais do que há).
  return Math.max(0, +(Math.min(simBalance, simCapital - reserva) - 0).toFixed(2));
}
// Saldo que o trading ativo (AI Brain + manuais) pode usar = a sua reserva menos
// o que já tem investido. Protege os planos DCA de serem invadidos.
function aiTradeSaldoDisponivel() {
  const reserva = reservaAiTrade();
  return Math.max(0, +(Math.min(reserva, simBalance) - aiTradeInvestido()).toFixed(2));
}
function dcaPosicoes() {
  return Object.values(openPositions)
    .filter(p => p.stratId === "dca")
    .map(p => ({ assetId: p.assetId, units: p.units, amount: p.amount, entryPrice: p.entryPrice, posId: p.id, planId: p.planId || "principal" }));
}

async function buyDCA(assetId, eur, planId = "principal", planNome = "Principal") {
  if (!prices.isReal(assetId)) throw new Error("sem preço real fresco");
  const price = currentPrices[assetId]?.price;
  if (!price) throw new Error("sem preço atual");
  if (simBalance < eur) throw new Error(`saldo insuficiente (€${simBalance} < €${eur})`);

  // Acumula na posição DCA do MESMO ativo E do MESMO plano (média de custo).
  // Plano diferente do mesmo ativo = posição separada, para medir cada objetivo.
  const existente = Object.values(openPositions).find(p => p.stratId === "dca" && p.assetId === assetId && (p.planId || "principal") === planId);
  const exec = await broker.buy({ assetId, amount: eur, price, sl: null, tp: null });
  const fillPrice = exec.fillPrice || price;
  const novasUnits = eur / fillPrice;

  if (existente) {
    const totalUnits = existente.units + novasUnits;
    const totalAmount = (existente.amount || 0) + eur;
    existente.units = +totalUnits.toFixed(8);
    existente.amount = +totalAmount.toFixed(2);
    existente.entryPrice = +(totalAmount / totalUnits).toFixed(6);
    await fb.saveTrade("server", existente);
  } else {
    const posId = `${broker.isLive() ? "live" : "sim"}_dca_${planId}_${Date.now()}_${assetId}`;
    const position = {
      id: posId, assetId, assetName: assetId, assetSym: assetId.toUpperCase(),
      entryPrice: fillPrice, units: +novasUnits.toFixed(8), amount: +eur.toFixed(2),
      peak: fillPrice, sl: null, tp: null,
      strategy: `DCA · ${planNome}`, stratId: "dca", planId, planNome,
      openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(),
      status: "ABERTA", mode: broker.isLive() ? "live" : "sim",
      brokerOrderId: exec.brokerOrderId || null, broker: exec.broker || null,
      brokerSymbol: exec.brokerSymbol || null, brokerSLTP: false,
    };
    openPositions[posId] = position;
    await fb.saveTrade("server", position);
  }
  totalInvested += eur;
  simBalance = +(simBalance - eur).toFixed(2);
  await fb.saveBalance("server", simBalance);
  return { fillPrice, units: novasUnits };
}

async function sellDCA(assetId, eur, planId = "principal") {
  const pos = Object.values(openPositions).find(p => p.stratId === "dca" && p.assetId === assetId && (p.planId || "principal") === planId);
  if (!pos) throw new Error("sem posição DCA neste ativo/plano");
  if (!prices.isReal(assetId)) throw new Error("sem preço real fresco");
  const price = currentPrices[assetId]?.price;
  if (!price) throw new Error("sem preço atual");

  const valorAtual = pos.units * price;
  const eurVender = Math.min(eur, valorAtual);
  const unitsVender = +(eurVender / price).toFixed(8);
  if (unitsVender <= 0 || unitsVender >= pos.units) {
    const exec = await broker.sell({ assetId, units: pos.units, price, broker: pos.broker, hadBracket: false });
    const fill = exec.fillPrice || price;
    simBalance = +(simBalance + pos.units * fill).toFixed(2);
    totalInvested = Math.max(0, totalInvested - (pos.amount || 0));
    delete openPositions[pos.id];
    await fb.deleteTrade?.("server", pos.id).catch?.(() => {});
    await fb.saveBalance("server", simBalance);
    return;
  }
  const exec = await broker.sell({ assetId, units: unitsVender, price, broker: pos.broker, hadBracket: false });
  const fill = exec.fillPrice || price;
  pos.units = +(pos.units - unitsVender).toFixed(8);
  pos.amount = +(pos.amount - eurVender).toFixed(2);
  simBalance = +(simBalance + unitsVender * fill).toFixed(2);
  totalInvested = Math.max(0, totalInvested - eurVender);
  await fb.saveTrade("server", pos);
  await fb.saveBalance("server", simBalance);
}

// Inicializa o motor DCA com o contexto (deps) que precisa do sim-engine.
function initDCA() {
  dcaEngine.init({
    settings:     () => appSettings,
    dcaPositions: dcaPosicoes,
    dcaBalance:   dcaSaldoDisponivel,
    priceOf:      (id) => (prices.isReal(id) ? (currentPrices[id]?.price ?? null) : null),
    buyDCA, sellDCA,
    now: () => Date.now(),
    // Notifica o utilizador (Telegram) — usado para avisar de compras manuais.
    notificar: (msg) => notify(msg).catch(() => {}),
    // Persiste um campo de estado interno (ex.: _ultimoResumoMes) no doc de
    // settings do modo, e atualiza appSettings em memória.
    guardarSetting: async (chave, valor) => {
      try {
        appSettings[chave] = valor;
        await fb.saveSetting("server", chave, valor);
      } catch (e) { logger.warn(`guardarSetting ${chave}: ${e.message}`); }
    },
    // Grava uma ordem de compra manual pendente na coleção dcaManualOrders, para
    // a app a mostrar e o utilizador confirmar.
    // Grava a ordem manual e mantém também uma LISTA consolidada num único doc
    // (dcaManualPendentes), para a app subscrever só esse doc — barato e sem loops.
    criarOrdemManual: async (ordem) => {
      try {
        await fb.saveSetting("server", `dcaManual_${ordem.id}`, ordem);
        await fb.appendManualOrder(ordem);
      } catch (e) { logger.warn(`criarOrdemManual: ${e.message}`); }
    },
    // Agenda a próxima compra de UM plano e regista a sua data de início.
    // Atualiza o plano dentro de appSettings.dcaPlanos e persiste em settings/dcaSchedule.
    agendarPlano: (planId, proximaTs, dataInicio) => {
      const planos = Array.isArray(appSettings.dcaPlanos) ? appSettings.dcaPlanos : [];
      const p = planos.find(x => x.id === planId);
      if (p) { p.proximaCompra = proximaTs; if (!p.dataInicio) p.dataInicio = dataInicio; }
      // Retrocompat: plano único antigo
      if (planId === "principal" && !planos.length) {
        appSettings.dcaProximaCompra = proximaTs;
        if (!appSettings.dcaDataInicio) appSettings.dcaDataInicio = dataInicio;
      }
      return fb.saveSetting("server", "dcaSchedule", {
        dcaPlanosSchedule: planos.map(x => ({ id: x.id, proximaCompra: x.proximaCompra, dataInicio: x.dataInicio })),
        dcaProximaCompra: appSettings.dcaProximaCompra ?? null,
        dcaDataInicio: appSettings.dcaDataInicio ?? null,
      }).catch(() => {});
    },
  });
}

// ── Tick principal ────────────────────────────────────────────────────────────
async function tick() {
  try {
    tickCount++;
    // Rollover robusto: arquiva o dia anterior assim que o dia muda, mesmo que
    // o cron da meia-noite tenha falhado (bot em baixo nesse minuto). Barato.
    fb.checkDayRollover().then(r => {
      if (r && r.length) notify(`📁 *Arquivo automático*: ${r.length} dia(s) arquivado(s).`).catch(() => {});
    }).catch(() => {});
    // 1. Refresh preços
    await prices.refreshAll();
    const currentPrices = prices.getAll();

    // Reavalia o REGIME de mercado a cada REGIME_MS (10 min). É uma leitura de
    // fundo (MM50 de BTC/SPY), não muda a cada tick. Mesmo com o modo dinâmico
    // desligado, mantemos o regime calculado para a app o poder mostrar como info.
    if (Date.now() - lastRegimeAt >= REGIME_MS) {
      lastRegimeAt = Date.now();
      try {
        const antes = regimeAtual;
        avaliaRegime();
        if (regimeAtual !== antes && appSettings.regimeDinamico) {
          const emoji = regimeAtual === "baixa" ? "🔻" : regimeAtual === "alta" ? "🔼" : "➖";
          notify(`${emoji} *Regime de mercado: ${regimeAtual.toUpperCase()}* — ${regimeDetalhe}`).catch(() => {});
          logger.info(`Regime de mercado mudou: ${antes} → ${regimeAtual} (${regimeDetalhe})`);
        }
      } catch (e) { logger.warn(`avaliaRegime falhou: ${e.message}`); }
    }

    // Atualizar histórico diário 1x/dia (a cada ~2880 ticks de 30s) para os indicadores
    if (tickCount % 2880 === 0) {
      prices.fetchHistory().then(h => {
        if (Object.keys(h).length) { dailySeries = h; logger.info("📈 Histórico diário atualizado"); publishPriceStats(); }
      }).catch(() => {});
    }

    // Atualizar sinais AI (intervalo configurável) e persistir para a app os mostrar.
    // SÓ quando alguma fonte que USA estes sinais está ligada (estratégias ou
    // compras autónomas). Se tudo isso está off, gerá-los seria queimar tokens à toa.
    const mestreSig = !!appSettings.aiTradeAtivo || !!appSettings.aiBrainMestre;
    const precisaSinais = mestreSig && ((appSettings.aiEstrategias ?? appSettings.aiTradeAtivo)
                       || (appSettings.aiManualAutonomo ?? appSettings.aiTradeAtivo));
    if (precisaSinais) {
      const sigsBefore = JSON.stringify(aiSignals.getSignals());
      await aiSignals.refresh();
      const sigsAfter = aiSignals.getSignals();
      if (JSON.stringify(sigsAfter) !== sigsBefore && Object.keys(sigsAfter).length) {
        fb.saveSetting("server", "marketSignals", sigsAfter).catch(() => {});
      }
    }

    // Atualizar sentiment de notícias (só ajusta exposição, nunca SL/TP). Lê o
    // feed que a app escreve em settings/newsFeed (manchetes ou override manual).
    // Só corre se newsTilt ligado E o AI Brain mestre ligado — o sentiment só
    // afeta o trading ativo, por isso sem mestre não vale a pena gastar tokens.
    const mestreNews = !!appSettings.aiTradeAtivo || !!appSettings.aiBrainMestre;
    if (appSettings.newsTilt && mestreNews) {
      const before = JSON.stringify(newsSentiment.getState());
      await newsSentiment.refresh(newsFeed || {});
      const after = newsSentiment.getState();
      if (JSON.stringify(after) !== before) {
        fb.saveSetting("server", "newsSentiment", after).catch(() => {});
      }
    }

    // Registar histórico
    Object.entries(currentPrices).forEach(([id, d]) => {
      if (d?.price) recordPrice(id, d.price);
    });

    // 2. Verificar SL/TP
    await checkSLTP(currentPrices);

    // 2b. Processar comandos manuais da app (compra/venda pedida pelo utilizador)
    await processCommands(currentPrices);

    // 2c. MOTOR DCA (núcleo passivo) — corre SEMPRE que dcaAtivo, independente do
    // botPaused (o DCA é o plano "férias", não deve parar em deploys) e do AI Trade.
    // Faz as compras periódicas e o reequilíbrio. Usa a sua fatia de capital.
    await dcaEngine.tick();

    // ── PAUSA: quando o bot está pausado (toggle na app, útil em deploys), NÃO
    // abre novas posições — mas continua a proteger as abertas (SL/TP acima já
    // correu) e a processar vendas/comandos. Pausar nunca desativa a proteção.
    if (botPaused) {
      if (tickCount % 10 === 0) logger.info("⏸ Bot PAUSADO — só gestão de posições abertas (SL/TP/vendas). Sem novas entradas.");
    } else {
    // Controlo GRANULAR do trading ativo: cada fonte tem o seu interruptor.
    // O DCA (acima) corre sempre. Estas só correm se a respetiva flag estiver on.
    //   aiEstrategias    → bloco de estratégias (3)
    //   aiManualAutonomo → Cérebro AI autónomo (3c)
    //   aiDayTrading     → day-trade (3d)
    // HIERARQUIA (opção C): aiBrainMestre é a chave-mestra. Nada de trading ativo
    // corre sem ele ON. Com ele ON, cada fonte corre se a sua flag estiver ON.
    // Compatibilidade: aiTradeAtivo (toggle antigo) liga mestre + as três fontes.
    const legacyOn = !!appSettings.aiTradeAtivo;
    const mestre = legacyOn || !!appSettings.aiBrainMestre;
    const onEstrat = mestre && (appSettings.aiEstrategias ?? legacyOn);
    const onManual = mestre && (appSettings.aiManualAutonomo ?? legacyOn);
    const onDay    = mestre && (appSettings.aiDayTrading ?? legacyOn);
    if (!mestre && tickCount % 30 === 0) {
      logger.info("💤 AI Brain (mestre) desligado — só DCA passivo. Liga-o nas Definições para usar trading ativo.");
    } else if (mestre && !onEstrat && !onManual && !onDay && tickCount % 30 === 0) {
      logger.info("AI Brain ON mas nenhuma fonte ativada — liga Estratégias / Compras / Day Trade nas Definições.");
    }

    // 3. Verificar sinais das estratégias
    if (onEstrat && !dailyLossHit) {
      for (const strategy of strategies) {
        if (!strategy.ativo) continue;
        for (const assetId of (strategy.ativos || [])) {
          const priceData = currentPrices[assetId];
          if (!priceData?.price) continue;
          // Não comprar em mercado fechado (preços congelados → sinais falsos)
          if (!isMarketOpenFor(assetId)) continue;

          // Cooldown de re-entrada: não voltar ao mesmo ativo/estratégia durante
          // X min. Evita o vai-e-vem de trades de <1min que não chegam a valorizar
          // e o martelar de um ativo que a corretora rejeita. Configurável por env.
          const cdKey = `${strategy.id}_${assetId}`;
          const cooldownMs = (parseInt(process.env.REENTRY_COOLDOWN_MIN || "10", 10)) * 60000;
          const lastBuy = lastBuyTime[cdKey] || 0;
          if (Date.now() - lastBuy < cooldownMs) continue;
          // Cooldown pós-perda (mais longo): após um SL neste ativo, espera mais
          // antes de reentrar. Default = 3x o cooldown normal. Configurável.
          const lossCdMs = (parseInt(process.env.POSTLOSS_COOLDOWN_MIN || "30", 10)) * 60000;
          if (Date.now() - (lastLossTime[assetId] || 0) < lossCdMs) continue;

          // ── Sinal realista: combina histórico diário (RSI + média móvel)
          //    com a queda intradiária recente. Precisa de ≥2 critérios. ──
          // Série = histórico diário + o preço de hoje no fim (para refletir o agora)
          const daily = dailySeries[assetId] || [];
          const serie = daily.length ? [...daily.slice(-89), priceData.price] : [];

          // Queda de compra ajustada à volatilidade da categoria do ativo
          // (crypto exige queda maior para entrar; forex menor).
          const dropAdj = adjustedRisk(assetId, 1, 1, strategy.compra).drop;

          let sinal;
          if (serie.length >= 15) {
            // Temos histórico real → usa indicadores técnicos
            sinal = indicators.buySignal(serie, {
              dropTrigger: dropAdj,                   // gatilho de queda ajustado por categoria
              rsiOversold: strategy.risco === "alto" ? 45 : strategy.risco === "baixo" ? 30 : 38,
              smaLong:     50,
            });
          } else {
            // Fallback: ainda sem histórico → usa só a queda intradiária (como antes)
            const high = getRecentHigh(assetId);
            const dropPct = high ? ((high - priceData.price) / high) * 100 : 0;
            sinal = { buy: dropPct >= dropAdj, score: 60, reason: `queda ${dropPct.toFixed(1)}% (sem histórico)` };
          }

          if (sinal.buy) {
            logger.info(`🎯 Sinal: ${strategy.nome} → ${assetId} | ${sinal.reason} (força ${sinal.score})`);
            // Marca o cooldown ANTES de tentar — assim, mesmo que a ordem seja
            // rejeitada pela corretora ou feche logo, não voltamos a martelar o
            // mesmo ativo no ciclo seguinte (era a causa das dezenas de trades
            // ADA <1min). A trava vale para tentativa, não só para sucesso.
            lastBuyTime[cdKey] = Date.now();
            const aiSig = aiSignals.getSignal(assetId);
            const conf  = Math.max(sinal.score || 0, aiSig?.confianca || 0);
            await executeBuy(strategy, assetId, priceData.price, conf);
          }
        }
      }
    }

    // 3c. Cérebro AI autónomo — entra com base nos sinais de alta confiança.
    // Só se as compras manuais autónomas estiverem ligadas (a IA compra sozinha).
    if (onManual) await runAiBrain(currentPrices);

    // 3d. Day Trading 24/7 — scan com IA e abre posições rápidas (config vinda da app)
    // limitePosicoes() reduz o nº máximo de day-trades em regime de baixa.
    if (onDay) await dayTrading.run(dtConfig, limitePosicoes(appSettings.maxDayTrading || 5), {
      openDayTrade, countDayTrades, hasOpen,
    }).catch(err => logger.warn(`DayTrading run: ${err.message}`));

    } // fim do gate de pausa (botPaused)

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
      // Otimização Firestore: só publica se os preços MUDARAM desde a última
      // publicação. Em mercado parado (noite/fim de semana) evita reescritas
      // inúteis — poupa escritas no free tier sem afetar a app (lê o último valor).
      const slimJson = JSON.stringify(slim);
      if (slimJson !== lastPricesJson) {
        await fb.saveSetting("server", "marketPrices", { prices: slim, ts: now }).catch(() => {});
        lastPricesJson = slimJson;
      }
      lastPricesAt = now;
    }

    // 5. Heartbeat — a app usa para saber que o bot está vivo (exige < 3 min).
    //    Escreve a cada 2 min, ou imediatamente se as features mudarem.
    const features = {
      aiBrain:      !!appSettings.aiBrain,
      trailingStop: !!appSettings.trailingStop,
      aiExitOnFlip: appSettings.aiExitOnFlip !== false,
      // AI-Brain a operar por indicadores técnicos porque o Groq está em baixo.
      aiBrainFallback: !!appSettings.aiBrain && !aiSignals.getGroqHealth().ok,
      scaleOutTP:   !!appSettings.scaleOutTP,
      regimeDinamico: !!appSettings.regimeDinamico,
      newsTilt:     !!appSettings.newsTilt,
      paused:       botPaused,
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
        twelvedata: { ok: ph.twelvedata?.ok, lastOk: ph.twelvedata?.lastOk, err: ph.twelvedata?.lastErr, exhausted: !!ph.twelvedata?.exhausted },
        finnhub:    { ok: ph.finnhub?.ok,    lastOk: ph.finnhub?.lastOk,    err: ph.finnhub?.lastErr, disabled: !!ph.finnhub?.disabled },
        stooq:      { ok: ph.stooq.ok,       lastOk: ph.stooq.lastOk,       err: ph.stooq.lastErr, disabled: !!ph.stooq?.disabled },
      };
      // Câmbio: os brokers (Alpaca/Binance) operam em USD/USDT, mas o sizing e os
      // rótulos da app pensam em EUR. Publicamos a moeda real do saldo e a taxa
      // EUR/USD ao vivo para a app CONVERTER na exibição. O motor mantém tudo na
      // moeda do broker (coerência interna) — a conversão é só de apresentação.
      const fxEurUsd = prices.getFreshPrice("eurusd") || null; // USD por 1 EUR
      const brokerCurrency = broker.isLive() ? "USD" : "EUR";  // sim = EUR puro
      const rf = regimeFatores();
      // Relatório por broker (capacidades + saldo real), atualizado a cada ~5 min
      // para não martelar as APIs dos brokers a cada heartbeat.
      if (now - lastBrokerReportAt > 5 * 60 * 1000 || !brokerReportCache.length) {
        try { brokerReportCache = await broker.brokerReport(); lastBrokerReportAt = now; }
        catch (e) { logger.warn(`brokerReport: ${e.message}`); }
      }
      await fb.saveSetting("server", "botStatus", {
        alive:    true,
        mode:     broker.getMode(),
        lastSeen: now,
        features,
        apiHealth,
        currency: brokerCurrency,   // moeda real dos valores (saldo, P&L, sizing)
        fxEurUsd,                   // taxa ao vivo: 1 EUR = fxEurUsd USD (ou null)
        // Regime de mercado (modo dinâmico): visível na app para o utilizador
        // perceber porque é que o bot está mais/menos agressivo num dado momento.
        regime: {
          ativo:    !!appSettings.regimeDinamico,
          estado:   regimeAtual,        // "alta" | "neutro" | "baixa" | (fixo se off)
          detalhe:  regimeDetalhe,
          fatorPosicoes: rf.posicoes,   // ex.: 0.5 = metade das posições
          fatorValor:    rf.valor,      // ex.: 0.6 = 60% do valor por trade
          confExtra:     rf.confExtra,  // pontos extra de confiança exigida
        },
        // Sentiment de notícias (só ajusta exposição, nunca SL/TP). A app mostra
        // o clima atual e a justificação para o utilizador perceber o ajuste.
        newsSentiment: appSettings.newsTilt ? newsSentiment.getState() : { bias: 0, label: "desligado", rationale: "", source: "off" },
        // Relatório por broker: capacidades (que classes negoceia) + saldo real
        // (em live). A app usa isto para o relatório financeiro e para saber de
        // que conta sai cada plano DCA.
        brokers: brokerReportCache,
      });
      lastHeartbeatAt  = now;
      lastFeaturesJson = featuresJson;
    }

    // ── Saldos por broker (só em paper/real) → a app mostra-os no Portfólio ──
    // Desacoplado do heartbeat: cada leitura faz N chamadas HTTP à corretora,
    // por isso lê no máx. a cada BROKERBAL_MS (5 min) e só escreve no Firestore
    // se o saldo MUDOU. Antes corria a cada heartbeat (2 min) sem dedupe.
    if (broker.isLive() && broker.registry && now - lastBrokerBalAt >= BROKERBAL_MS) {
      lastBrokerBalAt = now;
      try {
        const balances = {};
        for (const a of broker.registry.available()) {
          try { const b = await a.getBalance(); if (b != null) balances[a.id] = +(+b).toFixed(2); }
          catch (e) { logger.warn(`Saldo ${a.id} falhou: ${e.message}`); }
        }
        const balJson = JSON.stringify(balances);
        if (Object.keys(balances).length && balJson !== lastBrokerBalJson) {
          await fb.saveSetting("server", "brokerBalances", balances);
          lastBrokerBalJson = balJson;
        }
      } catch (e) { logger.warn(`brokerBalances não publicado: ${e.message}`); }
    }

  } catch (err) {
    logger.error(`SimEngine tick erro: ${err.message}`);
    logEvent("error", `Erro no motor: ${err.message}`);
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

  // Inicializar o motor DCA (núcleo passivo) com o contexto do sim-engine.
  initDCA();

  // Carrega a contabilidade de aportes DCA (gravada na key server/dcaAportes).
  try {
    const ap = await fb.getSetting("server", "dcaAportes");
    if (ap && typeof ap === "object") appSettings.dcaAportes = ap;
  } catch {}

  // Ligar o saldo manual do XTB (broker manual) ao valor das settings. A app
  // introduz xtbSaldo e desconta a cada compra confirmada; o broker lê daqui.
  try {
    const xtb = broker.registry.byId("xtb");
    if (xtb && xtb.setManualBalanceProvider) {
      xtb.setManualBalanceProvider(() => {
        const v = Number(appSettings.xtbSaldo);
        return Number.isFinite(v) && v >= 0 ? v : null;
      });
    }
  } catch (e) { logger.warn(`XTB manual balance: ${e.message}`); }

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

  // Carregar saldo guardado — APENAS em simulação. Em paper/real, o saldo de
  // referência é o da corretora (já lido acima); o saldo do Firestore não pode
  // sobrepor-se, senão o sizing por % usa um valor errado (era o "Saldo
  // restaurado €92410" a tapar o cash real da Alpaca).
  if (!broker.isLive()) {
    const savedBal = await fb.getBalance("server");
    if (savedBal && savedBal > 0) {
      simBalance = savedBal;
      simCapital = savedBal; // considera o atual como base se já havia
      stats.setBalance(simBalance);
      logger.info(`Saldo restaurado (sim): €${simBalance}`);
    }
  } else {
    logger.info(`Saldo de referência (corretora): €${simBalance}`);
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

  // ── Fix 4: RECONCILIAÇÃO com a corretora (só em live) ───────────────────────
  // Compara o que o bot julga ter (Firestore) com o que a corretora REALMENTE
  // tem. Apanha divergências criadas por crashes a meio de uma ordem, brackets
  // que fecharam sozinhos, ou posições abertas fora do bot.
  if (broker.isLive()) {
    try {
      const reais = await broker.getPositions(); // [{ broker, symbol, qty, avgPrice }]
      if (reais) {
        const norm = s => String(s || "").toUpperCase().replace("/", "");
        const realBySym = new Map();
        reais.forEach(p => realBySym.set(norm(p.symbol), p));

        const avisos = [];
        // (a) Posições que o bot acha abertas mas a corretora já NÃO tem →
        //     foram fechadas fora do bot (ex.: bracket disparou). Marcar fechadas.
        for (const [id, pos] of Object.entries(openPositions)) {
          if (pos.mode !== "live") continue;
          const sym = norm(pos.brokerSymbol || pos.assetSym || pos.assetId);
          if (!realBySym.has(sym)) {
            avisos.push(`• ${pos.assetSym}: o bot tinha-a aberta mas a corretora já não a tem → marcada FECHADA-RECON`);
            await fb.updateTrade("server", id, { status: "FECHADA-RECON", closedAt: new Date().toLocaleString("pt-PT"), closedTs: Date.now() }).catch(() => {});
            delete openPositions[id];
          }
        }
        // (b) Posições reais na corretora que o bot NÃO conhece → órfãs do lado
        //     da corretora (ex.: crash entre ordem e gravação). Só avisamos —
        //     não inventamos uma posição com entrada/SL/TP que não sabemos.
        const conhecidas = new Set(Object.values(openPositions)
          .filter(p => p.mode === "live")
          .map(p => norm(p.brokerSymbol || p.assetSym || p.assetId)));
        for (const [sym, rp] of realBySym.entries()) {
          if (!conhecidas.has(sym)) {
            avisos.push(`• ${rp.symbol} (${rp.qty} @ $${rp.avgPrice}): existe na corretora mas o bot não a conhece → REQUER ATENÇÃO MANUAL (sem SL/TP gerido)`);
          }
        }

        if (avisos.length) {
          const msg = `⚠ *Reconciliação com a corretora* encontrou divergências:\n${avisos.join("\n")}`;
          logger.warn(msg.replace(/\*/g, ""));
          await notify(msg).catch(() => {});
        } else {
          logger.info("✓ Reconciliação com a corretora: tudo alinhado");
        }
      } else {
        logger.warn("Reconciliação: a corretora não devolveu posições (a saltar)");
      }
    } catch (e) {
      logger.error(`Reconciliação com a corretora falhou: ${e.message}`);
    }
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
        // Coerência do Hold: se a posição tem bracket nativo (ação/ETF) e o
        // utilizador LIGOU o Hold, a Alpaca fecharia na mesma quando o SL/TP
        // batesse (o Hold seria ignorado). Para o Hold ser coerente em todos os
        // ativos, cancelamos o bracket na corretora e passamos a gerir o SL/TP
        // pelo motor (que respeita o Hold: bloqueia TP/AI-EXIT, mantém o SL).
        if (p.hold === true && openPositions[p.id].brokerSLTP === true) {
          broker.cancelBracket(openPositions[p.id].assetId, openPositions[p.id].broker)
            .then(r => {
              if (r && r.ok && !r.nada) {
                openPositions[p.id].brokerSLTP = false; // motor assume o SL/TP
                logEvent("warn", `Hold em ${p.assetSym || p.assetId}: bracket cancelado na corretora, SL/TP agora geridos pelo bot`);
              }
            })
            .catch(() => {});
        }
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

  // Subscrever definições da app conforme o MODO do bot:
  //   sim   → settings/settings
  //   paper → settings/paperSettings  (fallback: liveSettings → settings)
  //   real  → settings/realSettings   (fallback: liveSettings → settings)
  // Assim cada modo tem o seu próprio conjunto de limites/risco, e o real nunca
  // herda acidentalmente definições agressivas de simulação.
  const MODE_NOW = broker.getMode();
  const SETTINGS_DOC = MODE_NOW === "real" ? "realSettings"
                     : MODE_NOW === "paper" ? "paperSettings"
                     : "settings";
  let settingsBaseLoaded = false; // trava o fallback assim que chega o doc específico
  const applySettings = (val) => {
    if (!val || typeof val !== "object") return;
    appSettings = {
      maxEstrategias:   val.maxEstrategias ?? 5,
      maxManuais:       val.maxManuais ?? 5,
      maxAiBrain:       val.maxAiBrain ?? 3,
      rotacaoAtiva:     val.rotacaoAtiva ?? false,
      rotacaoMinPct:    val.rotacaoMinPct ?? 1,
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
      maxValorTrade:    val.maxValorTrade ?? 100,
      maxPosicoesTotal: val.maxPosicoesTotal ?? 40,
      aiSignalsMin:     val.aiSignalsMin ?? 15,
      scaleOutTP:       val.scaleOutTP ?? false,   // TP parcial (vende fração, deixa correr)
      scaleOutPct:      val.scaleOutPct ?? 50,     // % a vender no TP parcial
      catAjuste:        (val.catAjuste && typeof val.catAjuste === "object") ? val.catAjuste : appSettings.catAjuste,
      perOrigem:        (val.perOrigem && typeof val.perOrigem === "object") ? val.perOrigem : appSettings.perOrigem,
      regimeDinamico:   val.regimeDinamico ?? false,
      newsTilt:         val.newsTilt ?? false,
      // ── DCA (núcleo passivo) ──
      dcaAtivo:         val.dcaAtivo ?? true,
      aiTradeAtivo:     val.aiTradeAtivo ?? false,
      aiBrainMestre:    val.aiBrainMestre ?? false,
      aiEstrategias:    val.aiEstrategias ?? null,
      aiManualAutonomo: val.aiManualAutonomo ?? null,
      aiDayTrading:     val.aiDayTrading ?? null,
      dcaPctCapital:    Number(val.dcaPctCapital) || 80,
      dcaValorPeriodico:Number(val.dcaValorPeriodico) || 50,
      dcaFrequencia:    val.dcaFrequencia || "semanal",
      dcaCarteira:      Array.isArray(val.dcaCarteira) ? val.dcaCarteira : [],
      dcaReequilibrar:  val.dcaReequilibrar ?? true,
      dcaDerivaPct:     Number(val.dcaDerivaPct) || 5,
      dcaProximaCompra: val.dcaProximaCompra ?? appSettings.dcaProximaCompra ?? null,
      // ── DCA multi-plano ──
      dcaValorMensal:   Number(val.dcaValorMensal) || 100,
      dcaPlanos:        Array.isArray(val.dcaPlanos) ? val.dcaPlanos : [],
      dcaAiTradePct:    val.dcaAiTradePct != null ? Number(val.dcaAiTradePct) : 20,
      dcaAiTradeValor:  Number(val.dcaAiTradeValor) || 0,
      dcaDataInicio:    val.dcaDataInicio ?? appSettings.dcaDataInicio ?? null,
      // Saldo manual do XTB (broker manual). A app introduz e desconta às compras.
      xtbSaldo:         val.xtbSaldo != null ? Number(val.xtbSaldo) : (appSettings.xtbSaldo ?? null),
      // Notificações DCA opcionais (opt-in pela app)
      dcaAlertaQueda:   val.dcaAlertaQueda ?? appSettings.dcaAlertaQueda ?? false,
      dcaResumoMensal:  val.dcaResumoMensal ?? appSettings.dcaResumoMensal ?? false,
      dcaPausadoAte:    val.dcaPausadoAte ?? appSettings.dcaPausadoAte ?? null,
      // Lembretes de aporte manual + registo de aportes confirmados (contabilidade)
      dcaLembretes:     val.dcaLembretes ?? appSettings.dcaLembretes ?? false,
      dcaAportes:       val.dcaAportes ?? appSettings.dcaAportes ?? {},
      _ultimoResumoMes: appSettings._ultimoResumoMes ?? null,
    };
    aiSignals.setRefreshMinutes(appSettings.aiSignalsMin);
    logger.info(`Definições [${SETTINGS_DOC}]: máx ${appSettings.maxEstrategias} | rotação ${appSettings.rotacaoAtiva ? "ON" : "OFF"} | AI Brain ${appSettings.aiBrain ? `ON@${appSettings.aiBrainConfianca}%` : "OFF"} | Trailing ${appSettings.trailingStop ? `ON@${appSettings.trailingStopPct}%` : "OFF"} | teto €${appSettings.maxValorTrade} | Sinais ${appSettings.aiSignalsMin}min`);
  };
  fb.watchSetting(SETTINGS_DOC, (val) => {
    if (val && typeof val === "object") { settingsBaseLoaded = true; applySettings(val); }
  });
  // Fallback de migração: enquanto o doc específico não existir, em paper/real
  // usamos o antigo "liveSettings"; em qualquer modo, "settings" como último recurso.
  if (SETTINGS_DOC !== "settings") {
    fb.watchSetting("liveSettings", (val) => { if (!settingsBaseLoaded && val) applySettings(val); });
  }

  // Subscrever controlo de pausa do bot (toggle na app). Pausar impede novas
  // entradas mas mantém SL/TP e vendas — seguro para usar antes de um deploy.
  fb.watchSetting("botControl", (val) => {
    if (val && typeof val === "object") {
      const next = !!val.paused;
      if (next !== botPaused) {
        botPaused = next;
        logger.info(`Bot ${botPaused ? "PAUSADO ⏸ (sem novas entradas)" : "RETOMADO ▶ (entradas ativas)"}`);
        notify(botPaused ? "⏸ *Bot pausado* — sem novas entradas. SL/TP continuam ativos." : "▶ *Bot retomado* — entradas ativas.").catch(() => {});
      }
    }
  });

  // Subscrever feed de notícias (escrito pela app em settings/newsFeed). Pode ter
  // { headlines:[...] } para a IA classificar, ou { manualBias:0.5, manualLabel }
  // para override manual do clima. Só é usado se newsTilt estiver ligado.
  fb.watchSetting("newsFeed", (val) => {
    if (val && typeof val === "object") {
      newsFeed = val;
      logger.info(`📰 Feed de notícias atualizado: ${Array.isArray(val.headlines) ? val.headlines.length + " manchetes" : (val.manualBias != null ? "override manual" : "vazio")}`);
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
    publishPriceStats();
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

// ── Fechar uma posição específica a pedido do utilizador (via comando) ────────
async function closePositionManual(posId, currentPrices) {
  const pos = openPositions[posId];
  if (!pos) return { ok: false, reason: "posição não encontrada (já fechada?)" };
  let closePrice = prices.isReal(pos.assetId) ? (currentPrices?.[pos.assetId]?.price || prices.getFreshPrice(pos.assetId)) : null;
  if (!closePrice) return { ok: false, reason: "sem preço real fresco — tenta daqui a pouco" };

  if (broker.isLive()) {
    const exec = await broker.sell({ assetId: pos.assetId, units: pos.units, price: closePrice, broker: pos.broker, hadBracket: !!pos.brokerSLTP });
    if (!exec.ok) return { ok: false, reason: `corretora recusou: ${exec.reason}` };
    if (typeof exec.fillPrice === "number" && exec.fillPrice > 0) closePrice = exec.fillPrice;
  }
  const pnlBruto = (closePrice - pos.entryPrice) * pos.units;
  const fee = broker.roundTripFee(pos.assetId, pos.amount);
  const pnl = +(pnlBruto - fee).toFixed(4);
  const closedTs = Date.now();
  const closedTrade = { ...pos, status: "MANUAL", closePrice, closedAt: new Date().toLocaleString("pt-PT"), closedTs, fee, pnlBruto: +pnlBruto.toFixed(4), pnl };
  delete openPositions[posId];
  totalInvested = Math.max(0, totalInvested - pos.amount);
  simBalance = +(simBalance + pos.amount + pnl).toFixed(2);
  await fb.updateTrade("server", posId, { status: "MANUAL", closePrice, pnl, fee, pnlBruto: closedTrade.pnlBruto, closedAt: closedTrade.closedAt, closedTs });
  await fb.saveBalance("server", simBalance);
  stats.addClosedTrade(closedTrade);
  await notify(tg.tradeClose(closedTrade, pnl, "MANUAL", broker.getMode()));
  const _linhaM = `✋ VENDA MANUAL (pedido da app) ${pos.assetSym} | P&L ${sign(pnl)}${eur(pnl)}`;
  if (pnl >= 0) logger.win(_linhaM); else logger.loss(_linhaM);
  return { ok: true, pnl };
}

// ── Comprar a pedido do utilizador (via comando) ─────────────────────────────
async function buyManual({ assetId, amount }) {
  const price = prices.getFreshPrice(assetId);
  if (!price) {
    const sym = (prices.ASSETS.find(a => a.id === assetId)?.sym) || assetId;
    const motivo = `Ordem recusada: sem preço de mercado para ${sym} (fonte em baixo)`;
    logEvent("warn", motivo);
    return { ok: false, reason: `sem preço de mercado atual para ${sym} (fonte de dados em baixo) — tenta novamente daqui a pouco` };
  }
  // Limite de posições MANUAIS imposto no bot (não só na app) — para o limite
  // ser fiável mesmo que o comando venha de outra origem.
  const maxMan = Number(appSettings.maxManuais) || 5;
  const manualAbertas = Object.values(openPositions).filter(p => p.stratId === "manual").length;
  if (manualAbertas >= maxMan) {
    return { ok: false, reason: `limite de ${maxMan} posições manuais atingido` };
  }
  // Reaproveita o caminho normal de compra, como uma "estratégia manual".
  const fakeStrat = { id: "manual", nome: "Compra manual", sl: appSettings.stopLossPadrao || 6, tp: appSettings.takeProfitPadrao || 12, compra: 0, risco: "manual", perTrade: amount };
  const before = Object.keys(openPositions).length;
  await executeBuy(fakeStrat, assetId, price, 70);
  const opened = Object.keys(openPositions).length > before;
  return opened ? { ok: true } : { ok: false, reason: "não abriu (corretora recusou ou limite atingido)" };
}

// ── Processar a fila de comandos da app (compra/venda manual) ────────────────
async function processCommands(currentPrices) {
  let cmds;
  try { cmds = await fb.fetchPendingCommands(); } catch { return; }
  if (!cmds || !cmds.length) return;
  for (const cmd of cmds) {
    try {
      if (cmd.type === "SELL" && cmd.posId) {
        const r = await closePositionManual(cmd.posId, currentPrices);
        await fb.markCommand(cmd.id, r.ok ? "FEITO" : "FALHOU", r.ok ? `P&L ${r.pnl}` : r.reason);
      } else if (cmd.type === "BUY" && cmd.assetId) {
        if (botPaused) { await fb.markCommand(cmd.id, "FALHOU", "bot pausado — sem novas entradas"); continue; }
        const amount = Math.max(10, Number(cmd.amount) || 0);
        const r = await buyManual({ assetId: cmd.assetId, amount });
        await fb.markCommand(cmd.id, r.ok ? "FEITO" : "FALHOU", r.ok ? "comprado" : r.reason);
      } else if (cmd.type === "DCA_INICIAR" && cmd.planId) {
        // Botão "Iniciar plano": força a primeira compra AGORA, executando no
        // broker (Binance/Alpaca) — fluxo automático real, não só registo.
        if (botPaused) { await fb.markCommand(cmd.id, "FALHOU", "bot pausado"); continue; }
        const valorPlano = Number(cmd.valorPlano) || 0;
        if (valorPlano < 1) { await fb.markCommand(cmd.id, "FALHOU", "valor do plano inválido"); continue; }
        const r = await dcaEngine.iniciarPlanoAgora(cmd.planId, valorPlano);
        await fb.markCommand(cmd.id, r.ok ? "FEITO" : "FALHOU", r.ok ? "plano iniciado" : r.reason);
      } else if (cmd.type === "RESET_ALL") {
        // Recomeço de raiz: apaga trades/arquivos/stats/logs e repõe o saldo.
        // Limpa também o estado em memória para o bot recomeçar limpo sem reiniciar.
        const capital = Number(cmd.capital) || simCapital || 1000;
        const resumo = await fb.resetAllData(capital);
        openPositions = {};
        totalInvested = 0;
        simBalance = capital;
        simCapital = capital;
        appSettings.dcaProximaCompra = null; // reagenda DCA do zero
        await fb.saveBalance("server", simBalance).catch(() => {});
        await fb.markCommand(cmd.id, "FEITO", `apagados ${resumo.trades} trades, ${resumo.archives} arquivos`);
        logger.info("🧹 Base de dados limpa por comando da app — recomeço de raiz.");
      } else if (cmd.type === "DCA_MANUAL_CONFIRM" && Array.isArray(cmd.itens)) {
        // O utilizador comprou à mão no broker e confirma. Regista as posições DCA
        // (HOLD) com os preços que ele indicou (ou os sugeridos). Não mexe no saldo
        // simulado porque o dinheiro é real e está fora do bot — estas posições são
        // registadas com flag manualReal para o relatório as tratar à parte.
        for (const it of cmd.itens) {
          const price = Number(it.preco) || (currentPrices[it.assetId]?.price) || 0;
          const eur = Number(it.eur);
          // Validação: preço e valor positivos e dentro de limites sãos.
          if (!price || price <= 0 || !eur || eur <= 0 || eur > 1000000) continue;
          const units = eur / price;
          const planId = cmd.planId || "principal";
          const existente = Object.values(openPositions).find(p => p.stratId === "dca" && p.assetId === it.assetId && (p.planId || "principal") === planId);
          if (existente) {
            const totU = existente.units + units, totA = (existente.amount || 0) + Number(it.eur);
            existente.units = +totU.toFixed(8); existente.amount = +totA.toFixed(2);
            existente.entryPrice = +(totA / totU).toFixed(6);
            await fb.saveTrade("server", existente);
          } else {
            const posId = `manual_dca_${planId}_${Date.now()}_${it.assetId}`;
            const position = {
              id: posId, assetId: it.assetId, assetName: it.assetId, assetSym: it.assetId.toUpperCase(),
              entryPrice: price, units: +units.toFixed(8), amount: +Number(it.eur).toFixed(2),
              peak: price, sl: null, tp: null,
              strategy: `DCA · ${cmd.planNome || "Manual"}`, stratId: "dca", planId, planNome: cmd.planNome || "Manual",
              manualReal: true, broker: cmd.broker || null,
              openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(),
              status: "ABERTA", mode: broker.getMode(),
            };
            openPositions[posId] = position;
            await fb.saveTrade("server", position);
          }
        }
        // Apaga a ordem pendente e reagenda já foi feito pelo motor. O desconto do
        // saldo manual do XTB é feito pela app (que é dona das settings do modo).
        if (cmd.ordemId) { await fb.saveSetting("server", `dcaManual_${cmd.ordemId}`, { estado: "FEITA", concluidoEm: Date.now() }).catch(() => {}); await fb.removeManualOrder(cmd.ordemId).catch(() => {}); }
        // Contabilidade de aportes: regista quanto foi investido neste plano, para
        // o sistema de lembretes saber o que está em dia / em falta.
        if (cmd.planId) {
          const totalAporte = cmd.itens.reduce((a, it) => a + (Number(it.eur) || 0), 0);
          const aportes = { ...(appSettings.dcaAportes || {}) };
          const reg = aportes[cmd.planId] || { total: 0, periodos: 0 };
          reg.total = +((reg.total || 0) + totalAporte).toFixed(2);
          reg.periodos = (reg.periodos || 0) + 1;
          reg.ultimo = Date.now();
          aportes[cmd.planId] = reg;
          appSettings.dcaAportes = aportes;
          await fb.saveSetting("server", "dcaAportes", aportes).catch(() => {});
          // Limpa o lembrete de hoje para este plano (já investiu).
          await fb.saveSetting("server", "dcaAporteConfirmado", { planId: cmd.planId, ts: Date.now() }).catch(() => {});
        }
        await fb.markCommand(cmd.id, "FEITO", `DCA manual registado (${cmd.itens.length} ativos)`);
        logger.info(`✅ DCA manual confirmado pelo utilizador (${cmd.planNome}) — posições registadas`);
      } else {
        await fb.markCommand(cmd.id, "FALHOU", "comando inválido");
      }
    } catch (e) {
      await fb.markCommand(cmd.id, "FALHOU", e.message).catch(() => {});
    }
  }
}

module.exports = { init, processCommands };
