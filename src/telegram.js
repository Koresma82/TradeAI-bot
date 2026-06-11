// src/telegram.js
const TelegramBot = require("node-telegram-bot-api");
const logger      = require("./logger");

// Duração legível entre dois timestamps (ms) → "2h15m", "45m", "30s".
function fmtDur(fromTs, toTs) {
  if (!fromTs || !toTs || toTs < fromTs) return null;
  const s = Math.floor((toTs - fromTs) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}
// Só a hora HH:MM de um openedAt/closedAt no formato pt-PT, se existir.
function horaDe(str) {
  if (!str || typeof str !== "string") return null;
  const m = str.match(/\b(\d{1,2}:\d{2})(:\d{2})?\b/);
  return m ? m[1] : null;
}

let bot;

function initTelegram() {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) {
    logger.warn("TELEGRAM_TOKEN não definido — notificações desactivadas");
    return;
  }
  bot = new TelegramBot(token);
  logger.info("Telegram Bot inicializado ✓");
}

async function notify(msg) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!bot || !chatId) return false;
  try {
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    return true;
  } catch (e) {
    logger.warn(`Telegram erro: ${e.message}`);
    return false;
  }
}

// ── Agrupamento de aberturas ────────────────────────────────────────────────
// Em vez de uma mensagem por cada compra (que causava spam com rotação/day-trade/
// AI), as aberturas entram numa fila e são enviadas num RESUMO periódico.
// Os fechos (vendas) continuam imediatos — são menos e mais importantes.
let _openQueue = [];
let _openTimer = null;
const OPEN_DIGEST_MIN = parseInt(process.env.TG_OPEN_DIGEST_MIN || "5"); // resumo a cada 5 min

function _flushOpenQueue() {
  if (!_openQueue.length) return;
  const items = _openQueue; _openQueue = [];
  // Agrupa por origem (estratégia/AI/day-trade) para leitura fácil.
  const porOrigem = {};
  for (const it of items) {
    const k = it.origem || "Outros";
    (porOrigem[k] = porOrigem[k] || []).push(it);
  }
  const linhas = [`📈 *${items.length} COMPRA${items.length > 1 ? "S" : ""} nos últimos ${OPEN_DIGEST_MIN}min*${items[0]?.mode ? ` _(${modeLabel(items[0].mode)})_` : ""}`];
  for (const [origem, lista] of Object.entries(porOrigem)) {
    linhas.push(`\n*${origem}* (${lista.length}):`);
    for (const it of lista) {
      linhas.push(`• ${it.assetSym} @ $${it.entryPrice} · €${it.amount}${it.confianca ? ` · ${it.confianca}%` : ""}`);
    }
  }
  notify(linhas.join("\n")).catch(() => {});
}

// Adiciona uma abertura à fila (em vez de notificar já). Arranca o timer do resumo.
function queueOpen(t, mode) {
  _openQueue.push({
    assetSym: t.assetSym || t.assetId, entryPrice: t.entryPrice, amount: t.amount,
    confianca: t.confianca, origem: t.origemLabel || t.strategy || "Estratégia", mode,
  });
  // Proteção: se a fila ficar muito grande, envia já (evita acumular demasiado).
  if (_openQueue.length >= 25) { _flushOpenQueue(); return; }
  if (!_openTimer) {
    _openTimer = setInterval(_flushOpenQueue, OPEN_DIGEST_MIN * 60 * 1000);
    if (_openTimer.unref) _openTimer.unref();
  }
}

// Teste explícito da ligação ao Telegram — envia uma mensagem e confirma nos logs.
// Chamado no arranque para validares que o canal funciona.
async function testConnection() {
  const token  = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token)  { logger.warn("Telegram: TELEGRAM_TOKEN em falta — teste ignorado"); return false; }
  if (!chatId) { logger.warn("Telegram: TELEGRAM_CHAT_ID em falta — teste ignorado"); return false; }
  if (!bot)    { logger.warn("Telegram: bot não inicializado — teste ignorado"); return false; }
  const ok = await notify(
    `✅ *Teste de Telegram OK*\nO bot consegue enviar-te mensagens.\n${new Date().toLocaleString("pt-PT")}`
  );
  if (ok) logger.info("Telegram: teste enviado com sucesso ✓ (verifica o telemóvel)");
  else    logger.warn("Telegram: teste FALHOU — verifica TOKEN/CHAT_ID e se já falaste com o bot");
  return ok;
}

