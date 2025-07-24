import { logger } from './logger';
import * as dotenv from 'dotenv';

dotenv.config();

interface RateLimiterConfig {
  maxRequestsPerSecond: number;
  burstSize?: number;
  adaptive?: boolean;
  minRequestsPerSecond?: number;
  maxRequestsPerSecondLimit?: number;
}

export class RpcRateLimiter {
  private maxRequestsPerSecond: number;
  private burstSize: number;
  private tokens: number;
  private lastRefill: number;
  private queue: Array<() => void> = [];
  private processing = false;
  
  // Adaptive rate limiting
  private adaptive: boolean;
  private minRequestsPerSecond: number;
  private maxRequestsPerSecondLimit: number;
  private successCount = 0;
  private errorCount = 0;
  private recent429Errors: number[] = [];
  private recentOtherErrors: number[] = [];
  private recentLatencies: number[] = [];
  private lastAdjustment = Date.now();
  private last429Time = 0;
  private consecutiveSuccesses = 0;
  private optimalRate = 0; // Track the highest proven successful rate (0 = no limit)

  constructor(config: RateLimiterConfig) {
    this.maxRequestsPerSecond = config.maxRequestsPerSecond;
    this.burstSize = config.burstSize || config.maxRequestsPerSecond;
    this.tokens = this.burstSize;
    this.lastRefill = Date.now();
    
    // Adaptive configuration
    this.adaptive = config.adaptive || false;
    this.minRequestsPerSecond = config.minRequestsPerSecond || 5;
    this.maxRequestsPerSecondLimit = config.maxRequestsPerSecondLimit || 50;
  }

  /**
   * Execute an RPC call with rate limiting and 429-aware adaptive adjustment
   */
  async execute<T>(fn: () => Promise<T>, name?: string): Promise<T> {
    const waitStart = Date.now();
    await this.waitForToken();
    const waitTime = Date.now() - waitStart;
    
    if (waitTime > 100) {
      logger.debug(`⏱️ Rate limiter wait${name ? ` (${name})` : ''}: ${waitTime}ms`);
    }
    
    try {
      const startTime = Date.now();
      const result = await fn();
      const duration = Date.now() - startTime;
      
      // Track success metrics for adaptive adjustment
      this.successCount++;
      this.consecutiveSuccesses++;
      this.trackLatency(duration);
      
      // Update optimal rate only after we've proven a rate works for a significant time
      if (this.adaptive && this.consecutiveSuccesses >= 50) {
        this.optimalRate = Math.max(this.optimalRate, this.maxRequestsPerSecond);
      }
      
      if (this.adaptive) {
        this.adjustRateBasedOnPerformance();
      }
      
      if (duration > 1000) {
        logger.debug(`⚠️ Slow RPC call${name ? ` (${name})` : ''}: ${duration}ms`);
      }
      
      return result;
    } catch (error) {
      // Reset consecutive successes on any error
      this.consecutiveSuccesses = 0;
      this.errorCount++;
      
      // Check if this is a 429 rate limit error
      const is429Error = this.is429RateLimitError(error);
      
      if (is429Error) {
        this.handle429Error();
      } else {
        this.trackOtherError();
      }
      
      if (this.adaptive) {
        if (is429Error) {
          // Immediate adjustment for 429 errors
          this.handle429Immediately();
        } else {
          // Regular adjustment for other errors
          this.adjustRateBasedOnPerformance();
        }
      }
      
      logger.debug(`❌ RPC call failed${name ? ` (${name})` : ''}${is429Error ? ' [429 RATE LIMIT]' : ''}:`, error);
      throw error;
    }
  }

