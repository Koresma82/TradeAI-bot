#!/usr/bin/env node
/**
 * clean-daytrades.js — Limpa os day-trades LEGADOS do painel da app (dtState).
 *
 * CONTEXTO:
 *   O painel "Day Trading → Trades de Hoje" da app guarda os seus próprios trades
 *   numa setting separada (settings/dtState), à parte da coleção 'trades'. Isto é
 *   um resíduo da app antiga, quando a app fazia day-trading localmente. Agora o
 *   day-trade real é feito pelo BOT (e aparece na coleção 'trades' / lista paper).
 *   Estes trades do dtState ficam "presos" e desatualizados.
 *
 * O QUE FAZ:
 *   - Esvazia a lista de trades do dtState (trades: [], dailyPnl: 0).
 *   - PRESERVA as definições do day-trade (alvo, SL, confiança, ativos, ativo on/off).
 *
 * O QUE NÃO TOCA:
 *   - Coleção 'trades' (os trades reais do bot).
 *   - Arquivo Diário, simulação, estratégias, outras definições.
 *
 * USO:
 *   node scripts/clean-daytrades.js            # pré-visualização (não altera nada)
 *   node scripts/clean-daytrades.js --executar # limpa os trades do dtState
 *
 * Usa as mesmas credenciais do bot (FIREBASE_ADMIN_JSON / USER_UID).
 */
const admin = require("firebase-admin");
const fb = require("../src/firebase");

const EXECUTAR = process.argv.includes("--executar");

function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }

async function main() {
  const USER_UID = process.env.USER_UID;
  if (!USER_UID) fail("USER_UID não definido no ambiente.");

  // Reutiliza a inicialização do próprio bot (já testada, lida com FIREBASE_ADMIN_JSON).
  fb.initFirebase();
  const db = admin.firestore();
  const dtRef = db.collection("users").doc(USER_UID).collection("settings").doc("dtState");

  console.log(`\n${EXECUTAR ? "🗑  MODO EXECUTAR" : "👀 PRÉ-VISUALIZAÇÃO (não altera nada)"} · UID=${USER_UID}\n`);

  const snap = await dtRef.get();
  if (!snap.exists) {
    console.log("dtState não existe — nada a limpar. ✓");
    process.exit(0);
  }

  const dt = snap.data() || {};
  const trades = Array.isArray(dt.trades) ? dt.trades : [];
  console.log(`Day-trades no dtState: ${trades.length}`);
  console.log(`P&L diário guardado: €${(dt.dailyPnl || 0).toFixed ? (dt.dailyPnl || 0).toFixed(2) : dt.dailyPnl || 0}`);
  console.log(`Definições (preservadas): alvo=${dt.profitTarget}% · SL=${dt.maxLoss}% · conf=${dt.minConf}% · ativos=${(dt.assets || []).length}`);

  if (!trades.length) {
    console.log("\nJá está limpo — nenhum day-trade legado para apagar. ✓");
    process.exit(0);
  }

  if (!EXECUTAR) {
    console.log(`\n(Pré-visualização) Apagaria ${trades.length} day-trade(s) legado(s). As definições ficam intactas.`);
    console.log("Para executar:  node scripts/clean-daytrades.js --executar\n");
    process.exit(0);
  }

  await dtRef.set({ ...dt, trades: [], dailyPnl: 0 }, { merge: true });
  console.log(`\n✓ ${trades.length} day-trade(s) legado(s) apagado(s) do dtState.`);
  console.log("✓ Definições do day-trade preservadas.");
  console.log("\nNota: o day-trade real continua a ser feito pelo bot (lista paper).\n");
  process.exit(0);
}

main().catch((e) => fail(e.message));
