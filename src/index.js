// src/index.js
require("dotenv").config();

const cron   = require("node-cron");
const logger = require("./logger");
const fb     = require("./firebase");
const stats  = require("./stats");
const { initTelegram, notify, tg } = require("./telegram");
const fs     = require("fs");
const path   = require("path");

const MODE   = process.env.MODE   || "sim";   // "sim" | "demo" | "real"
const BROKER = process.env.BROKER || "alpaca"; // "alpaca" | "ibkr" | "both"

// Criar pasta logs
const logsDir = path.join(__dirname, "../logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

async function main() {
  try {
    initTelegram();
    fb.initFirebase();

    logger.info(`═══════════════════════════════════`);
    logger.info(`  TradeAI Bot — Modo: ${MODE.toUpperCase()} | Broker: ${BROKER.toUpperCase()}`);
    logger.info(`═══════════════════════════════════`);

    if (MODE === "sim") {
      // ── MODO SIMULAÇÃO 24/7 — não precisa de corretora ──────────────────
      logger.info("Modo SIMULAÇÃO — sem corretora real");
      const simEngine = require("./sim-engine");
      await simEngine.init();
      await notify(`🤖 *TradeAI Bot SIM iniciado*\nCapital: €${process.env.SIM_CAPITAL || 1000}\n${new Date().toLocaleString("pt-PT")}`);

    } else if (MODE === "demo" || MODE === "real") {
      // ── MODO LIVE/DEMO — usa corretora real ─────────────────────────────
      let brokerReady = false;

      if (BROKER === "alpaca" || BROKER === "both") {
        const alpaca = require("./alpaca");
        if (alpaca.isConnected()) {
          await alpaca.getAccount();
          logger.info(`Alpaca conectado — ${alpaca.isLive() ? "LIVE" : "PAPER"} ✓`);
          brokerReady = true;
        } else {
          logger.warn("Alpaca não configurado — verifica ALPACA_API_KEY e ALPACA_SECRET_KEY");
        }
      }

      if (BROKER === "ibkr" || BROKER === "both") {
        const ibkr = require("./ibkr");
        await ibkr.connect(MODE);
        logger.info("IBKR conectado ✓");
        brokerReady = true;
      }

      if (!brokerReady) throw new Error("Nenhuma corretora configurada — verifica o .env");

      const engine = require("./engine");
      await engine.init();
      await notify(`🤖 *TradeAI Bot ${MODE.toUpperCase()} iniciado*\nBroker: ${BROKER}\n${new Date().toLocaleString("pt-PT")}`);
    }

    // ── CRON JOBS (comuns a todos os modos) ─────────────────────────────────
    // Relatório diário às 22h
    cron.schedule("0 21 * * *", async () => {
      const m = await stats.dailyReport();
      logger.info(`📊 Relatório: ${m.totalTrades} trades | WR ${m.winRate?.toFixed(1)}% | P&L €${m.totalPnl?.toFixed(2)}`);
    });

    // Heartbeat de hora em hora
    cron.schedule("0 * * * *", () => {
      const m = stats.getMetrics();
      logger.info(`♥ Heartbeat | Trades: ${m.totalTrades} | P&L: €${m.totalPnl?.toFixed(2)}`);
    });

    // ── GRACEFUL SHUTDOWN ──────────────────────────────────────────────────
    const shutdown = async (sig) => {
      logger.info(`${sig} — a encerrar…`);
      const m = stats.getMetrics();
      await fb.saveStats("server", m).catch(() => {});
      await notify(tg.alert(`Bot encerrado (${sig})`)).catch(() => {});
      process.exit(0);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT",  () => shutdown("SIGINT"));
    process.on("uncaughtException", async err => {
      logger.error(`UncaughtException: ${err.message}`);
      await fb.logError("uncaughtException", err).catch(() => {});
      await notify(tg.error(err.message)).catch(() => {});
    });

  } catch (err) {
    logger.error(`Erro fatal: ${err.message}\n${err.stack}`);
    process.exit(1);
  }
}

main();
