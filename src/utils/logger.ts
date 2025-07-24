import winston from 'winston';

// 로거 설정
const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] || 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss',
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'solana-dex-indexer' },
  transports: [
    // 콘솔 출력
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    // 파일 출력 (에러)
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
    }),
    // 파일 출력 (모든 로그)
    new winston.transports.File({
      filename: 'logs/combined.log',
    }),
  ],
});

// 개발 환경에서는 더 자세한 로그 출력
if (process.env['NODE_ENV'] !== 'production') {
  logger.level = 'debug';
}

export { logger };
