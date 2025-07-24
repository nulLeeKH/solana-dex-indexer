import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

interface RateLimiterState {
  tokens: number;
  lastRefill: number;
  requestsInProgress: number;
  lastUpdate: number;
  pid: number;
}

interface QueueItem {
  id: string;
  pid: number;
  timestamp: number;
  priority: number;
}

/**
 * Global RPC Rate Limiter that works across multiple processes
 * Uses file-based locking for inter-process communication
 */
export class GlobalRpcRateLimiter {
  private readonly stateFile: string;
  private readonly queueFile: string;
  private readonly lockFile: string;
  private readonly maxRequestsPerSecond: number;
  private readonly burstSize: number;
  private readonly checkInterval = 10; // Check every 10ms
  private isShuttingDown = false;

  constructor(config: {
    maxRequestsPerSecond: number;
    burstSize: number;
  }) {
    this.maxRequestsPerSecond = config.maxRequestsPerSecond;
    this.burstSize = config.burstSize || config.maxRequestsPerSecond;
    
    // Use a shared directory for state files
    const stateDir = path.join(process.cwd(), '.rpc-limiter');
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    
    this.stateFile = path.join(stateDir, 'state.json');
    this.queueFile = path.join(stateDir, 'queue.json');
    this.lockFile = path.join(stateDir, 'state.lock');
    
    // Initialize state if it doesn't exist
    this.initializeState();
    
    // Cleanup on exit
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());
  }

  private initializeState(): void {
    if (!fs.existsSync(this.stateFile)) {
      const initialState: RateLimiterState = {
        tokens: this.burstSize,
        lastRefill: Date.now(),
        requestsInProgress: 0,
        lastUpdate: Date.now(),
        pid: process.pid,
      };
      this.writeState(initialState);
    }
    
    if (!fs.existsSync(this.queueFile)) {
      this.writeQueue([]);
    }
  }

  /**
   * Execute an RPC call with global rate limiting
   */
  async execute<T>(fn: () => Promise<T>, name?: string): Promise<T> {
    const requestId = `${process.pid}-${Date.now()}-${Math.random()}`;
    const startTime = Date.now();
    
    // Add to queue
    await this.enqueue(requestId);
    
    // Wait for our turn
    await this.waitForTurn(requestId);
    
    const waitTime = Date.now() - startTime;
    if (waitTime > 100) {
      logger.debug(`⏱️ Global rate limiter wait${name ? ` (${name})` : ''}: ${waitTime}ms`);
    }
    
    try {
      // Mark request as in progress
      await this.incrementInProgress();
      
      const result = await fn();
      
      if (name && waitTime > 1000) {
        logger.debug(`✅ RPC call completed${name ? ` (${name})` : ''} after ${waitTime}ms wait`);
      }
      
      return result;
    } finally {
      // Mark request as complete
      await this.decrementInProgress();
    }
  }

  private async enqueue(requestId: string): Promise<void> {
    await this.withLock(async () => {
      const queue = this.readQueue();
      queue.push({
        id: requestId,
        pid: process.pid,
        timestamp: Date.now(),
        priority: 0, // Could be enhanced with priority levels
      });
      this.writeQueue(queue);
    });
  }

  private async waitForTurn(requestId: string): Promise<void> {
    while (!this.isShuttingDown) {
      const canProceed = await this.checkTurn(requestId);
      if (canProceed) {
        return;
      }
      await this.sleep(this.checkInterval);
    }
  }

  private async checkTurn(requestId: string): Promise<boolean> {
    return await this.withLock(async () => {
      const queue = this.readQueue();
      const state = this.readState();
      
      // Refill tokens
      this.refillTokens(state);
      
      // Clean up stale entries (older than 30 seconds)
      const now = Date.now();
      const cleanedQueue = queue.filter(item => 
        now - item.timestamp < 30000
      );
      
      // Check if we're at the front of the queue
      const position = cleanedQueue.findIndex(item => item.id === requestId);
      if (position !== 0) {
        // Not our turn yet
        if (cleanedQueue.length !== queue.length) {
          this.writeQueue(cleanedQueue);
        }
        return false;
      }
      
      // Check if we have a token
      if (state.tokens >= 1) {
        // Consume a token
        state.tokens -= 1;
        
        // Remove from queue
        cleanedQueue.shift();
        
        // Update state and queue
        this.writeState(state);
        this.writeQueue(cleanedQueue);
        
        return true;
      }
      
      return false;
    });
  }

  private refillTokens(state: RateLimiterState): void {
    const now = Date.now();
    const timePassed = now - state.lastRefill;
    const tokensToAdd = (timePassed / 1000) * this.maxRequestsPerSecond;
    
    if (tokensToAdd >= 1) {
      state.tokens = Math.min(this.burstSize, state.tokens + Math.floor(tokensToAdd));
      state.lastRefill = now;
    }
  }

  private async incrementInProgress(): Promise<void> {
    await this.withLock(async () => {
      const state = this.readState();
      state.requestsInProgress++;
      state.lastUpdate = Date.now();
      this.writeState(state);
    });
  }

  private async decrementInProgress(): Promise<void> {
    await this.withLock(async () => {
      const state = this.readState();
      state.requestsInProgress = Math.max(0, state.requestsInProgress - 1);
      state.lastUpdate = Date.now();
      this.writeState(state);
    });
  }

  /**
   * Get current status across all processes
   */
  async getGlobalStatus(): Promise<{
    availableTokens: number;
    queueLength: number;
    requestsInProgress: number;
    maxRequestsPerSecond: number;
    processes: number[];
  }> {
    return await this.withLock(async () => {
      const state = this.readState();
      const queue = this.readQueue();
      
      // Get unique PIDs from queue
      const processes = [...new Set(queue.map(item => item.pid))];
      
      return {
        availableTokens: Math.floor(state.tokens),
        queueLength: queue.length,
        requestsInProgress: state.requestsInProgress,
        maxRequestsPerSecond: this.maxRequestsPerSecond,
        processes,
      };
    });
  }

  private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const lockAcquired = await this.acquireLock();
    if (!lockAcquired) {
      // Retry with exponential backoff
      await this.sleep(10);
      return this.withLock(fn);
    }
    
    try {
      return await fn();
    } finally {
      this.releaseLock();
    }
  }

  private async acquireLock(): Promise<boolean> {
    try {
      // Try to create lock file exclusively
      const fd = fs.openSync(this.lockFile, 'wx');
      fs.closeSync(fd);
      return true;
    } catch (error) {
      // Lock already exists
      // Check if lock is stale (older than 5 seconds)
      try {
        const stats = fs.statSync(this.lockFile);
        if (Date.now() - stats.mtimeMs > 5000) {
          // Stale lock, remove it
          fs.unlinkSync(this.lockFile);
          return this.acquireLock();
        }
      } catch {
        // Lock file doesn't exist, retry
      }
      return false;
    }
  }

  private releaseLock(): void {
    try {
      fs.unlinkSync(this.lockFile);
    } catch {
      // Lock already released
    }
  }

  private readState(): RateLimiterState {
    try {
      const data = fs.readFileSync(this.stateFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      // Return default state if file doesn't exist or is corrupted
      return {
        tokens: this.burstSize,
        lastRefill: Date.now(),
        requestsInProgress: 0,
        lastUpdate: Date.now(),
        pid: process.pid,
      };
    }
  }

  private writeState(state: RateLimiterState): void {
    fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }

  private readQueue(): QueueItem[] {
    try {
      const data = fs.readFileSync(this.queueFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  private writeQueue(queue: QueueItem[]): void {
    fs.writeFileSync(this.queueFile, JSON.stringify(queue, null, 2));
  }

  private cleanup(): void {
    this.isShuttingDown = true;
    // Clean up our entries from the queue
    try {
      const queue = this.readQueue();
      const cleanedQueue = queue.filter(item => item.pid !== process.pid);
      this.writeQueue(cleanedQueue);
    } catch {
      // Ignore errors during cleanup
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Update rate limit configuration
   */
  async updateConfig(config: { maxRequestsPerSecond?: number; burstSize?: number }): Promise<void> {
    if (config.maxRequestsPerSecond !== undefined) {
      (this as any).maxRequestsPerSecond = config.maxRequestsPerSecond;
      logger.info(`🔧 Global RPC rate limit updated to ${config.maxRequestsPerSecond} req/s`);
    }
    if (config.burstSize !== undefined) {
      (this as any).burstSize = config.burstSize;
    }
  }
}

// Create singleton instance
export const globalRpcRateLimiter = new GlobalRpcRateLimiter({
  maxRequestsPerSecond: parseInt(process.env['RPC_INITIAL_REQUESTS_PER_SECOND'] || '5'),
  burstSize: parseInt(process.env['RPC_BURST_SIZE'] || '5'),
});