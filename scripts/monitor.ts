#!/usr/bin/env npx ts-node

import { AppDataSource } from '../src/config/database';
import { PoolQueue, QueueStatus, PoolType } from '../src/models/PoolQueue';
import { logger } from '../src/utils/logger';
import WebSocket from 'ws';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Monitor: 트랜잭션을 모니터링하면서 업데이트 후보 pool 리스트를 queue에 넣어줌
 */
class PoolMonitor {
  private poolQueueRepository = AppDataSource.getRepository(PoolQueue);
  private wsConnection: WebSocket | null = null;
  private isRunning = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly reconnectInterval = 5000;
  private statusInterval: NodeJS.Timeout | null = null;
  
  private readonly programId = process.env['METEORA_PROGRAM_ID'] || 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
  private readonly samplingRate = parseFloat(process.env['MONITOR_SAMPLING_RATE'] || '0.3');
  private readonly skipCompleted = process.env['MONITOR_SKIP_COMPLETED'] === 'true';
  
  private receivedCount = 0;
  private queuedCount = 0;
  private duplicateCount = 0;

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('📡 Monitor is already running');
      return;
    }

    try {
      logger.info('📡 Starting Pool Monitor...');
      
      if (!AppDataSource.isInitialized) {
        await AppDataSource.initialize();
        logger.info('✅ Database initialized');
      }

      logger.info(`📡 Monitoring program: ${this.programId}`);
      logger.info(`📊 Sampling rate: ${(this.samplingRate * 100).toFixed(1)}%`);
      logger.info(`🚫 Skip completed pools: ${this.skipCompleted}`);
      
      this.isRunning = true;
      this.reconnectAttempts = 0;

      await this.connectWebSocket();
      this.startStatusLogging();

      logger.info('✅ Monitor started successfully');
    } catch (error) {
      logger.error('❌ Failed to start monitor:', error);
      this.isRunning = false;
      throw error;
    }
  }

  stop(): void {
    if (!this.isRunning) {
      logger.warn('📡 Monitor is not running');
      return;
    }

    logger.info('🛑 Stopping monitor');
    this.isRunning = false;

    if (this.wsConnection) {
      this.wsConnection.close();
      this.wsConnection = null;
    }

    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }

    logger.info('✅ Monitor stopped');
  }

  private async connectWebSocket(): Promise<void> {
    try {
      const wsUrl = process.env['HELIUS_WS_URL'] || 
        'wss://mainnet.helius-rpc.com/?api-key=REDACTED';
      
      this.wsConnection = new WebSocket(wsUrl);

      this.wsConnection.on('open', () => {
        logger.info('📡 WebSocket connection established');
        this.reconnectAttempts = 0;

        const subscriptionRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'programSubscribe',
          params: [
            this.programId,
            {
              commitment: 'confirmed',
              encoding: 'base64',
              filters: [
                { dataSize: 1112 } // DAMMv2 pool size
              ]
            },
          ],
        };

        if (this.wsConnection) {
          this.wsConnection.send(JSON.stringify(subscriptionRequest));
          logger.info('✅ Subscribed to program account changes');
        }
      });

      this.wsConnection.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          logger.debug('Failed to parse WebSocket message:', error);
        }
      });

      this.wsConnection.on('close', () => {
        logger.warn('📡 WebSocket connection closed');
        this.handleReconnect();
      });

      this.wsConnection.on('error', (error: Error) => {
        logger.error('📡 WebSocket error:', error);
        this.handleReconnect();
      });
    } catch (error) {
      logger.error('Failed to establish WebSocket connection:', error);
      this.handleReconnect();
    }
  }

  private handleMessage(message: any): void {
    try {
      if (message.method === 'programNotification') {
        const notification = message.params?.result;
        if (notification?.value) {
          const accountAddress = notification.value.pubkey;
          
          if (!accountAddress) {
            return;
          }
          
          this.receivedCount++;
          
          // 샘플링 적용
          if (Math.random() < this.samplingRate) {
            this.addToQueue(accountAddress).catch(error => {
              logger.error(`📡 Failed to add ${accountAddress} to queue:`, error);
            });
          }
        }
      }
    } catch (error) {
      logger.debug('Failed to handle program notification:', error);
    }
  }

  private async addToQueue(accountAddress: string): Promise<void> {
    try {
      // 기존 항목 확인
      const existingItem = await this.poolQueueRepository.findOne({
        where: { address: accountAddress }
      });

      if (existingItem) {
        // PROCESSING 상태면 스킵 (다른 consumer가 처리중)
        if (existingItem.status === QueueStatus.PROCESSING) {
          this.duplicateCount++;
          logger.debug(`📡 Already processing, skipping: ${accountAddress}`);
          return;
        }
        
        // COMPLETED 상태일 때 스킵 옵션 확인
        if (existingItem.status === QueueStatus.COMPLETED && this.skipCompleted) {
          this.duplicateCount++;
          logger.debug(`📡 Skipping completed pool (MONITOR_SKIP_COMPLETED=true): ${accountAddress}`);
          return;
        }
        
        // PENDING/FAILED/COMPLETED 상태 처리
        if (existingItem.status === QueueStatus.PENDING || 
            existingItem.status === QueueStatus.FAILED || 
            existingItem.status === QueueStatus.COMPLETED) {
          
          const updateData: any = {
            status: QueueStatus.PENDING, // 다시 처리하도록 PENDING으로 변경
            retryCount: 0 // 재시도 횟수 리셋
          };
          
          // COMPLETED/FAILED 상태일 때는 기본 우선순위(1)로 리셋
          // PENDING 상태일 때만 조건부 승격
          if (existingItem.status === QueueStatus.COMPLETED || existingItem.status === QueueStatus.FAILED) {
            updateData.priority = 1; // Monitor의 기본 우선순위
            logger.debug(`📡 Reset to priority 1 for MONITOR: ${accountAddress}`);
          } else if (existingItem.status === QueueStatus.PENDING && existingItem.priority > 1) {
            updateData.priority = 1;
            logger.debug(`📡 Promoted priority ${existingItem.priority} → 1 for MONITOR: ${accountAddress}`);
          } else {
            logger.debug(`📡 Maintained priority ${existingItem.priority} for MONITOR: ${accountAddress}`);
          }
          
          await this.poolQueueRepository.update({ address: accountAddress }, updateData);
          this.duplicateCount++;
          return;
        }
      }

      // 새 항목 삽입
      await this.poolQueueRepository.save({
        address: accountAddress,
        status: QueueStatus.PENDING,
        type: PoolType.METEORA_DAMMV2,
        priority: 1, // 실시간 모니터링은 높은 우선순위
        retryCount: 0,
      });
      
      this.queuedCount++;
      logger.debug(`📡 Queued from MONITOR: ${accountAddress}`);
    } catch (error: any) {
      logger.error(`Failed to add ${accountAddress} to queue:`, error);
    }
  }

  private handleReconnect(): void {
    if (!this.isRunning) return;

    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      logger.error('📡 Max reconnection attempts reached. Stopping monitor.');
      this.stop();
      return;
    }

    logger.info(`📡 Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    setTimeout(() => {
      if (this.isRunning) {
        this.connectWebSocket();
      }
    }, this.reconnectInterval);
  }

  private startStatusLogging(): void {
    this.statusInterval = setInterval(async () => {
      if (this.isRunning) {
        const queueSize = await this.getQueueSize();
        const samplingPercent = (this.samplingRate * 100).toFixed(1);
        const queueRate = this.receivedCount > 0 ? ((this.queuedCount / this.receivedCount) * 100).toFixed(1) : '0';
        
        logger.info(`📡 Monitor - Received: ${this.receivedCount} | Queued: ${this.queuedCount} (${queueRate}%) | Duplicates: ${this.duplicateCount} | Queue size: ${queueSize} | Sampling: ${samplingPercent}%`);
      }
    }, 30000); // 30초마다
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
}

async function runMonitor() {
  try {
    logger.info('🚀 Starting Pool Monitor Process...');
    
    const monitor = new PoolMonitor();

    const shutdown = async () => {
      logger.info('🛑 Monitor shutdown requested');
      monitor.stop();
      
      if (AppDataSource.isInitialized) {
        await AppDataSource.destroy();
        logger.info('✅ Database connection closed');
      }
      
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await monitor.start();
    process.stdin.resume();
    
  } catch (error) {
    logger.error('❌ Monitor failed:', error);
    process.exit(1);
  }
}

runMonitor().catch(async (error) => {
  logger.error('❌ Unhandled error in monitor:', error);
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
  process.exit(1);
});