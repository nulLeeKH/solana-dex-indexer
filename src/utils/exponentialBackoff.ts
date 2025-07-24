import { logger } from './logger';

export interface BackoffOptions {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  jitter: boolean;
}

export const DEFAULT_BACKOFF_OPTIONS: BackoffOptions = {
  maxRetries: parseInt(process.env['RPC_EXPONENTIAL_BACKOFF_MAX_RETRIES'] || '3'),
  initialDelay: parseInt(process.env['RPC_EXPONENTIAL_BACKOFF_BASE_DELAY'] || '500'),
  maxDelay: parseInt(process.env['RPC_EXPONENTIAL_BACKOFF_MAX_DELAY'] || '8000'),
  backoffMultiplier: 2,
  jitter: true,
};

/**
 * Exponential backoff utility with jitter for handling rate limiting
 */
export class ExponentialBackoff {
  private options: BackoffOptions;

  constructor(options: Partial<BackoffOptions> = {}) {
    this.options = { ...DEFAULT_BACKOFF_OPTIONS, ...options };
  }

  /**
   * Execute a function with exponential backoff retry logic
   */
  async execute<T>(
    fn: () => Promise<T>,
    context: string = 'operation'
  ): Promise<T> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        const result = await fn();
        
        // Log success after retries
        if (attempt > 0) {
          logger.info(`✅ ${context} succeeded after ${attempt} retries`);
        }
        
        return result;
      } catch (error) {
        lastError = error as Error;
        
        // Check if this is the last attempt
        if (attempt === this.options.maxRetries) {
          logger.error(`❌ ${context} failed after ${this.options.maxRetries} retries:`, lastError);
          throw lastError;
        }
        
        // Check if this is a rate limiting error
        if (this.isRateLimitError(error)) {
          const delay = this.calculateDelay(attempt);
          logger.warn(`⚠️  ${context} rate limited (attempt ${attempt + 1}/${this.options.maxRetries + 1}), retrying in ${delay}ms`);
          await this.sleep(delay);
        } else {
          // For non-rate-limiting errors, throw immediately
          logger.error(`❌ ${context} failed with non-rate-limiting error:`, error);
          throw error;
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Calculate delay for the given attempt with exponential backoff and jitter
   */
  private calculateDelay(attempt: number): number {
    const exponentialDelay = this.options.initialDelay * Math.pow(this.options.backoffMultiplier, attempt);
    const cappedDelay = Math.min(exponentialDelay, this.options.maxDelay);
    
    if (this.options.jitter) {
      // Add jitter to prevent thundering herd
      const jitterMultiplier = 0.5 + Math.random() * 0.5; // 0.5 to 1.0
      return Math.floor(cappedDelay * jitterMultiplier);
    }
    
    return cappedDelay;
  }

  /**
   * Check if the error is a rate limiting error
   */
  private isRateLimitError(error: any): boolean {
    if (!error) return false;
    
    const errorMessage = error.message?.toLowerCase() || '';
    const errorCode = error.code;
    
    // Common rate limiting indicators
    const rateLimitIndicators = [
      'too many requests',
      'rate limit',
      'rate limited',
      'too many calls',
      'request limit exceeded',
      'quota exceeded',
      'throttled',
      'service unavailable',
      'temporary unavailable',
      '429', // HTTP 429 Too Many Requests
      '503', // HTTP 503 Service Unavailable
      '502', // HTTP 502 Bad Gateway (sometimes used for rate limiting)
    ];
    
    return rateLimitIndicators.some(indicator => 
      errorMessage.includes(indicator) || 
      errorCode?.toString().includes(indicator)
    );
  }

  /**
   * Sleep for the specified number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Convenience function for quick exponential backoff execution
 */
export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  context: string = 'operation',
  options: Partial<BackoffOptions> = {}
): Promise<T> {
  const backoff = new ExponentialBackoff(options);
  return backoff.execute(fn, context);
}