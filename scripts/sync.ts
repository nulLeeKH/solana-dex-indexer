#!/usr/bin/env npx ts-node

import { Connection, PublicKey } from '@solana/web3.js';
import { AppDataSource } from '../src/config/database';
import { Pool } from '../src/models/Pool';
import { PoolQueue, QueueStatus, PoolType } from '../src/models/PoolQueue';
import { logger } from '../src/utils/logger';
import { rpcProvider } from '../src/utils/rpcProvider';
import { rpcRateLimiter } from '../src/utils/rpcRateLimiter';
import { withExponentialBackoff } from '../src/utils/exponentialBackoff';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Sync: 전체 풀 리스트 가져와서 queue에 한번에 삽입함
 * 파라미터 설정에 따라 현재 pools에 인덱싱되지 않은것만 넣도록 설정할 수 있음
 */
class PoolSync {
  private connection: Connection;
  private poolRepository = AppDataSource.getRepository(Pool);
  private poolQueueRepository = AppDataSource.getRepository(PoolQueue);
  
  private readonly programId = process.env['METEORA_PROGRAM_ID'] || 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
  private readonly batchSize = parseInt(process.env['SYNC_BATCH_SIZE'] || '1000');
  private readonly onlyMissing = process.env['SYNC_ONLY_MISSING'] === 'true';
  private readonly skipCompleted = process.env['SYNC_SKIP_COMPLETED'] === 'true';
  
  private discoveredCount = 0;
  private queuedCount = 0;
  private skippedCount = 0;

  constructor() {
    this.connection = rpcProvider.getConnection();
  }

  async performFullSync(): Promise<void> {
    try {
      logger.info('📋 Starting full pool discovery and sync...');
      
      if (!AppDataSource.isInitialized) {
        await AppDataSource.initialize();
        logger.info('✅ Database initialized');
      }

      logger.info(`📋 Program: ${this.programId}`);
      logger.info(`📋 Batch size: ${this.batchSize}`);
      logger.info(`📋 Only missing pools: ${this.onlyMissing}`);
      logger.info(`🚫 Skip completed pools: ${this.skipCompleted}`);

      const startTime = Date.now();
      
      // Get all pool accounts from the program
      await this.discoverAllPools();
      
      const duration = Date.now() - startTime;
      logger.info(`✅ Sync completed in ${Math.round(duration / 1000)}s`);
      logger.info(`📊 Results: ${this.discoveredCount} discovered, ${this.queuedCount} queued, ${this.skippedCount} skipped`);
      
    } catch (error) {
      logger.error('❌ Sync failed:', error);
      throw error;
    }
  }

  private async discoverAllPools(): Promise<void> {
    try {
      logger.info('🔍 Discovering all DAMMv2 pool accounts...');

      // Get all program accounts with the correct data size
      const accounts = await rpcRateLimiter.execute(
        () => withExponentialBackoff(
          () => this.connection.getProgramAccounts(new PublicKey(this.programId), {
            filters: [
              { dataSize: 1112 } // DAMMv2 pool data size
            ]
          }),
          'getProgramAccounts'
        ),
        'getProgramAccounts'
      );

      this.discoveredCount = accounts.length;
      logger.info(`🔍 Discovered ${this.discoveredCount} pool accounts`);

      if (this.discoveredCount === 0) {
        logger.warn('⚠️ No pool accounts found');
        return;
      }

      // Process in batches to avoid overwhelming the database
      const poolAddresses = accounts.map(account => account.pubkey.toString());
      await this.processBatches(poolAddresses);

    } catch (error) {
      logger.error('❌ Failed to discover pools:', error);
      throw error;
    }
  }