  /**
   * Wait for an available token
   */
  private async waitForToken(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.processQueue();
    });
  }

  /**
   * Process the queue of waiting requests
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      this.refillTokens();

      if (this.tokens >= 1) {
        this.tokens -= 1;
        const resolve = this.queue.shift();
        if (resolve) resolve();
      } else {
        // Calculate wait time until next token
        const timeSinceLastRefill = Date.now() - this.lastRefill;
        const timeUntilNextToken = this.maxRequestsPerSecond > 0 
          ? (1000 / this.maxRequestsPerSecond) - timeSinceLastRefill 
          : 1000; // Fallback to 1 second if rate is 0
        
        if (timeUntilNextToken > 0 && timeUntilNextToken < 2147483647) { // Max 32-bit signed integer
          await this.sleep(Math.min(timeUntilNextToken, 30000)); // Max 30 seconds wait
        }
      }
    }

    this.processing = false;
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillTokens(): void {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    const tokensToAdd = (timePassed / 1000) * this.maxRequestsPerSecond;

    if (tokensToAdd >= 1) {
      this.tokens = Math.min(this.burstSize, this.tokens + Math.floor(tokensToAdd));
      this.lastRefill = now;
    }
  }

  /**
   * Check if error is a 429 rate limit error
   */
  private is429RateLimitError(error: any): boolean {
    if (!error) return false;
    
    // Check for HTTP 429 status
    if (error.status === 429 || error.statusCode === 429) {
      return true;
    }
    
    // Check for RPC rate limit messages
    const errorMessage = (error.message || error.toString()).toLowerCase();
    const rateLimitKeywords = [
      'rate limit',
      'too many requests',
      '429',
      'quota exceeded',
      'rate exceeded',
      'request limit',
      'throttle',
      'backoff'
    ];
    
    return rateLimitKeywords.some(keyword => errorMessage.includes(keyword));
  }

  /**
   * Handle 429 rate limit error tracking
   */
  private handle429Error(): void {
    const now = Date.now();
    this.recent429Errors.push(now);
    this.last429Time = now;
    
    // Keep only 429 errors from last 5 minutes
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    this.recent429Errors = this.recent429Errors.filter(timestamp => timestamp > fiveMinutesAgo);
  }

  /**
   * Handle other (non-429) errors
   */
  private trackOtherError(): void {
    this.recentOtherErrors.push(Date.now());
    // Keep only errors from last 5 minutes
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    this.recentOtherErrors = this.recentOtherErrors.filter(timestamp => timestamp > fiveMinutesAgo);
  }

  /**
   * Track latency for adaptive adjustment
   */
  private trackLatency(duration: number): void {
    this.recentLatencies.push(duration);
    // Keep only last 100 latencies
    if (this.recentLatencies.length > 100) {
      this.recentLatencies.shift();
    }
  }

  /**
   * Handle 429 error with gradual rate reduction
   */
  private handle429Immediately(): void {
    const currentRate = this.maxRequestsPerSecond;
    
    // Gradual reduction for 429 errors - reduce by 20-30% instead of 50%
    const reductionFactor = currentRate > 10 ? 0.7 : 0.8; // More aggressive reduction for higher rates
    const newRate = Math.max(this.minRequestsPerSecond, Math.floor(currentRate * reductionFactor));
    
    if (newRate !== currentRate) {
      this.maxRequestsPerSecond = newRate;
      logger.warn(`🚨 429 Rate Limit Hit! Reducing RPC rate: ${currentRate} → ${newRate} req/s (${Math.round((1-reductionFactor)*100)}% reduction)`);
      
      // Reduce tokens gradually instead of clearing all
      this.tokens = Math.max(0, this.tokens * 0.5);
      this.lastRefill = Date.now();
    }
  }

  /**
   * Adjust rate based on performance metrics with gradual 429-aware logic
   */
  private adjustRateBasedOnPerformance(): void {
    const now = Date.now();
    
    // Check for recent 429 errors - if any, be more conservative
    const recent429Count = this.recent429Errors.length;
    const timeSinceLast429 = now - this.last429Time;
    
    // Dynamic adjustment intervals based on current rate and 429 history
    const baseInterval = this.maxRequestsPerSecond <= 5 ? 10000 : 15000; // Much faster adjustments for low rates
    const adjustmentInterval = recent429Count > 0 ? baseInterval * 1.5 : baseInterval;
    
    // Only adjust periodically
    if (now - this.lastAdjustment < adjustmentInterval) {
      return;
    }
    
    logger.debug(`🔧 Rate adjustment check: interval=${adjustmentInterval}ms, elapsed=${now - this.lastAdjustment}ms`);
    this.lastAdjustment = now;
    
    const totalRequests = this.successCount + this.errorCount;
    if (totalRequests < 3) { // Even lower threshold for quicker adaptation
      return;
    }
    
    const otherErrorRate = this.recentOtherErrors.length / Math.max(totalRequests, 1);
    const avgLatency = this.recentLatencies.length > 0 
      ? this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length 
      : 0;
    
    const currentRate = this.maxRequestsPerSecond;
    let newRate = currentRate;
    
    // Strategy based on 429 history and performance
    if (recent429Count > 0) {
      // We've had 429s recently - be very conservative with small steps
      if (timeSinceLast429 > 45000 && this.consecutiveSuccesses > 20) {
        // 45+ seconds since last 429 and good successes - tiny increase
        newRate = Math.min(this.maxRequestsPerSecondLimit, currentRate + 0.5);
        newRate = Math.round(newRate);
        if (newRate > currentRate) {
          logger.info(`🔼 Cautious increase after 429s: ${currentRate} → ${newRate} req/s (${this.consecutiveSuccesses} successes, ${Math.round(timeSinceLast429/1000)}s since 429)`);
        }
      }
    } else {
      // No recent 429s - use gradual adaptive logic
      if (otherErrorRate > 0.15 || avgLatency > 3000) {
        // High other errors or latency - gradual decrease
        const reductionFactor = otherErrorRate > 0.2 ? 0.7 : 0.85;
        newRate = Math.max(this.minRequestsPerSecond, Math.floor(currentRate * reductionFactor));
        logger.info(`🔽 Reducing RPC rate: ${currentRate} → ${newRate} req/s (errors: ${(otherErrorRate * 100).toFixed(1)}%, latency: ${avgLatency.toFixed(0)}ms)`);
      } else if (otherErrorRate < 0.1 && avgLatency < 1200 && this.consecutiveSuccesses > 8) {
        // Good performance - gradual increase (relaxed conditions)
        logger.debug(`🔧 Rate increase conditions met: errors=${(otherErrorRate * 100).toFixed(1)}% < 10%, latency=${avgLatency.toFixed(0)}ms < 1200ms, successes=${this.consecutiveSuccesses} > 8`);
        let increment;
        if (currentRate < 5) {
          increment = 0.5; // Slower increase at low rates
        } else if (currentRate < 15) {
          increment = 1; // Medium increase at medium rates  
        } else {
          increment = 1.5; // Slightly faster at higher rates
        }
        
        const maxIncrease = this.optimalRate > 0 ? Math.min(this.optimalRate, this.maxRequestsPerSecondLimit) : this.maxRequestsPerSecondLimit;
        newRate = Math.min(maxIncrease, currentRate + increment);
        newRate = Math.round(newRate * 2) / 2; // Round to nearest 0.5
        logger.debug(`🔧 Rate calculation: current=${currentRate}, increment=${increment}, maxIncrease=${maxIncrease}, newRate=${newRate}, optimalRate=${this.optimalRate}`);
        
        if (newRate > currentRate) {
          logger.info(`🔼 Gradual increase: ${currentRate} → ${newRate} req/s (${this.consecutiveSuccesses} successes, ${(otherErrorRate * 100).toFixed(1)}% errors)`);
        } else {
          logger.debug(`🔧 No rate increase: conditions not met (errors: ${(otherErrorRate * 100).toFixed(1)}%, latency: ${avgLatency.toFixed(0)}ms, successes: ${this.consecutiveSuccesses})`);
        }
      }
    }
    
    if (newRate !== currentRate) {
      this.maxRequestsPerSecond = newRate;
      
      // Partial reset - keep some history for better adaptation
      this.successCount = Math.floor(this.successCount * 0.5);
      this.errorCount = Math.floor(this.errorCount * 0.5);
      this.consecutiveSuccesses = Math.floor(this.consecutiveSuccesses * 0.7);
    }
  }

  /**
   * Get current rate limiter status with 429-aware adaptive metrics
   */
  getStatus(): {
    availableTokens: number;
    queueLength: number;
    maxRequestsPerSecond: number;
    burstSize: number;
    adaptive: boolean;
    successCount: number;
    errorCount: number;
    errorRate: number;
    avgLatency: number;
    recent429Count: number;
    timeSinceLast429: number;
    consecutiveSuccesses: number;
    optimalRate: number;
  } {
    this.refillTokens();
    const totalRequests = this.successCount + this.errorCount;
    const errorRate = totalRequests > 0 ? this.errorCount / totalRequests : 0;
    const avgLatency = this.recentLatencies.length > 0 
      ? this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length 
      : 0;
    const timeSinceLast429 = this.last429Time > 0 ? Date.now() - this.last429Time : 999999999;
    
    return {
      availableTokens: Math.floor(this.tokens),
      queueLength: this.queue.length,
      maxRequestsPerSecond: this.maxRequestsPerSecond,
      burstSize: this.burstSize,
      adaptive: this.adaptive,
      successCount: this.successCount,
      errorCount: this.errorCount,
      errorRate,
      avgLatency,
      recent429Count: this.recent429Errors.length,
      timeSinceLast429,
      consecutiveSuccesses: this.consecutiveSuccesses,
      optimalRate: this.optimalRate,
    };
  }

  /**
   * Update rate limit configuration
   */
  updateConfig(config: Partial<RateLimiterConfig>): void {
    if (config.maxRequestsPerSecond !== undefined) {
      this.maxRequestsPerSecond = config.maxRequestsPerSecond;
      logger.info(`🔧 RPC rate limit updated to ${this.maxRequestsPerSecond} req/s`);
    }
    if (config.burstSize !== undefined) {
      this.burstSize = config.burstSize;
    }
  }

  /**
   * Sleep utility - with safety check for timeout overflow
   */
  private sleep(ms: number): Promise<void> {
    // Clamp to safe values
    const safeMs = Math.max(0, Math.min(ms, 2147483647));
    return new Promise(resolve => setTimeout(resolve, safeMs));
  }
}

// Create in-memory rate limiter instance
export const rpcRateLimiter = new RpcRateLimiter({
  maxRequestsPerSecond: parseInt(process.env['RPC_INITIAL_REQUESTS_PER_SECOND'] || '5'),
  burstSize: parseInt(process.env['RPC_BURST_SIZE'] || '5'),
  adaptive: process.env['RPC_ADAPTIVE'] === 'true',
  minRequestsPerSecond: parseFloat(process.env['RPC_MIN_REQUESTS_PER_SECOND'] || '1'),
  maxRequestsPerSecondLimit: parseInt(process.env['RPC_MAX_REQUESTS_PER_SECOND'] || '30'),
});