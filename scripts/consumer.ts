#!/usr/bin/env npx ts-node

import { Connection, PublicKey } from '@solana/web3.js';
import { AppDataSource } from '../src/config/database';
import { Pool } from '../src/models/Pool';
import { PoolQueue, QueueStatus } from '../src/models/PoolQueue';
import { logger } from '../src/utils/logger';
import { withExponentialBackoff } from '../src/utils/exponentialBackoff';
import { calculatePoolPrices } from '../src/utils/priceCalculator';
import { rpcRateLimiter } from '../src/utils/rpcRateLimiter';
import { getPoolFeeInfo } from '../src/utils/meteoraOptimalFeeExtractor';
import { rpcProvider } from '../src/utils/rpcProvider';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Consumer: 큐를 비우며 pools에 Insert 또는 Update함
 */
class PoolConsumer {
  private connection: Connection;
  private poolRepository = AppDataSource.getRepository(Pool);
  private poolQueueRepository = AppDataSource.getRepository(PoolQueue);
  private isRunning = false;
  private processingInterval: NodeJS.Timeout | null = null;
  private timeoutCleanupInterval: NodeJS.Timeout | null = null;
  private statusLoggingInterval: NodeJS.Timeout | null = null;
  
  // batchSize 제거 - 이제 하나씩만 처리
  private readonly processDelay = parseInt(process.env['CONSUMER_PROCESS_DELAY'] || '3000'); // 더 느리게
  private readonly maxRetries = parseInt(process.env['CONSUMER_MAX_RETRIES'] || '3');
  private readonly processingTimeout = parseInt(process.env['CONSUMER_PROCESSING_TIMEOUT'] || '300000'); // 5분
  
  // 우선순위 설정 (1, 2, 3 또는 'all' 가능)
  private readonly targetPriority = process.env['CONSUMER_TARGET_PRIORITY'] || 'all';
  private readonly priorities: number[];
  
  private processedCount = 0;
  private errorCount = 0;
  private poolsInserted = 0;
  private poolsUpdated = 0;
  private workerId: string;
  
  // 우선순위별 처리 통계
  private priority1Processed = 0;
  private priority2Processed = 0;
  private priority3Processed = 0;

  constructor(workerId?: string) {
    this.connection = rpcProvider.getConnection();
    this.workerId = workerId || `consumer-${process.pid}`;
    
    // 우선순위 설정 파싱
    if (this.targetPriority === 'all') {
      this.priorities = [1, 2, 3]; // 높은 우선순위 먼저
    } else {
      const priority = parseInt(this.targetPriority);
      if ([1, 2, 3].includes(priority)) {
        this.priorities = [priority];
      } else {
        throw new Error(`Invalid CONSUMER_TARGET_PRIORITY: ${this.targetPriority}. Use 1, 2, 3, or 'all'`);
      }
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn(`🔧 Consumer ${this.workerId} is already running`);
      return;
    }

    try {
      logger.info(`🔧 Starting Pool Consumer ${this.workerId}...`);
      
      if (!AppDataSource.isInitialized) {
        await AppDataSource.initialize();
        logger.info('✅ Database initialized');
      }
      
      this.isRunning = true;
      this.startTimeoutCleanup();
      this.startStatusLogging();
      
      // 비동기 처리 루프를 백그라운드에서 시작
      this.startProcessing().catch(error => {
        logger.error(`❌ Processing loop failed for ${this.workerId}:`, error);
        this.isRunning = false;
      });

      logger.info(`✅ Consumer ${this.workerId} started successfully`);
      logger.info(`🎯 Target priorities: [${this.priorities.join(', ')}]`);
    } catch (error) {
      logger.error(`❌ Failed to start consumer ${this.workerId}:`, error);
      this.isRunning = false;
      throw error;
    }
  }

