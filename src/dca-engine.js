// src/dca-engine.js
// ─────────────────────────────────────────────────────────────────────────────
// MOTOR DCA (Dollar-Cost Averaging) — o núcleo PASSIVO do bot.
//
// Filosofia: não tentar adivinhar o mercado. Comprar uma quantia fixa da carteira
// em intervalos regulares, e segurar. Os dados (backtester) provaram que isto bate
// qualquer estratégia ativa de indicadores nestes ativos. É o motor "férias":
// definir e esquecer.
//
// O que faz:
//   1. COMPRA PERIÓDICA: na frequência definida (semanal/quinzenal/mensal), compra
//      €dcaValorPeriodico repartido pela carteira-alvo (pesos do utilizador).
//   2. REEQUILÍBRIO: quando os pesos reais derivam do alvo além de dcaDerivaPct,
//      vende um pouco do que subiu e compra do que ficou para trás.
//
// Diferenças-chave face ao trading ativo:
//   • Posições DCA são HOLD — NÃO têm SL/TP, NUNCA são fechadas pela lógica de
//     stop. São marcadas com stratId "dca" para o motor de SL/TP as ignorar.
//   • Usa uma FATIA SEPARADA do capital (dcaPctCapital). O AI Trade nunca lhe toca.
//   • Corre sempre que dcaAtivo estiver ligado, independentemente do AI Trade.
//
// O bot é a autoridade única: isto corre no servidor 24/7. A app só define o plano.
// ─────────────────────────────────────────────────────────────────────────────

const logger = require("./logger");

const FREQ_MS = {
  semanal:   7  * 24 * 60 * 60 * 1000,
  quinzenal: 15 * 24 * 60 * 60 * 1000,
  mensal:    30 * 24 * 60 * 60 * 1000,
};

// Estado interno mínimo (o resto vem das settings e das posições reais).
let lastRebalanceCheck = 0;
const REBALANCE_CHECK_MS = 6 * 60 * 60 * 1000; // verifica deriva a cada 6h

// deps injetadas pelo sim-engine para reusar a sua infra (broker, fb, prices…).
//   ctx.settings()      → appSettings atual
//   ctx.dcaPositions()  → posições DCA abertas [{assetId, units, amount, entryPrice}]
//   ctx.dcaBalance()    → saldo disponível na fatia DCA (€)
//   ctx.priceOf(id)     → preço real fresco ou null
//   ctx.buyDCA(id, eur) → executa compra DCA (HOLD, sem SL/TP) e devolve fill
//   ctx.sellDCA(id, eur)→ vende parte de uma posição DCA (para reequilíbrio)
//   ctx.now()           → Date.now() (testável)
let ctx = null;
function init(context) { ctx = context; }

// ── Compra periódica ──────────────────────────────────────────────────────────
async function tickCompraPeriodica() {
  const s = ctx.settings();
  if (!s.dcaAtivo) return;
  const carteira = Array.isArray(s.dcaCarteira) ? s.dcaCarteira.filter(c => c.peso > 0) : [];
  if (!carteira.length) return; // sem plano configurado

  const agora = ctx.now();
  const intervalo = FREQ_MS[s.dcaFrequencia] || FREQ_MS.semanal;
  const proxima = s.dcaProximaCompra || 0;

  // Primeira vez (sem agendamento): agenda para já e compra agora.
  if (!proxima) {
    await executarCompraPeriodica(s, carteira);
    await ctx.agendarProxima(agora + intervalo);
    return;
  }
  // Ainda não chegou a hora.
  if (agora < proxima) return;

  await executarCompraPeriodica(s, carteira);
  // Agenda a próxima (a partir de agora, para não acumular atrasos).
  await ctx.agendarProxima(agora + intervalo);
}