// Etiqueta do modo para as mensagens (distingue os três modos claramente)
const modeLabel = (mode) => {
  const m = String(mode || "").toLowerCase();
  if (m === "real")  return "🔴 REAL";
  if (m === "paper") return "🟡 PAPER";
  if (m === "sim")   return "🟢 SIMULAÇÃO";
  return `⚪ ${m.toUpperCase() || "DESCONHECIDO"}`; // valor inesperado → mostra-o, nunca finge ser real/paper
};

// Mensagens formatadas
const tg = {
  tradeOpen: (t, mode) =>
    `📈 *${modeLabel(mode)} — COMPRA EXECUTADA*\n` +
    `Ativo: *${t.assetName}* (${t.assetSym})\n` +
    `Preço entrada: $${t.entryPrice}${horaDe(t.openedAt) ? ` · ${horaDe(t.openedAt)}` : ""}\n` +
    `Valor: €${t.amount} · ${t.units} unidades\n` +
    `SL: $${t.sl} · TP: $${t.tp}\n` +
    `Estratégia: _${t.strategy}_`,

  tradeClose: (t, pnl, reason, mode) => {
    const pct = (t.entryPrice && t.closePrice)
      ? ((t.closePrice - t.entryPrice) / t.entryPrice) * 100 : null;
    const hIn  = horaDe(t.openedAt);
    const hOut = horaDe(t.closedAt);
    const dur  = fmtDur(t.openedTs, t.closedTs);
    const linhas = [
      `${pnl >= 0 ? "✅" : "🛑"} *${reason} — POSIÇÃO FECHADA*${mode ? ` _(${modeLabel(mode)})_` : ""}`,
      `Ativo: *${t.assetName}*${t.assetSym ? ` (${t.assetSym})` : ""}`,
      `P&L: *${pnl >= 0 ? "+" : ""}€${pnl.toFixed(2)}*${pct != null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)` : ""}`,
      `Entrada: $${t.entryPrice} → Saída: $${t.closePrice}`,
    ];
    if (hIn || hOut) linhas.push(`Hora: ${hIn || "?"} → ${hOut || "?"}${dur ? ` · durou ${dur}` : ""}`);
    if (typeof t.amount === "number") linhas.push(`Investido: €${t.amount}`);
    if (typeof t.fee === "number" && t.fee > 0) linhas.push(`Comissão: €${t.fee.toFixed(2)}`);
    if (t.origem || t.strategy) linhas.push(`Origem: _${t.origem || t.strategy}_`);
    return linhas.join("\n");
  },

  dailyReport: (stats) =>
    `📊 *Relatório Diário TradeAI*\n\n` +
    `Trades: ${stats.totalTrades} · Wins: ${stats.wins} · Losses: ${stats.losses}\n` +
    `Win Rate: *${stats.winRate.toFixed(1)}%*\n` +
    `P&L Dia: *${stats.pnlDay >= 0 ? "+" : ""}€${stats.pnlDay.toFixed(2)}*\n` +
    `P&L Total: *${stats.pnlTotal >= 0 ? "+" : ""}€${stats.pnlTotal.toFixed(2)}*\n` +
    `Saldo: €${stats.balance.toFixed(2)}`,

  alert: (msg) => `⚠️ *ALERTA TradeAI*\n${msg}`,
  error: (msg) => `🔴 *ERRO TradeAI*\n\`${msg}\``,

  // Resumo diário detalhado por origem (enviado à meia-noite com o arquivo)
  dailySummary: (r) => {
    const linhas = Object.entries(r.porOrigem || {})
      .sort((a, b) => b[1].pnl - a[1].pnl) // melhor P&L primeiro
      .map(([origem, s]) => {
        const wr = s.n ? Math.round(s.wins / s.n * 100) : 0;
        const icon = origem === "AI Brain" ? "🤖"
                   : origem === "Day Trading" ? "⚡"
                   : origem === "Manual" ? "✋" : "🎯";
        return `${icon} *${origem}*: ${s.n} trades · WR ${wr}% · ${s.pnl >= 0 ? "+" : ""}€${s.pnl.toFixed(2)}`;
      })
      .join("\n");

    const wrTotal = r.count ? Math.round((r.wins || 0) / r.count * 100) : 0;
    return (
      `🗓 *Resumo do dia — ${r.day}*\n\n` +
      `Total: ${r.count} trades · WR ${wrTotal}%\n` +
      `P&L do dia: *${r.pnl >= 0 ? "+" : ""}€${r.pnl.toFixed(2)}*\n` +
      (linhas ? `\n*Por origem:*\n${linhas}` : "") +
      `\n\n_Arquivado. Vê o histórico completo na app._`
    );
  },
};

module.exports = { initTelegram, notify, queueOpen, testConnection, tg };