  stop(): void {
    if (!this.isRunning) {
      logger.warn(`🔧 Consumer ${this.workerId} is not running`);
      return;
    }

    logger.info(`🛑 Stopping consumer ${this.workerId}`);
    this.isRunning = false;

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    if (this.timeoutCleanupInterval) {
      clearInterval(this.timeoutCleanupInterval);
      this.timeoutCleanupInterval = null;
    }

    if (this.statusLoggingInterval) {
      clearInterval(this.statusLoggingInterval);
      this.statusLoggingInterval = null;
    }

    logger.info(`✅ Consumer ${this.workerId} stopped`);
  }

  private async startProcessing(): Promise<void> {
    // 간단한 while 루프로 동기식 처리
    while (this.isRunning) {
      try {
        await this.processOnePool();
        
        // 처리 간 지연
        const delay = Math.min(this.processDelay, 2147483647);
        await new Promise(resolve => setTimeout(resolve, delay));
      } catch (error) {
        logger.error(`🔧 [${this.workerId}] Error in processing loop:`, error);
        await new Promise(resolve => setTimeout(resolve, 5000)); // 에러시 5초 대기
      }
    }
  }

  private startTimeoutCleanup(): void {
    this.timeoutCleanupInterval = setInterval(() => {
      this.cleanupTimeoutedItems();
    }, Math.min(60000, 2147483647)); // 1분마다
  }

  private async cleanupTimeoutedItems(): Promise<void> {
    try {
      const timeoutThreshold = new Date(Date.now() - this.processingTimeout);
      
      const result = await this.poolQueueRepository
        .createQueryBuilder()
        .update(PoolQueue)
        .set({ 
          status: QueueStatus.PENDING,
          processedBy: () => 'NULL',
          processedAt: () => 'NULL',
          retryCount: () => 'retryCount' // Keep the retry count
        })
        .where('status = :status', { status: QueueStatus.PROCESSING })
        .andWhere('processedAt < :threshold', { threshold: timeoutThreshold })
        .execute();

      if (result.affected && result.affected > 0) {
        logger.warn(`🔧 [${this.workerId}] Reset ${result.affected} timed-out items to pending`);
      }
    } catch (error) {
      logger.error(`🔧 [${this.workerId}] Failed to cleanup timed-out items:`, error);
    }
  }

  private async processOnePool(): Promise<void> {
    // 1. 우선순위 순서대로 PENDING 상태인 풀 하나 가져오기
    const queueItem = await this.selectPoolByPriority();

    if (!queueItem) {
      return; // 처리할 아이템이 없음
    }

    // 2. PROCESSING 상태로 업데이트 (원자적 처리)
    const updateResult = await this.poolQueueRepository
      .createQueryBuilder()
      .update(PoolQueue)
      .set({
        status: QueueStatus.PROCESSING,
        processedBy: this.workerId,
        processedAt: new Date()
      })
      .where('address = :address', { address: queueItem.address })
      .andWhere('status = :status', { status: QueueStatus.PENDING })
      .execute();

    // 3. 업데이트 실패시 (다른 consumer가 가져간 경우) 스킵
    if ((updateResult.affected ?? 0) === 0) {
      return;
    }

    logger.info(`🔧 [${this.workerId}] Processing pool: ${queueItem.address}`);

    try {
      // 4. 풀 처리
      const processResult = await this.processPool(queueItem.address);
      
      // 5. 결과에 따라 완료 또는 에러 처리
      if (processResult.success) {
        if (processResult.isNew) {
          this.poolsInserted++;
          logger.info(`🔧 [${this.workerId}] ➕ Inserted new pool: ${queueItem.address}`);
        } else {
          this.poolsUpdated++;
          logger.info(`🔧 [${this.workerId}] 🔄 Updated pool: ${queueItem.address}`);
        }
        await this.markAsCompleted(queueItem.address);
      } else {
        await this.handleProcessingError(queueItem, processResult.error || new Error('Unknown error'));
        this.errorCount++;
      }
      
      this.processedCount++;
      
      // 우선순위별 통계 업데이트
      if (queueItem.priority === 1) this.priority1Processed++;
      else if (queueItem.priority === 2) this.priority2Processed++;
      else if (queueItem.priority === 3) this.priority3Processed++;
      
    } catch (error) {
      this.errorCount++;
      await this.handleProcessingError(queueItem, error as Error);
      logger.debug(`🔧 [${this.workerId}] Failed to process ${queueItem.address}:`, error);
    }
  }