async function executarCompraPeriodica(s, carteira) {
  const valorTotal = Number(s.dcaValorPeriodico) || 0;
  if (valorTotal <= 0) return;

  const saldo = ctx.dcaBalance();
  if (saldo < valorTotal) {
    logger.warn(`DCA: saldo da fatia (€${saldo.toFixed(2)}) < valor da compra (€${valorTotal}). Compra adiada.`);
    return;
  }

  const somaPesos = carteira.reduce((a, c) => a + c.peso, 0) || 100;
  logger.info(`📈 DCA: compra periódica de €${valorTotal} repartida por ${carteira.length} ativos`);

  for (const item of carteira) {
    const fatia = +(valorTotal * (item.peso / somaPesos)).toFixed(2);
    if (fatia < 1) continue; // ignora fatias minúsculas
    const px = ctx.priceOf(item.id);
    if (px == null) { logger.warn(`DCA: sem preço fresco para ${item.id} — fatia saltada`); continue; }
    try {
      await ctx.buyDCA(item.id, fatia);
      logger.info(`  ✓ DCA comprou €${fatia} de ${item.id}`);
    } catch (e) {
      logger.warn(`  ✗ DCA falhou compra de ${item.id}: ${e.message}`);
    }
  }
}

// ── Reequilíbrio ──────────────────────────────────────────────────────────────
// Compara pesos reais (valor de mercado de cada posição DCA) com os pesos-alvo.
// Se algum ativo derivar além de dcaDerivaPct, ajusta: vende o excedentário,
// compra o deficitário, voltando ao alvo. "Vender caro, comprar barato" automático.
async function tickReequilibrio() {
  const s = ctx.settings();
  if (!s.dcaAtivo || !s.dcaReequilibrar) return;
  const agora = ctx.now();
  if (agora - lastRebalanceCheck < REBALANCE_CHECK_MS) return;
  lastRebalanceCheck = agora;

  const carteira = Array.isArray(s.dcaCarteira) ? s.dcaCarteira.filter(c => c.peso > 0) : [];
  if (carteira.length < 2) return;

  const posicoes = ctx.dcaPositions();
  if (!posicoes.length) return;

  // Valor de mercado atual por ativo
  const valorPorAtivo = {};
  let valorTotal = 0;
  for (const p of posicoes) {
    const px = ctx.priceOf(p.assetId);
    if (px == null) return; // sem preço fresco → não arrisca reequilibrar
    const v = p.units * px;
    valorPorAtivo[p.assetId] = (valorPorAtivo[p.assetId] || 0) + v;
    valorTotal += v;
  }
  if (valorTotal <= 0) return;

  const somaPesos = carteira.reduce((a, c) => a + c.peso, 0) || 100;
  const derivaMax = Number(s.dcaDerivaPct) || 5;

  // Para cada ativo do alvo, calcula peso real vs alvo
  const ajustes = [];
  for (const item of carteira) {
    const alvo = (item.peso / somaPesos) * 100;
    const real = ((valorPorAtivo[item.id] || 0) / valorTotal) * 100;
    const deriva = real - alvo;
    if (Math.abs(deriva) >= derivaMax) {
      const eurAjuste = +((deriva / 100) * valorTotal).toFixed(2); // >0 = vender, <0 = comprar
      ajustes.push({ id: item.id, deriva: +deriva.toFixed(1), eur: eurAjuste });
    }
  }
  if (!ajustes.length) return;

  logger.info(`⚖️ DCA reequilíbrio: ${ajustes.length} ativos fora do alvo (deriva ≥ ${derivaMax}%)`);
  // Primeiro vende os excedentários (liberta saldo), depois compra os deficitários.
  for (const a of ajustes.filter(x => x.eur > 0)) {
    try { await ctx.sellDCA(a.id, a.eur); logger.info(`  ↓ vendeu €${a.eur} de ${a.id} (estava +${a.deriva}%)`); }
    catch (e) { logger.warn(`  ✗ venda reequilíbrio ${a.id}: ${e.message}`); }
  }
  for (const a of ajustes.filter(x => x.eur < 0)) {
    const eur = Math.abs(a.eur);
    if (ctx.dcaBalance() < eur) continue;
    try { await ctx.buyDCA(a.id, eur); logger.info(`  ↑ comprou €${eur} de ${a.id} (estava ${a.deriva}%)`); }
    catch (e) { logger.warn(`  ✗ compra reequilíbrio ${a.id}: ${e.message}`); }
  }
}

// Chamado pelo loop principal do sim-engine a cada tick.
async function tick() {
  if (!ctx) return;
  try { await tickCompraPeriodica(); } catch (e) { logger.warn(`DCA compra periódica: ${e.message}`); }
  try { await tickReequilibrio(); }    catch (e) { logger.warn(`DCA reequilíbrio: ${e.message}`); }
}

module.exports = { init, tick };
