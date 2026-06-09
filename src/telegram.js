// src/telegram.js
const TelegramBot = require("node-telegram-bot-api");
const logger      = require("./logger");

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
const modeLabel = (mode) =>
  mode === "real"  ? "🔴 REAL"
  : mode === "paper" ? "🟡 PAPER"
  : "🟢 SIMULAÇÃO";

// Mensagens formatadas
const tg = {
  tradeOpen: (t, mode) =>
    `📈 *${modeLabel(mode)} — COMPRA EXECUTADA*\n` +
    `Ativo: *${t.assetName}* (${t.assetSym})\n` +
    `Preço entrada: $${t.entryPrice}\n` +
    `Valor: €${t.amount} · ${t.units} unidades\n` +
    `SL: $${t.sl} · TP: $${t.tp}\n` +
    `Estratégia: _${t.strategy}_`,

  tradeClose: (t, pnl, reason, mode) =>
    `${pnl >= 0 ? "✅" : "🛑"} *${reason} — POSIÇÃO FECHADA*${mode ? ` _(${modeLabel(mode)})_` : ""}\n` +
    `Ativo: *${t.assetName}*\n` +
    `P&L: *${pnl >= 0 ? "+" : ""}€${pnl.toFixed(2)}*\n` +
    `Entrada: $${t.entryPrice} → Saída: $${t.closePrice}`,

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

module.exports = { initTelegram, notify, testConnection, tg };
