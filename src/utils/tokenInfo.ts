import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger';
import { rpcRateLimiter } from './rpcRateLimiter';

interface TokenMintInfo {
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

// Token decimals cache to avoid repeated RPC calls
const tokenDecimalsCache = new Map<string, number>();

/**
 * Get token decimals from mint account
 */
export async function getTokenDecimals(
  connection: Connection, 
  mintAddress: string
): Promise<number> {
  // Check cache first
  if (tokenDecimalsCache.has(mintAddress)) {
    return tokenDecimalsCache.get(mintAddress)!;
  }

  try {
    const mintInfo = await rpcRateLimiter.execute(
      () => connection.getAccountInfo(new PublicKey(mintAddress)),
      `getTokenMint(${mintAddress})`
    );

    if (!mintInfo || mintInfo.data.length < 45) {
      throw new Error(`Invalid mint account: ${mintAddress}`);
    }

    // SPL Token Mint structure: decimals at offset 44
    const decimals = mintInfo.data[44];
    if (decimals === undefined) {
      throw new Error(`Failed to read decimals from mint account: ${mintAddress}`);
    }
    
    // Cache the result
    tokenDecimalsCache.set(mintAddress, decimals);
    
    logger.debug(`Token ${mintAddress} has ${decimals} decimals`);
    return decimals;
  } catch (error) {
    logger.error(`Failed to get decimals for ${mintAddress}:`, error);
    throw error;
  }
}

/**
 * Get token decimals for multiple mints in batch
 */
export async function getMultipleTokenDecimals(
  connection: Connection,
  mintAddresses: string[]
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  
  // Filter out cached addresses
  const uncachedAddresses = mintAddresses.filter(addr => !tokenDecimalsCache.has(addr));
  
  // Return cached results for known addresses
  mintAddresses.forEach(addr => {
    if (tokenDecimalsCache.has(addr)) {
      results.set(addr, tokenDecimalsCache.get(addr)!);
    }
  });

  if (uncachedAddresses.length === 0) {
    return results;
  }

  logger.debug(`Fetching decimals for ${uncachedAddresses.length} uncached tokens`);

  // Fetch uncached tokens
  for (const mintAddress of uncachedAddresses) {
    try {
      const decimals = await getTokenDecimals(connection, mintAddress);
      results.set(mintAddress, decimals);
      
      // Small delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error) {
      logger.error(`Failed to get decimals for ${mintAddress}:`, error);
      throw error; // Propagate error instead of using fallback
    }
  }

  return results;
}

/**
 * Parse full token mint information
 */
export async function getTokenMintInfo(
  connection: Connection,
  mintAddress: string
): Promise<TokenMintInfo | null> {
  try {
    const mintInfo = await rpcRateLimiter.execute(
      () => connection.getAccountInfo(new PublicKey(mintAddress)),
      `getTokenMintInfo(${mintAddress})`
    );

    if (!mintInfo || mintInfo.data.length < 82) {
      return null;
    }

    const data = mintInfo.data;
    
    // SPL Token Mint structure
    // 0-4: mint_authority (option + pubkey)
    // 36-44: supply (u64)  
    // 44: decimals (u8)
    // 45: is_initialized (bool)
    // 46-50: freeze_authority (option + pubkey)
    
    const decimals = data[44];
    if (decimals === undefined) {
      throw new Error(`Failed to read decimals from mint account: ${mintAddress}`);
    }
    const supply = data.readBigUInt64LE(36);
    
    // Parse authorities (simplified)
    const mintAuthority = data[0] === 1 ? new PublicKey(data.slice(1, 33)).toString() : null;
    const freezeAuthority = data[46] === 1 ? new PublicKey(data.slice(47, 79)).toString() : null;

    return {
      decimals,
      supply,
      mintAuthority,
      freezeAuthority,
    };
  } catch (error) {
    logger.debug(`Failed to get mint info for ${mintAddress}:`, error);
    return null;
  }
}

/**
 * Clear token decimals cache (useful for testing)
 */
export function clearTokenDecimalsCache(): void {
  tokenDecimalsCache.clear();
  logger.debug('Token decimals cache cleared');
}

/**
 * Get cache statistics
 */
export function getTokenDecimalsCacheStats(): {
  size: number;
  entries: Array<{ address: string; decimals: number }>;
} {
  return {
    size: tokenDecimalsCache.size,
    entries: Array.from(tokenDecimalsCache.entries()).map(([address, decimals]) => ({
      address,
      decimals,
    })),
  };
}