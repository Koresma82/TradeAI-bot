// src/brokers/xtb.adapter.js
// ─────────────────────────────────────────────────────────────────────────────
// Adaptador XTB — broker MANUAL (ações/ETFs em Portugal, UCITS, sem comissão até
// 100k€/mês). O XTB não tem API pública para automação, por isso este adaptador
// NÃO executa ordens: declara as capacidades e marca-se como "manual".
//
// Como funciona o fluxo manual:
//   • O bot calcula o que comprar (motor DCA) e cria uma ordem manual + notifica.
//   • O utilizador compra na app do XTB e confirma na app TradeAI.
//   • A app regista a posição (stratId "dca", manualReal:true).
//
// Saldo: como não há API, o saldo vem das settings (xtbSaldo), que o utilizador
// introduz e a app desconta a cada compra confirmada. Este adaptador lê esse
// valor via a função injetada getManualBalance (definida no router/sim-engine),
// ou devolve null se não disponível.
//
// Taxas XTB (para o cálculo de custos):
//   • Comissão ações/ETF: 0% até 100.000€ de volume mensal (depois 0,2%, mín 10€).
//   • Conversão de moeda: 0,5% se o ETF não for na moeda da conta (evita-se com
//     ETFs UCITS em EUR e conta em EUR).
//   • Levantamentos < 220€ são taxados; taxa de inatividade após período sem uso.
// ─────────────────────────────────────────────────────────────────────────────

const logger = require("../logger");

// Ativos que o XTB cobre na nossa lista (ETFs UCITS + commodities via ETF).
// NÃO cobre cripto spot real (isso é Binance) nem forex à vista.
const SUPPORTED = new Set([
  "spy", "qqq", "iwm", "gld", "tlt", "xle", "eem", "vti",   // ETFs
  "gold", "silver", "wti", "brent", "natgas", "copper",      // commodities via ETF
  "plat", "wheat", "corn",
]);

// Saldo manual injetado pelo router (lido das settings). Default null.
let _manualBalanceProvider = null;
function setManualBalanceProvider(fn) { _manualBalanceProvider = fn; }

module.exports = {
  id: "xtb",
  name: "XTB",
  assetClasses: ["etf", "stock", "commodity"],
  manual: true,   // marca: o bot NÃO executa; avisa e o utilizador compra à mão.

  // Taxas, para o cálculo de custos no motor/relatório.
  fees: {
    comissao: 0,           // 0% até 100k€/mês
    comissaoAcima: 0.002,  // 0,2% acima de 100k€/mês
    conversaoMoeda: 0.005, // 0,5% se houver conversão de moeda
    limiteSemComissao: 100000,
  },

  supports(assetId) { return SUPPORTED.has(assetId); },

  // "Ligado" se o utilizador ativou o XTB (há saldo manual definido). Não há
  // credenciais de rede — é manual.
  isConnected() {
    try { return _manualBalanceProvider ? _manualBalanceProvider() != null : false; }
    catch { return false; }
  },

  async verifyConnection() {
    return { ok: true, name: "XTB", detail: "broker manual — sem API, compras confirmadas pelo utilizador" };
  },

  async getBalance() {
    try { return _manualBalanceProvider ? _manualBalanceProvider() : null; }
    catch { return null; }
  },

  // O XTB é manual: NÃO executa. Devolve manual:true para o motor criar uma ordem
  // manual em vez de tentar executar. (Na prática o motor DCA já trata os planos
  // manuais antes de chegar aqui; isto é uma salvaguarda.)
  async buy({ assetId, amount }) {
    logger.info(`XTB (manual): compra de €${amount} de ${assetId} requer ação do utilizador`);
    return { ok: false, manual: true, reason: "XTB é manual — confirma a compra na app" };
  },
  async sell({ assetId, units }) {
    return { ok: false, manual: true, reason: "XTB é manual — confirma a venda na app" };
  },

  setManualBalanceProvider,
};
