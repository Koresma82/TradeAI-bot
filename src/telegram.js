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
  if (!bot || !chatId) return;
  try {
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
  } catch (e) {
    logger.warn(`Telegram erro: ${e.message}`);
  }
}

// Mensagens formatadas
const tg = {
  tradeOpen: (t, mode) =>
    `📈 *${mode === "real" ? "🔴 REAL" : "🟡 DEMO"} — COMPRA EXECUTADA*\n` +
    `Ativo: *${t.assetName}* (${t.assetSym})\n` +
    `Preço entrada: $${t.entryPrice}\n` +
    `Valor: €${t.amount} · ${t.units} unidades\n` +
    `SL: $${t.sl} · TP: $${t.tp}\n` +
    `Estratégia: _${t.strategy}_`,

  tradeClose: (t, pnl, reason) =>
    `${pnl >= 0 ? "✅" : "🛑"} *${reason} — POSIÇÃO FECHADA*\n` +
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
};

module.exports = { initTelegram, notify, tg };
