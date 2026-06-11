// src/logger.js
const { createLogger, format, transports } = require("winston");
const path = require("path");

const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}`
    )
  ),
  transports: [
    new transports.Console(),
    new transports.File({
      filename: path.join(__dirname, "../logs/bot.log"),
      maxsize:  5 * 1024 * 1024, // 5MB
      maxFiles: 5,
    }),
  ],
});

module.exports = logger;

// Helpers de cor ANSI para destacar eventos importantes nos logs (Railway
// interpreta as cores). Verde = ganho/sucesso, vermelho = perda. Facilita
// localizar vendas no meio dos logs. Os códigos aparecem no ficheiro de log
// como texto, mas na consola do Railway ficam coloridos.
const C = { green: "\x1b[32m", red: "\x1b[31m", reset: "\x1b[0m", bold: "\x1b[1m" };
logger.win  = (msg) => logger.info(`${C.green}${C.bold}${msg}${C.reset}`);
logger.loss = (msg) => logger.info(`${C.red}${C.bold}${msg}${C.reset}`);