  private async processBatches(poolAddresses: string[]): Promise<void> {
    const totalBatches = Math.ceil(poolAddresses.length / this.batchSize);
    
    for (let i = 0; i < totalBatches; i++) {
      const start = i * this.batchSize;
      const end = Math.min(start + this.batchSize, poolAddresses.length);
      const batch = poolAddresses.slice(start, end);
      
      logger.info(`📋 Processing batch ${i + 1}/${totalBatches} (${batch.length} pools)`);
      
      await this.processBatch(batch);
      
      // Small delay between batches to avoid overwhelming the database
      if (i < totalBatches - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  private async processBatch(addresses: string[]): Promise<void> {
    let batchQueued = 0;
    let batchSkipped = 0;

    for (const address of addresses) {
      const result = await this.addToQueue(address);
      if (result) {
        batchQueued++;
      } else {
        batchSkipped++;
      }
    }

    this.queuedCount += batchQueued;
    this.skippedCount += batchSkipped;
    
    logger.info(`📋 Batch complete: ${batchQueued} queued, ${batchSkipped} skipped`);
  }

  private async addToQueue(poolAddress: string): Promise<boolean> {
    try {
      // Check if we should skip existing pools
      if (this.onlyMissing) {
        // Check if pool already exists in the pools table
        const existingPool = await this.poolRepository.findOne({
          where: { address: poolAddress }
        });
        
        if (existingPool) {
          logger.debug(`📋 Pool already indexed, skipping: ${poolAddress}`);
          return false;
        }
      }

      // Check existing queue item
      const existingQueueItem = await this.poolQueueRepository.findOne({
        where: { address: poolAddress }
      });

      if (existingQueueItem) {
        // PROCESSING 상태면 스킵 (다른 consumer가 처리중)
        if (existingQueueItem.status === QueueStatus.PROCESSING) {
          logger.debug(`📋 Already processing, skipping: ${poolAddress}`);
          return false;
        }
        
        // COMPLETED 상태일 때 스킵 옵션 확인
        if (existingQueueItem.status === QueueStatus.COMPLETED && this.skipCompleted) {
          logger.debug(`📋 Skipping completed pool (SYNC_SKIP_COMPLETED=true): ${poolAddress}`);
          return false;
        }
        
        // PENDING/FAILED/COMPLETED 상태 처리
        if (existingQueueItem.status === QueueStatus.PENDING || 
            existingQueueItem.status === QueueStatus.FAILED ||
            existingQueueItem.status === QueueStatus.COMPLETED) {
          
          const updateData: any = {
            status: QueueStatus.PENDING, // 다시 처리하도록 PENDING으로 변경
            retryCount: 0
          };
          
          // COMPLETED/FAILED 상태일 때는 기본 우선순위(2)로 리셋
          // PENDING 상태일 때만 조건부 승격
          if (existingQueueItem.status === QueueStatus.COMPLETED || existingQueueItem.status === QueueStatus.FAILED) {
            updateData.priority = 2; // Sync의 기본 우선순위
            logger.debug(`📋 Reset to priority 2 for SYNC: ${poolAddress}`);
          } else if (existingQueueItem.status === QueueStatus.PENDING && existingQueueItem.priority === 3) {
            updateData.priority = 2;
            logger.debug(`📋 Promoted priority 3 → 2 for SYNC: ${poolAddress}`);
          } else {
            logger.debug(`📋 Maintained priority ${existingQueueItem.priority} for SYNC: ${poolAddress}`);
          }
          
          await this.poolQueueRepository.update({ address: poolAddress }, updateData);
          return false; // Not newly added
        }
      }

      // Add new item to queue
      await this.poolQueueRepository.save({
        address: poolAddress,
        status: QueueStatus.PENDING,
        type: PoolType.METEORA_DAMMV2,
        priority: 2, // Medium priority
        retryCount: 0,
      });
      
      logger.debug(`📋 Queued from SYNC: ${poolAddress}`);
      return true;
    } catch (error: any) {
      if (error.code === '23505') {
        // 중복 키 에러 - 다른 프로세스가 이미 추가했음
        logger.debug(`📋 Pool ${poolAddress} already queued by another process`);
        return false;
      }
      logger.error(`Failed to add ${poolAddress} to queue:`, error);
      return false;
    }
  }

  getStatus(): {
    discoveredCount: number;
    queuedCount: number;
    skippedCount: number;
    programId: string;
    batchSize: number;
    onlyMissing: boolean;
  } {
    return {
      discoveredCount: this.discoveredCount,
      queuedCount: this.queuedCount,
      skippedCount: this.skippedCount,
      programId: this.programId,
      batchSize: this.batchSize,
      onlyMissing: this.onlyMissing,
    };
  }
}

async function runSync() {
  try {
    logger.info('🚀 Starting DAMMv2 Pool Sync Process...');
    
    const sync = new PoolSync();
    
    const startTime = Date.now();
    await sync.performFullSync();
    const duration = Date.now() - startTime;
    
    const status = sync.getStatus();
    logger.info(`✅ Sync completed in ${Math.round(duration / 1000)}s`);
    logger.info(`📊 Final results: ${status.discoveredCount} discovered, ${status.queuedCount} queued, ${status.skippedCount} skipped`);
    
    // Close database connection
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
      logger.info('✅ Database connection closed');
    }
    
    process.exit(0);
    
  } catch (error) {
    logger.error('❌ Sync failed:', error);
    
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
    
    process.exit(1);
  }
}

runSync().catch(async (error) => {
  logger.error('❌ Unhandled error in sync:', error);
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('🛑 Sync interrupted by user');
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('🛑 Sync terminated');
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
  process.exit(0);
});