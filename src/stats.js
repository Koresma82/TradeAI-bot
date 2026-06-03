// src/stats.js
// Calcula e guarda todas as métricas de performance

const { saveStats, saveBalance } = require("./firebase");
const { notify, tg }             = require("./telegram");
const logger                     = require("./logger");

class StatsEngine {
  constructor() {
    this.trades       = [];   // todos os trades fechados
    this.openPositions= [];   // posições actuais
    this.startBalance = 0;
    this.currentBalance = 0;
    this.dailyPnl     = 0;
    this.sessionStart = new Date();
  }

  setBalance(b) {
    this.startBalance   = this.startBalance || b;
    this.currentBalance = b;
  }

  addClosedTrade(trade) {
    this.trades.push(trade);
    this.dailyPnl += trade.pnl || 0;
    this.currentBalance += trade.pnl || 0;
    saveBalance(this.currentBalance).catch(() => {});
  }

  // ── Calcular todas as métricas ──────────────────────────────────────────────
  getMetrics() {
    const closed     = this.trades;
    const wins       = closed.filter(t => t.pnl > 0);
    const losses     = closed.filter(t => t.pnl <= 0);
    const totalPnl   = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    const winRate    = closed.length ? (wins.length / closed.length) * 100 : 0;
    const avgWin     = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss    = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    const profitFactor = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? 999 : 0;

    // Drawdown máximo
    let peak = this.startBalance, maxDD = 0, runningPnl = 0;
    for (const t of closed) {
      runningPnl += t.pnl || 0;
      const equity = this.startBalance + runningPnl;
      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }

    // Sharpe simplificado (retorno diário / desvio padrão)
    const dailyPnls  = this._groupByDay();
    const avgDaily   = dailyPnls.reduce((s, v) => s + v, 0) / (dailyPnls.length || 1);
    const stdDaily   = Math.sqrt(dailyPnls.reduce((s, v) => s + Math.pow(v - avgDaily, 2), 0) / (dailyPnls.length || 1));
    const sharpe     = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

    const daysSinceStart = Math.max(1, (Date.now() - this.sessionStart.getTime()) / 86400000);
    const roi        = this.startBalance > 0 ? (totalPnl / this.startBalance) * 100 : 0;
    const annualizedRoi = roi * (365 / daysSinceStart);

    return {
      totalTrades:   closed.length,
      wins:          wins.length,
      losses:        losses.length,
      winRate,
      totalPnl,
      pnlDay:        this.dailyPnl,
      avgWin,
      avgLoss,
      profitFactor,
      maxDrawdown:   maxDD,
      sharpe,
      roi,
      annualizedRoi,
      balance:       this.currentBalance,
      daysRunning:   Math.floor(daysSinceStart),
    };
  }

  _groupByDay() {
    const byDay = {};
    for (const t of this.trades) {
      const d = (t.closedAt || "").slice(0, 10) || "unknown";
      byDay[d] = (byDay[d] || 0) + (t.pnl || 0);
    }
    return Object.values(byDay);
  }

  // ── Relatório diário (chamado pelo cron) ─────────────────────────────────────
  async dailyReport(sendNotification = true) {
    const m = this.getMetrics();
    await saveStats(m);
    if (sendNotification) await notify(tg.dailyReport(m));
    logger.info(
      `📊 Stats: ${m.totalTrades} trades | WR ${m.winRate.toFixed(1)}% | ` +
      `P&L €${m.totalPnl.toFixed(2)} | DD ${m.maxDrawdown.toFixed(1)}% | Sharpe ${m.sharpe.toFixed(2)}`
    );

    // Reset diário
    this.dailyPnl = 0;
    return m;
  }

  // ── Verificar limite de perda diária ─────────────────────────────────────────
  checkDailyLossLimit() {
    const limit = parseFloat(process.env.DAILY_LOSS_LIMIT_EUR || "200");
    if (Math.abs(this.dailyPnl) >= limit && this.dailyPnl < 0) {
      logger.warn(`⚠ LIMITE PERDA DIÁRIA atingido: €${this.dailyPnl.toFixed(2)}`);
      notify(tg.alert(`Limite de perda diária atingido (€${this.dailyPnl.toFixed(2)}). Bot pausado até amanhã.`));
      return true;
    }
    return false;
  }
}

module.exports = new StatsEngine(); // singleton
