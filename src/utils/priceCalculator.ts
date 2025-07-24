import { Pool } from '../models/Pool';
import { Token } from '../models/Token';
import { Connection } from '@solana/web3.js';
import { getTokenDecimals } from './tokenInfo';

export interface PriceCalculationResult {
  priceAToB: string;
  priceBToA: string;
  tokenADecimals: number;
  tokenBDecimals: number;
}

// Pool data interface (supports both Pool and MeteoraApiPool)
interface PoolData {
  tokenABalance: string;
  tokenBBalance: string;
}

/**
 * Calculate token prices based on pool balances with dynamic decimal fetching.
 * A/B price = B balance / A balance (1 A token = ? B tokens)
 * B/A price = A balance / B balance (1 B token = ? A tokens)
 */
export async function calculatePoolPrices(
  pool: Pool | PoolData,
  connection: Connection,
  tokenA?: Token,
  tokenB?: Token
): Promise<PriceCalculationResult> {
  // Use BigInt for accurate calculation, keep as string
  const tokenABalanceStr = pool.tokenABalance;
  const tokenBBalanceStr = pool.tokenBBalance;
  
  // Convert to BigInt
  let tokenABalance: bigint;
  let tokenBBalance: bigint;
  
  try {
    tokenABalance = BigInt(tokenABalanceStr);
    tokenBBalance = BigInt(tokenBBalanceStr);
  } catch (error) {
    return {
      priceAToB: '0',
      priceBToA: '0',
      tokenADecimals: 6,
      tokenBDecimals: 6,
    };
  }

  // Get decimal information - prefer stored values, then dynamic fetch, then fallback
  let tokenADecimals = 6; // Default fallback
  let tokenBDecimals = 6; // Default fallback
  
  if ('tokenA' in pool) {
    const poolWithTokens = pool as Pool;
    
    // Use stored decimal values if available
    if (poolWithTokens.tokenADecimals !== undefined && poolWithTokens.tokenBDecimals !== undefined) {
      tokenADecimals = poolWithTokens.tokenADecimals;
      tokenBDecimals = poolWithTokens.tokenBDecimals;
    } else {
      // Fallback to token info or dynamic fetch
      tokenADecimals = tokenA?.decimals || 6;
      tokenBDecimals = tokenB?.decimals || 6;
      
      try {
        // Fetch decimal information dynamically from mint addresses if not stored
        [tokenADecimals, tokenBDecimals] = await Promise.all([
          getTokenDecimals(connection, poolWithTokens.tokenA),
          getTokenDecimals(connection, poolWithTokens.tokenB)
        ]);
      } catch (error) {
        // Log the error but continue with fallback values
        console.warn(`Failed to fetch token decimals, using fallback values:`, error);
      }
    }
  } else {
    // For PoolData interface, use provided token info
    tokenADecimals = tokenA?.decimals || 6;
    tokenBDecimals = tokenB?.decimals || 6;
  }

  // Only exclude if balance is 0 (calculate price for all other values)
  if (tokenABalance === 0n || tokenBBalance === 0n) {
    return {
      priceAToB: '0',
      priceBToA: '0',
      tokenADecimals,
      tokenBDecimals,
    };
  }

  try {
    // Simple and clear decimal adjustment
    // Convert raw balances to actual decimal values
    const tokenADecimalBalance = tokenABalance * (10n ** BigInt(18 - tokenADecimals));
    const tokenBDecimalBalance = tokenBBalance * (10n ** BigInt(18 - tokenBDecimals));
    
    // Now both are normalized to 18 decimal places
    const SCALE = 10n ** 18n;
    
    // Price A to B: How many B tokens for 1 A token
    const priceAToBBigInt = (tokenBDecimalBalance * SCALE) / tokenADecimalBalance;
    
    // Price B to A: How many A tokens for 1 B token  
    const priceBToABigInt = (tokenADecimalBalance * SCALE) / tokenBDecimalBalance;
    
    // Convert BigInt to decimal string
    const priceAToB = formatBigIntToDecimal(priceAToBBigInt, 18, 12);
    const priceBToA = formatBigIntToDecimal(priceBToABigInt, 18, 12);
    
    return {
      priceAToB,
      priceBToA,
      tokenADecimals,
      tokenBDecimals,
    };
  } catch (error) {
    // Return 0 on calculation error
    return {
      priceAToB: '0',
      priceBToA: '0',
      tokenADecimals,
      tokenBDecimals,
    };
  }
}

/**
 * Calculate prices for multiple pools in batch
 */
export async function calculateMultiplePoolPrices(
  pools: (Pool | PoolData)[],
  connection: Connection,
  tokens: Map<string, Token>
): Promise<Map<string, PriceCalculationResult>> {
  const results = new Map<string, PriceCalculationResult>();

  for (const pool of pools) {
    const tokenA = tokens.get((pool as Pool).tokenA || '');
    const tokenB = tokens.get((pool as Pool).tokenB || '');

    const priceResult = await calculatePoolPrices(pool, connection, tokenA, tokenB);
    results.set((pool as Pool).address || '', priceResult);
  }

  return results;
}

/**
 * Helper function to convert BigInt to decimal string
 */
function formatBigIntToDecimal(value: bigint, decimals: number, precision: number = 12): string {
  if (value === 0n) return '0';
  
  const divisor = 10n ** BigInt(decimals);
  const integerPart = value / divisor;
  const fractionalPart = value % divisor;
  
  if (fractionalPart === 0n) {
    return integerPart.toString();
  }
  
  // Convert fractional part to string and pad with necessary zeros
  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
  
  // Remove trailing zeros but limit to precision
  const trimmedFractional = fractionalStr.substring(0, precision).replace(/0+$/, '');
  
  if (trimmedFractional === '') {
    return integerPart.toString();
  }
  
  return `${integerPart}.${trimmedFractional}`;
}

/**
 * Convert price to USD (for reference)
 */
export function convertToUSD(
  price: string,
  baseTokenPriceUSD: number = 0,
  quoteTokenPriceUSD: number = 0
): number {
  const priceValue = parseFloat(price);

  if (baseTokenPriceUSD > 0 && quoteTokenPriceUSD > 0) {
    return (priceValue * baseTokenPriceUSD) / quoteTokenPriceUSD;
  }

  return 0;
}
