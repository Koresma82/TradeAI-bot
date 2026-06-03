// src/index.js
require("dotenv").config();

const cron   = require("node-cron");
const http   = require("http");
const logger = require("./logger");
const fb     = require("./firebase");
const stats  = require("./stats");
const { initTelegram, notify, testConnection, tg } = require("./telegram");
const fs     = require("fs");
const path   = require("path");

const MODE   = process.env.MODE   || "sim";   // "sim" | "demo" | "real"
const BROKER = process.env.BROKER || "alpaca"; // "alpaca" | "ibkr" | "both"

// Criar pasta logs
const logsDir = path.join(__dirname, "../logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

// ── Health-check HTTP server ──────────────────────────────────────────────
// O Railway gosta de ver uma porta aberta. Também serve para confirmares que o
// bot está vivo abrindo o URL público do serviço.
function startHealthServer() {
  const port = process.env.PORT || 3000;
  http.createServer((req, res) => {
    const m = stats.getMetrics ? stats.getMetrics() : {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok:        true,
      mode:      MODE,
      broker:    BROKER,
      uptime_s:  Math.round(process.uptime()),
      trades:    m.totalTrades ?? null,
      pnl:       m.totalPnl ?? null,
      time:      new Date().toISOString(),
    }));
  }).listen(port, () => logger.info(`Health server na porta ${port} ✓`));
}

async function main() {
  try {
    startHealthServer();
    initTelegram();
    await testConnection(); // envia mensagem de teste — confirma que o Telegram funciona
    fb.initFirebase();

    logger.info(`═══════════════════════════════════`);
    logger.info(`  TradeAI Bot — Modo: ${MODE.toUpperCase()} | Broker: ${BROKER.toUpperCase()}`);
    logger.info(`═══════════════════════════════════`);

    if (MODE === "sim") {
      // ── MODO SIMULAÇÃO 24/7 — não precisa de corretora ──────────────────
      logger.info("Modo SIMULAÇÃO — sem corretora real");
      const simEngine = require("./sim-engine");
      const r = await simEngine.init();
      await notify(
        `🚀 *Deploy concluído — Bot SIM online*\n` +
        `Modo: Simulação\n` +
        `Saldo: €${(r?.balance ?? 0).toFixed(2)}\n` +
        `Posições recuperadas: ${r?.recovered ?? 0}\n` +
        `Tick: ${r?.tickSeconds ?? 30}s\n` +
        `${new Date().toLocaleString("pt-PT")}`
      );

    } else if (MODE === "paper" || MODE === "real") {
      // ── MODO PAPER/REAL — motor unificado (AI Brain) + execução Alpaca ───
      // O mesmo sim-engine que validámos, mas a camada broker.js executa
      // ordens reais na Alpaca. paper = dinheiro fictício; real = dinheiro real.
      logger.info(`Modo ${MODE.toUpperCase()} — execução via Alpaca`);
      const simEngine = require("./sim-engine");
      const r = await simEngine.init(); // init() verifica a corretora e aborta se falhar
      await notify(
        `🚀 *Deploy concluído — Bot ${MODE.toUpperCase()} online*\n` +
        `Broker: Alpaca (${MODE === "real" ? "💵 DINHEIRO REAL" : "📝 paper"})\n` +
        `Saldo: €${(r?.balance ?? 0).toFixed(2)}\n` +
        `Posições recuperadas: ${r?.recovered ?? 0}\n` +
        `${new Date().toLocaleString("pt-PT")}`
      );

    } else if (MODE === "demo") {
      // ── MODO DEMO antigo (IBKR) — mantido para retrocompatibilidade ──────
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
    // Guardar stats diárias às 21h (sem notificar — o resumo vai à meia-noite)
    cron.schedule("0 21 * * *", async () => {
      const m = await stats.dailyReport(false);
      logger.info(`📊 Stats guardadas: ${m.totalTrades} trades | WR ${m.winRate?.toFixed(1)}% | P&L €${m.totalPnl?.toFixed(2)}`);
    });

    // Heartbeat de hora em hora
    cron.schedule("0 * * * *", () => {
      const m = stats.getMetrics();
      logger.info(`♥ Heartbeat | Trades: ${m.totalTrades} | P&L: €${m.totalPnl?.toFixed(2)}`);
    });

    // Arquivo automático à meia-noite — move os trades fechados do dia anterior
    // para users/{uid}/archives/{dia} e limpa a lista ativa. (fuso de Portugal)
    cron.schedule("0 0 * * *", async () => {
      try {
        const r = await fb.archiveClosedTrades();
        if (r) {
          logger.info(`📁 Arquivo diário concluído: ${r.count} trades de ${r.day}`);
          await notify(tg.dailySummary(r)).catch(() => {});
        }
      } catch (err) {
        logger.error(`Arquivo diário falhou: ${err.message}`);
        await fb.logError("daily-archive", err).catch(() => {});
      }
    }, { timezone: "Europe/Lisbon" });

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
