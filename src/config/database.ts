import { DataSource } from 'typeorm';
import { logger } from '../utils/logger';
import { Pool } from '../models/Pool';
import { Token } from '../models/Token';
import { PoolQueue } from '../models/PoolQueue';
import * as dotenv from 'dotenv';

dotenv.config();

// Determine database type from environment
const dbType = process.env['DB_TYPE'] || 'postgres';

// Configure database connection based on type
const databaseConfig: any = dbType === 'postgres' ? {
  type: 'postgres',
  host: process.env['DB_HOST'] || 'localhost',
  port: parseInt(process.env['DB_PORT'] || '5432'),
  username: process.env['DB_USERNAME'] || 'dex_indexer',
  password: process.env['DB_PASSWORD'] || 'dex_indexer_secret',
  database: process.env['DB_DATABASE'] || 'solana_dex_indexer',
  synchronize: true,
  logging: process.env['NODE_ENV'] === 'development',
  entities: [Pool, Token, PoolQueue],
  migrations: ['src/migrations/*.ts'],
  subscribers: ['src/subscribers/*.ts'],
} : {
  type: 'sqlite',
  database: process.env['DB_PATH'] || './data/solana_dex_indexer.db',
  synchronize: true,
  logging: process.env['NODE_ENV'] === 'development',
  entities: [Pool, Token, PoolQueue],
  migrations: ['src/migrations/*.ts'],
  subscribers: ['src/subscribers/*.ts'],
};

export const AppDataSource = new DataSource(databaseConfig);

logger.info(`🗄️ Using ${dbType.toUpperCase()} database for Solana DEX Indexer`);

export const initializeDatabase = async (): Promise<void> => {
  try {
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
      logger.info('✅ Database connection established successfully.');
    } else {
      logger.info('✅ Database is already connected.');
    }
  } catch (error) {
    logger.error('❌ Database connection failed:', error);
    throw error;
  }
};

export const closeDatabase = async (): Promise<void> => {
  try {
    await AppDataSource.destroy();
    logger.info('✅ Database connection closed successfully.');
  } catch (error) {
    logger.error('❌ Database connection close failed:', error);
    throw error;
  }
};