  /**
   * 우선순위 순서대로 선택 (높은 우선순위 먼저)
   */
  private async selectPoolByPriority(): Promise<PoolQueue | null> {
    try {
      // 설정된 우선순위 순서대로 처리
      for (const priority of this.priorities) {
        const queueItem = await this.poolQueueRepository.findOne({
          where: { 
            status: QueueStatus.PENDING,
            priority: priority
          },
          order: { createdAt: 'ASC' },
        });
        
        if (queueItem) {
          logger.debug(`🔧 [${this.workerId}] Found item with priority ${priority}`);
          return queueItem;
        }
      }
      
      logger.debug(`🔧 [${this.workerId}] No pending items found in priorities [${this.priorities.join(', ')}]`);
      return null;
    } catch (error) {
      logger.error(`🔧 [${this.workerId}] Error selecting pool by priority:`, error);
      return null;
    }
  }

  private async markAsCompleted(address: string): Promise<void> {
    try {
      await this.poolQueueRepository.update(
        { address },
        { 
          status: QueueStatus.COMPLETED,
          processedAt: new Date()
        }
      );
    } catch (error) {
      logger.debug(`Failed to mark ${address} as completed:`, error);
    }
  }

  private async handleProcessingError(queueItem: PoolQueue, error: Error): Promise<void> {
    try {
      const newRetryCount = queueItem.retryCount + 1;
      
      if (newRetryCount <= this.maxRetries) {
        await this.poolQueueRepository.update(
          { address: queueItem.address },
          { 
            status: QueueStatus.PENDING,
            retryCount: newRetryCount,
            errorMessage: error.message || String(error)
          }
        );
        logger.debug(`🔧 [${this.workerId}] Retry ${newRetryCount}/${this.maxRetries} for ${queueItem.address}`);
      } else {
        await this.poolQueueRepository.update(
          { address: queueItem.address },
          { 
            status: QueueStatus.FAILED,
            retryCount: newRetryCount,
            errorMessage: error.message || String(error),
            processedAt: new Date()
          }
        );
        logger.warn(`🔧 [${this.workerId}] Max retries exceeded for ${queueItem.address}: ${error.message}`);
      }
    } catch (updateError) {
      logger.error(`Failed to handle processing error for ${queueItem.address}:`, updateError);
    }
  }

  private async processPool(accountAddress: string): Promise<{ success: boolean; isNew?: boolean; error?: Error }> {
    try {
      logger.debug(`🔧 [${this.workerId}] Fetching account info for ${accountAddress}`);
      
      const accountInfo = await rpcRateLimiter.execute(
        () => withExponentialBackoff(
          () => this.connection.getAccountInfo(new PublicKey(accountAddress)),
          `getAccountInfo(${accountAddress})`
        ),
        `getAccountInfo(${accountAddress})`
      );

      logger.debug(`🔧 [${this.workerId}] Account info received for ${accountAddress}`);

      if (!accountInfo) {
        throw new Error(`Account not found: ${accountAddress}`);
      }

      logger.debug(`🔧 [${this.workerId}] Parsing pool data for ${accountAddress}`);
      const poolData = await this.parsePoolData(accountAddress, accountInfo.data);
      if (!poolData) {
        throw new Error(`Failed to parse pool data: ${accountAddress}`);
      }

      logger.debug(`🔧 [${this.workerId}] Calculating prices for ${accountAddress}`);
      const priceResult = await calculatePoolPrices(poolData, this.connection);
      logger.debug(`🔧 [${this.workerId}] Price calculation complete for ${accountAddress}`);

      const existingPool = await this.poolRepository.findOne({
        where: { address: accountAddress },
      });

      let isNew = false;

      if (existingPool) {
        await this.poolRepository.update(
          { address: accountAddress },
          {
            tokenABalance: poolData.tokenABalance,
            tokenBBalance: poolData.tokenBBalance,
            tokenADecimals: priceResult.tokenADecimals,
            tokenBDecimals: priceResult.tokenBDecimals,
            fee: poolData.fee,
            protocolFee: poolData.protocolFee,
            dynamicFeeAmount: poolData.dynamicFeeAmount,
            priceAToB: priceResult.priceAToB,
            priceBToA: priceResult.priceBToA,
            lastUpdated: new Date(),
          }
        );
      } else {
        const newPool = this.poolRepository.create({
          address: poolData.address,
          tokenA: poolData.tokenA,
          tokenB: poolData.tokenB,
          tokenABalance: poolData.tokenABalance,
          tokenBBalance: poolData.tokenBBalance,
          tokenADecimals: priceResult.tokenADecimals,
          tokenBDecimals: priceResult.tokenBDecimals,
          fee: poolData.fee,
          protocolFee: poolData.protocolFee,
          dynamicFeeAmount: poolData.dynamicFeeAmount,
          type: 'METEORA-DAMMv2',
          priceAToB: priceResult.priceAToB,
          priceBToA: priceResult.priceBToA,
          lastUpdated: new Date(),
        });
        await this.poolRepository.save(newPool);
        isNew = true;
      }
      
      return { success: true, isNew };
    } catch (error) {
      logger.debug(`🔧 [${this.workerId}] Failed to process pool ${accountAddress}:`, error);
      return { success: false, error: error as Error };
    }
  }

