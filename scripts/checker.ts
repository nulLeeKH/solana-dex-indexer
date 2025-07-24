#!/usr/bin/env npx ts-node

import { AppDataSource } from '../src/config/database';
import { Pool } from '../src/models/Pool';
import { PoolQueue, QueueStatus, PoolType } from '../src/models/PoolQueue';
import { logger } from '../src/utils/logger';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Checker: 랜덤한 풀을 queue에 넣어주며 실시간 동기화, 빠뜨린 풀의 동기화를 유도함
 */
class PoolChecker {
  private poolRepository = AppDataSource.getRepository(Pool);
  private poolQueueRepository = AppDataSource.getRepository(PoolQueue);
  private isRunning = false;
  private checkerInterval: NodeJS.Timeout | null = null;
  private statusInterval: NodeJS.Timeout | null = null;
  
  private readonly checkInterval = parseInt(process.env['CHECKER_INTERVAL'] || '60000'); // 1분마다
  private readonly batchSize = parseInt(process.env['CHECKER_BATCH_SIZE'] || '5');
  private readonly maxAge = parseInt(process.env['CHECKER_MAX_AGE'] || '3600000'); // 1시간
  
  private checkedCount = 0;
  private queuedCount = 0;
  private skippedCount = 0;

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('🔍 Checker is already running');
      return;
    }

    try {
      logger.info('🔍 Starting Pool Checker...');
      
      if (!AppDataSource.isInitialized) {
        await AppDataSource.initialize();
        logger.info('✅ Database initialized');
      }

      logger.info(`🔍 Check interval: ${(this.checkInterval / 1000)}s, Batch size: ${this.batchSize}, Max age: ${(this.maxAge / 1000 / 60)}min`);
      
      this.isRunning = true;
      this.startChecking();
      this.startStatusLogging();

      logger.info('✅ Checker started successfully');
    } catch (error) {
      logger.error('❌ Failed to start checker:', error);
      this.isRunning = false;
      throw error;
    }
  }

  stop(): void {
    if (!this.isRunning) {
      logger.warn('🔍 Checker is not running');
      return;
    }

    logger.info('🛑 Stopping checker');
    this.isRunning = false;

    if (this.checkerInterval) {
      clearInterval(this.checkerInterval);
      this.checkerInterval = null;
    }

    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }

    logger.info('✅ Checker stopped');
  }

  private startChecking(): void {
    this.checkerInterval = setInterval(() => {
      this.checkRandomPools().catch(error => {
        logger.error('🔍 Error in checkRandomPools interval:', error);
      });
    }, this.checkInterval);
    
    // 즉시 한 번 실행
    this.checkRandomPools().catch(error => {
      logger.error('🔍 Error in initial checkRandomPools:', error);
    });
  }

  private async checkRandomPools(): Promise<void> {
    try {
      // 1. 오래된 풀 우선 선택 (lastUpdated가 오래된 것)
      const oldPools = await this.poolRepository
        .createQueryBuilder('pool')
        .where('pool.lastUpdated IS NULL OR pool.lastUpdated < :threshold', {
          threshold: new Date(Date.now() - this.maxAge)
        })
        .orderBy('RANDOM()')
        .limit(Math.ceil(this.batchSize / 2))
        .getMany();

      // 2. 완전 랜덤 풀 선택 (전체에서 랜덤)
      const randomPools = await this.poolRepository
        .createQueryBuilder('pool')
        .orderBy('RANDOM()')
        .limit(Math.ceil(this.batchSize / 2))
        .getMany();

      // 3. 중복 제거하고 결합
      const selectedPools = [...oldPools, ...randomPools]
        .filter((pool, index, arr) => 
          arr.findIndex(p => p.address === pool.address) === index
        )
        .slice(0, this.batchSize);

      logger.info(`🔍 Checker - Selected ${selectedPools.length} pools (${oldPools.length} old, ${randomPools.length - (selectedPools.length - oldPools.length)} random)`);

      let batchQueued = 0;
      let batchSkipped = 0;

      for (const pool of selectedPools) {
        const result = await this.addToQueue(pool.address);
        if (result) {
          batchQueued++;
        } else {
          batchSkipped++;
        }
        this.checkedCount++;
      }

      this.queuedCount += batchQueued;
      this.skippedCount += batchSkipped;

      if (batchQueued > 0) {
        logger.info(`🔍 Checker - Queued ${batchQueued} pools for update, skipped ${batchSkipped}`);
      }

    } catch (error) {
      logger.error('🔍 Error during pool checking:', error);
    }
  }

  private async addToQueue(poolAddress: string): Promise<boolean> {
    try {
      // 기존 큐 항목 확인
      const existingQueueItem = await this.poolQueueRepository.findOne({
        where: { address: poolAddress }
      });

      if (existingQueueItem) {
        // PROCESSING 상태면 스킵 (다른 consumer가 처리중)
        if (existingQueueItem.status === QueueStatus.PROCESSING) {
          logger.debug(`🔍 Already processing, skipping: ${poolAddress}`);
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
          
          // COMPLETED/FAILED 상태일 때는 기본 우선순위(3)로 리셋
          // PENDING 상태일 때는 더 높은 우선순위 유지
          if (existingQueueItem.status === QueueStatus.COMPLETED || existingQueueItem.status === QueueStatus.FAILED) {
            updateData.priority = 3; // Checker의 기본 우선순위
            logger.debug(`🔍 Reset to priority 3 for CHECKER: ${poolAddress}`);
          } else if (existingQueueItem.status === QueueStatus.PENDING && existingQueueItem.priority < 3) {
            logger.debug(`🔍 Keeping higher priority ${existingQueueItem.priority} for CHECKER: ${poolAddress}`);
          } else {
            updateData.priority = 3;
            logger.debug(`🔍 Maintained priority 3 for CHECKER: ${poolAddress}`);
          }
          
          await this.poolQueueRepository.update({ address: poolAddress }, updateData);
          return false; // 새로 추가한 것은 아니므로 false
        }
      }

      // 새 항목 삽입
      await this.poolQueueRepository.save({
        address: poolAddress,
        status: QueueStatus.PENDING,
        type: PoolType.METEORA_DAMMV2,
        priority: 3, // 백그라운드 체크는 낮은 우선순위
        retryCount: 0,
      });
      
      logger.debug(`🔍 Queued from CHECKER: ${poolAddress}`);
      return true;
    } catch (error: any) {
      logger.error(`Failed to add ${poolAddress} to queue:`, error);
      return false;
    }
  }

  private startStatusLogging(): void {
    this.statusInterval = setInterval(async () => {
      if (this.isRunning) {
        const totalPools = await this.getTotalPoolCount();
        const queueSize = await this.getQueueSize();
        const oldPoolsCount = await this.getOldPoolsCount();
        
        logger.info(`🔍 Checker - Checked: ${this.checkedCount} | Queued: ${this.queuedCount} | Skipped: ${this.skippedCount} | Total pools: ${totalPools} | Old pools: ${oldPoolsCount} | Queue size: ${queueSize}`);
      }
    }, 60000); // 1분마다
  }

  private async getTotalPoolCount(): Promise<number> {
    try {
      return await this.poolRepository.count();
    } catch (error) {
      return 0;
    }
  }

  private async getQueueSize(): Promise<number> {
    try {
      return await this.poolQueueRepository.count({
        where: { status: QueueStatus.PENDING }
      });
    } catch (error) {
      return 0;
    }
  }

  private async getOldPoolsCount(): Promise<number> {
    try {
      return await this.poolRepository
        .createQueryBuilder('pool')
        .where('pool.lastUpdated IS NULL OR pool.lastUpdated < :threshold', {
          threshold: new Date(Date.now() - this.maxAge)
        })
        .getCount();
    } catch (error) {
      return 0;
    }
  }

  getStatus(): {
    isRunning: boolean;
    checkedCount: number;
    queuedCount: number;
    skippedCount: number;
    checkInterval: number;
    batchSize: number;
    maxAge: number;
  } {
    return {
      isRunning: this.isRunning,
      checkedCount: this.checkedCount,
      queuedCount: this.queuedCount,
      skippedCount: this.skippedCount,
      checkInterval: this.checkInterval,
      batchSize: this.batchSize,
      maxAge: this.maxAge,
    };
  }
}

async function runChecker() {
  try {
    logger.info('🚀 Starting Pool Checker Process...');
    
    const checker = new PoolChecker();

    const shutdown = async () => {
      logger.info('🛑 Checker shutdown requested');
      checker.stop();
      
      if (AppDataSource.isInitialized) {
        await AppDataSource.destroy();
        logger.info('✅ Database connection closed');
      }
      
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await checker.start();
    process.stdin.resume();
    
  } catch (error) {
    logger.error('❌ Checker failed:', error);
    process.exit(1);
  }
}

runChecker().catch(async (error) => {
  logger.error('❌ Unhandled error in checker:', error);
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
  process.exit(1);
});