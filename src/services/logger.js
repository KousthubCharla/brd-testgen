/**
 * Logger — Winston-based structured logging.
 * Logs what was crawled, skipped, and why (per assessment NFR).
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');

const LOG_DIR = path.resolve(__dirname, '../../logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const customFormat = winston.format.printf(({ level, message, timestamp, module, ...meta }) => {
  const mod = module ? `[${module}]` : '';
  const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${level.toUpperCase().padEnd(5)} ${mod} ${message}${extra}`;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    customFormat,
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        customFormat,
      ),
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'app.log'),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

/**
 * Create a child logger scoped to a module name.
 */
function createModuleLogger(moduleName) {
  return logger.child({ module: moduleName });
}

module.exports = { logger, createModuleLogger };