  private async parsePoolData(address: string, data: Buffer): Promise<any | null> {
    try {
      if (data.length < 1112) {
        return null;
      }

      const tokenAOffset = 168;
      const tokenBOffset = 200;
      const vaultAOffset = 232;
      const vaultBOffset = 264;

      const tokenABytes = data.slice(tokenAOffset, tokenAOffset + 32);
      const tokenBBytes = data.slice(tokenBOffset, tokenBOffset + 32);
      const vaultABytes = data.slice(vaultAOffset, vaultAOffset + 32);
      const vaultBBytes = data.slice(vaultBOffset, vaultBOffset + 32);
      
      const tokenA = new PublicKey(tokenABytes).toString();
      const tokenB = new PublicKey(tokenBBytes).toString();
      const vaultA = new PublicKey(vaultABytes).toString();
      const vaultB = new PublicKey(vaultBBytes).toString();

      let tokenABalance = '0';
      let tokenBBalance = '0';

      try {
        logger.debug(`🔧 [${this.workerId}] Fetching vault info for ${address}`);
        const [vaultAInfo, vaultBInfo] = await Promise.race([
          Promise.all([
            rpcRateLimiter.execute(
              () => withExponentialBackoff(
                () => this.connection.getAccountInfo(new PublicKey(vaultA)),
                `getVaultInfo(${vaultA})`
              ),
              `getVaultInfo(${vaultA})`
            ),
            rpcRateLimiter.execute(
              () => withExponentialBackoff(
                () => this.connection.getAccountInfo(new PublicKey(vaultB)),
                `getVaultInfo(${vaultB})`
              ),
              `getVaultInfo(${vaultB})`
            )
          ]),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Vault fetch timeout')), 5000)
          )
        ]) as any[];
        logger.debug(`🔧 [${this.workerId}] Vault info received for ${address}`);

        if (vaultAInfo && vaultAInfo.data.length >= 72) {
          const amountBytes = vaultAInfo.data.slice(64, 72);
          const amount = amountBytes.readBigUInt64LE(0);
          tokenABalance = amount.toString();
        }

        if (vaultBInfo && vaultBInfo.data.length >= 72) {
          const amountBytes = vaultBInfo.data.slice(64, 72);
          const amount = amountBytes.readBigUInt64LE(0);
          tokenBBalance = amount.toString();
        }
      } catch (vaultError) {
        logger.debug(`🔧 [${this.workerId}] Failed to fetch vault balances for ${address}:`, vaultError);
      }

      let feeInfo: any;
      try {
        logger.debug(`🔧 [${this.workerId}] Extracting fee info for ${address}`);
        feeInfo = await Promise.race([
          getPoolFeeInfo(this.connection, address, data),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Fee extraction timeout')), 5000)
          )
        ]);
        logger.debug(`🔧 [${this.workerId}] Fee info extracted for ${address}`);
      } catch (feeError: any) {
        logger.error(`🔧 [${this.workerId}] Failed to extract fee for pool ${address}:`, feeError);
        throw new Error(`Fee extraction failed: ${feeError?.message || String(feeError)}`);
      }

