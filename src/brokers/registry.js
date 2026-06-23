// src/brokers/registry.js
// ─────────────────────────────────────────────────────────────────────────────
// REGISTO DE BROKERS — o ÚNICO sítio onde se adiciona/remove um broker.
// ─────────────────────────────────────────────────────────────────────────────
// Para ACRESCENTAR um broker: cria o ficheiro adaptador (ex.: ibkr.adapter.js)
//   que cumpra o contrato em _interface.js, e adiciona-o ao array abaixo.
// Para REMOVER: tira a linha do array (ou comenta-a).
// Para DESATIVAR sem apagar: ele só fica "ativo" se isConnected() for true
//   (ou seja, se tiver as credenciais nas env vars). Sem credenciais, é ignorado.
//
// O motor (sim-engine.js) NUNCA importa daqui — só fala com broker.js (o router).

const adapters = [
  require("./alpaca.adapter"),
  require("./binance.adapter"),
  require("./xtb.adapter"),
  // require("./ibkr.adapter"),   // ← exemplo: descomenta quando criares o adaptador IBKR
];

// Devolve só os adaptadores que têm credenciais configuradas (= "disponíveis").
function available() {
  return adapters.filter(a => {
    try { return a.isConnected(); } catch { return false; }
  });
}

function all() { return adapters; }
function byId(id) { return adapters.find(a => a.id === id) || null; }

module.exports = { adapters, available, all, byId };