      return {
        address,
        tokenA,
        tokenB,
        tokenABalance,
        tokenBBalance,
        fee: feeInfo.baseFee,
        protocolFee: feeInfo.protocolFee,
        dynamicFeeAmount: feeInfo.dynamicFeeAmount,
      };
    } catch (error) {
      logger.debug(`🔧 [${this.workerId}] Pool parsing failed for ${address}:`, error);
      return null;
    }
  }

  private startStatusLogging(): void {
    this.statusLoggingInterval = setInterval(async () => {
      if (this.isRunning) {
        const queueStats = await this.getQueueStats();
        const total = this.priority1Processed + this.priority2Processed + this.priority3Processed;
        const p1Pct = total > 0 ? ((this.priority1Processed / total) * 100).toFixed(1) : '0.0';
        const p2Pct = total > 0 ? ((this.priority2Processed / total) * 100).toFixed(1) : '0.0';
        const p3Pct = total > 0 ? ((this.priority3Processed / total) * 100).toFixed(1) : '0.0';
        
        logger.info(`🔧 [${this.workerId}] Processed: ${this.processedCount} | Inserted: ${this.poolsInserted} | Updated: ${this.poolsUpdated} | Errors: ${this.errorCount}`);
        logger.info(`🎯 [${this.workerId}] Priority distribution: P1=${this.priority1Processed}(${p1Pct}%) P2=${this.priority2Processed}(${p2Pct}%) P3=${this.priority3Processed}(${p3Pct}%)`);
        logger.info(`📊 [${this.workerId}] Queue: P:${queueStats.pending} Pr:${queueStats.processing} C:${queueStats.completed} F:${queueStats.failed}`);
      }
    }, Math.min(60000, 2147483647));
  }

  private async getQueueStats(): Promise<{
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  }> {
    try {
      const [pending, processing, completed, failed] = await Promise.all([
        this.poolQueueRepository.count({ where: { status: QueueStatus.PENDING } }),
        this.poolQueueRepository.count({ where: { status: QueueStatus.PROCESSING } }),
        this.poolQueueRepository.count({ where: { status: QueueStatus.COMPLETED } }),
        this.poolQueueRepository.count({ where: { status: QueueStatus.FAILED } }),
      ]);

      return { pending, processing, completed, failed };
    } catch (error) {
      return { pending: 0, processing: 0, completed: 0, failed: 0 };
    }
  }

  getStatus(): {
    workerId: string;
    isRunning: boolean;
    processedCount: number;
    poolsInserted: number;
    poolsUpdated: number;
    errorCount: number;
  } {
    return {
      workerId: this.workerId,
      isRunning: this.isRunning,
      processedCount: this.processedCount,
      poolsInserted: this.poolsInserted,
      poolsUpdated: this.poolsUpdated,
      errorCount: this.errorCount,
    };
  }
}

async function runConsumer() {
  try {
    const workerId = process.argv[2] || `consumer-${process.pid}`;
    logger.info(`🚀 Starting Pool Consumer: ${workerId}...`);
    
    const consumer = new PoolConsumer(workerId);

    const shutdown = async () => {
      logger.info(`🛑 Consumer ${workerId} shutdown requested`);
      consumer.stop();
      
      if (AppDataSource.isInitialized) {
        await AppDataSource.destroy();
        logger.info('✅ Database connection closed');
      }
      
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await consumer.start();
    process.stdin.resume();
    
  } catch (error) {
    logger.error('❌ Consumer failed:', error);
    process.exit(1);
  }
}

runConsumer().catch(async (error) => {
  logger.error('❌ Unhandled error in consumer:', error);
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
  process.exit(1);
});