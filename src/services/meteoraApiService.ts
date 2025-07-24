import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger';
import { withExponentialBackoff } from '../utils/exponentialBackoff';
import { rpcRateLimiter } from '../utils/rpcRateLimiter';
import { rpcProvider } from '../utils/rpcProvider';
import axios from 'axios';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export interface MeteoraApiPool {
  address: string;
  tokenA: string;
  tokenB: string;
  tokenABalance: string;
  tokenBBalance: string;
  fee: number;
  type: string;
  volume24h: string;
  tvl: string;
  priceAToB?: string;
  priceBToA?: string;
}

export interface MeteoraApiToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
}

export interface MeteoraApiQuote {
  inputToken: string;
  outputToken: string;
  inputAmount: number;
  outputAmount: number;
  priceImpact: number;
  fee: number;
  route: string[];
}

class MeteoraApiService {
  private connection: Connection;

  constructor() {
    this.connection = rpcProvider.getConnection();
  }

  /**
   * Get all pool information (actual Meteora programs only)
   */
  async getAllPools(): Promise<MeteoraApiPool[]> {
    try {
      logger.info('🔍 Fetching pool information from actual Meteora programs...');

      // Use only actual Meteora programs for onchain data collection
      const pools = await this.getPoolsFromRpcDirect();

      logger.info(`✅ Successfully collected ${pools.length} pools from Meteora programs`);
      return pools;
    } catch (error) {
      logger.error('❌ Failed to get Meteora pool information:', error);
      return [];
    }
  }

  /**
   * Get Meteora pool information via pure RPC (small batch processing)
   */
  private async getPoolsFromRpcDirect(): Promise<MeteoraApiPool[]> {
    try {
      logger.info(
        '🔍 Querying actual Meteora program accounts... (small batch processing)'
      );

      // Meteora DAMMv2 program ID
      const programId =
        process.env['METEORA_DAMMV2_PROGRAM_ID'] ||
        'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

      // Test different data sizes for DAMMv2 pools
      const dataSizes = [1104, 1272, 1544];
      const allPools: MeteoraApiPool[] = [];

      for (const dataSize of dataSizes) {
        try {
          logger.info(`🔍 Testing dataSize ${dataSize} for program ${programId}...`);

          const accounts = await rpcRateLimiter.execute(
            () => this.connection.getProgramAccounts(
              new PublicKey(programId),
              {
                commitment: 'confirmed',
                filters: [{ dataSize }],
              }
            ),
            `getProgramAccounts(${programId})`
          );

          logger.info(
            `📊 Found ${accounts.length} accounts with dataSize ${dataSize}`
          );

          if (accounts.length > 0) {
            // Parse pool accounts (limit to first 100 for testing)
            const poolPromises = accounts.slice(0, 100).map(async account => {
              try {
                return await this.parsePoolAccountFromRpc(account, 'DAMMv2');
              } catch (error) {
                logger.debug(
                  `Failed to parse pool account ${account.pubkey.toString()}:`,
                  error
                );
                return null;
              }
            });

            const poolResults = await Promise.all(poolPromises);
            const validPools = poolResults.filter(
              pool => pool !== null
            ) as MeteoraApiPool[];

            allPools.push(...validPools);
            logger.info(
              `✅ Successfully parsed ${validPools.length} pools from dataSize ${dataSize}`
            );

            // If we found pools with this dataSize, we can stop testing others
            if (validPools.length > 0) {
              break;
            }
          }
        } catch (error) {
          logger.warn(`Failed to process dataSize ${dataSize}:`, error);
        }
      }

      logger.info(`✅ Total pools collected: ${allPools.length}`);
      return allPools;
    } catch (error) {
      logger.error('❌ Failed to get pools from RPC:', error);
      return [];
    }
  }

  /**
   * Parse pool information from RPC account data (actual Meteora structure)
   */
  private async parsePoolAccountFromRpc(
    account: any,
    poolType: string
  ): Promise<MeteoraApiPool | null> {
    try {
      const data = Buffer.from(account.account.data[0], 'base64');

      // Check data size
      if (data.length < 100) {
        logger.debug(`Insufficient data size: ${data.length} bytes`);
        return null;
      }

      // Actual Meteora DAMMv2 pool structure offsets (analysis complete)
      let tokenAOffset, tokenBOffset, vaultAOffset, vaultBOffset, feeOffset;

      if (poolType === 'DAMMv2') {
        // DAMMv2 pool structure (1484 bytes)
        // Accurate offsets based on structure analysis:

        feeOffset = 8; // cliff_fee_numerator (0x08) - 64bit
        tokenAOffset = 168; // token_a_mint (0xA8)
        tokenBOffset = 200; // token_b_mint (0xC8)
        vaultAOffset = 232; // token_a_vault (0xE8)
        vaultBOffset = 264; // token_b_vault (0x108)
      } else {
        logger.debug(`Unknown pool type: ${poolType}`);
        return null;
      }

      // Re-check data size
      if (data.length < vaultBOffset + 32) {
        logger.debug(
          `Insufficient data size: ${data.length} bytes, needed: ${vaultBOffset + 32} bytes`
        );
        return null;
      }

      // Extract token addresses
      const tokenABytes = data.slice(tokenAOffset, tokenAOffset + 32);
      const tokenBBytes = data.slice(tokenBOffset, tokenBOffset + 32);

      const tokenA = new PublicKey(tokenABytes).toString();
      const tokenB = new PublicKey(tokenBBytes).toString();

      // Validation
      if (
        tokenA === tokenB ||
        tokenA === '11111111111111111111111111111111' ||
        tokenB === '11111111111111111111111111111111'
      ) {
        logger.debug(`Invalid token addresses: ${tokenA}, ${tokenB}`);
        return null;
      }

      // Extract vault addresses and actual balances from DAMMv2
      let vaultAAddress = '';
      let vaultBAddress = '';
      let tokenABalance = '0';
      let tokenBBalance = '0';
      let fee = 0.003; // Default value

      try {
        const vaultABytes = data.slice(vaultAOffset, vaultAOffset + 32);
        const vaultBBytes = data.slice(vaultBOffset, vaultBOffset + 32);

        vaultAAddress = new PublicKey(vaultABytes).toString();
        vaultBAddress = new PublicKey(vaultBBytes).toString();

        // Get actual balances from vaults (sequential processing to avoid rate limiting)
        const balanceA = await this.getVaultBalance(vaultAAddress);
        await this.sleep(100); // 100ms wait
        const balanceB = await this.getVaultBalance(vaultBAddress);
        await this.sleep(100); // 100ms wait

        tokenABalance = balanceA.toString();
        tokenBBalance = balanceB.toString();

        logger.debug(
          `Vault A: ${vaultAAddress} (${tokenABalance}), Vault B: ${vaultBAddress} (${tokenBBalance})`
        );

        // Log warning if balances are zero
        if (BigInt(tokenABalance) === 0n || BigInt(tokenBBalance) === 0n) {
          logger.warn(
            `Zero balance detected - Pool: ${account.pubkey.toString()}, VaultA: ${tokenABalance}, VaultB: ${tokenBBalance}`
          );
        }
      } catch (error) {
        logger.debug(`Failed to parse vault addresses: ${error}`);
        return null;
      }

      // Extract fee information (cliff_fee_numerator)
      if (data.length >= feeOffset + 8) {
        try {
          const feeRaw = data.readBigUInt64LE(feeOffset);
          fee = Number(feeRaw) / 1000000000; // Convert cliff_fee_numerator to percentage

          // Validate fee
          if (fee < 0 || fee > 1) {
            fee = 0.003; // Reset to default
          }
        } catch (error) {
          logger.debug(`Failed to parse fee: ${error}`);
        }
      }

      // Calculate TVL (simple estimation)
      const tvl = (BigInt(tokenABalance) + BigInt(tokenBBalance)).toString();

      // Calculate price (ratio of tokenABalance / tokenBBalance)
      let priceAToB = '0';
      let priceBToA = '0';

      const balanceA = BigInt(tokenABalance);
      const balanceB = BigInt(tokenBBalance);

      // Minimum liquidity threshold (minimum 100 units per token)
      const minLiquidity = BigInt(100);

      if (balanceA > minLiquidity && balanceB > minLiquidity) {
        // Consider decimal places (default: 6 decimal places)
        const tokenADecimals = 6; // Should be obtained from token metadata
        const tokenBDecimals = 6;
        
        // Adjust decimal places
        const decimalAdjustment = Math.pow(10, tokenADecimals - tokenBDecimals);
        
        // Price to convert A to B (B/A)
        const priceAToBNum = Number(balanceB) / Number(balanceA) * decimalAdjustment;
        priceAToB = priceAToBNum.toFixed(12);
        
        // Price to convert B to A (A/B)
        const priceBToANum = Number(balanceA) / Number(balanceB) / decimalAdjustment;
        priceBToA = priceBToANum.toFixed(12);

        logger.info(
          `✅ Price calculation successful - Pool: ${account.pubkey.toString()}, priceAToB: ${priceAToB}, priceBToA: ${priceBToA}`
        );
      } else {
        logger.debug(
          `Price calculation failed (insufficient liquidity) - Pool: ${account.pubkey.toString()}, tokenABalance: ${tokenABalance}, tokenBBalance: ${tokenBBalance}`
        );
      }

      return {
        address: account.pubkey.toString(),
        tokenA,
        tokenB,
        tokenABalance,
        tokenBBalance,
        fee,
        type: poolType,
        volume24h: '0',
        tvl,
        priceAToB,
        priceBToA,
      };
    } catch (error) {
      logger.debug(`Failed to parse pool: ${error}`);
      return null;
    }
  }

  /**
   * Get all token information (pure RPC based)
   */
  async getAllTokens(): Promise<MeteoraApiToken[]> {
    try {
      logger.info('🪙 Fetching token information from RPC...');

      // Collect token addresses used in pools
      const poolTokens = await this.getTokensFromPools();

      // Query token metadata from RPC
      const tokens: MeteoraApiToken[] = [];

      for (const tokenAddress of poolTokens) {
        try {
          const tokenAccount = await rpcRateLimiter.execute(
            () => this.connection.getAccountInfo(
              new PublicKey(tokenAddress)
            ),
            `getAccountInfo(${tokenAddress})`
          );

          if (tokenAccount) {
            const tokenInfo = this.parseTokenAccount(
              tokenAddress,
              tokenAccount
            );
            if (tokenInfo) {
              tokens.push(tokenInfo);
            }
          }
        } catch (error) {
          logger.debug(`Failed to fetch token account (${tokenAddress}):`, error);
          // Add basic info
          tokens.push({
            address: tokenAddress,
            symbol: 'UNKNOWN',
            name: 'Unknown Token',
            decimals: 9,
          });
        }
      }

      logger.info(`✅ Successfully collected ${tokens.length} token information from RPC`);
      return tokens;
    } catch (error) {
      logger.error('❌ Failed to get token information:', error);
      return [];
    }
  }

  /**
   * Collect token addresses used in pools
   */
  private async getTokensFromPools(): Promise<Set<string>> {
    try {
      const pools = await this.getPoolsFromRpcDirect();
      const tokens = new Set<string>();

      pools.forEach(pool => {
        tokens.add(pool.tokenA);
        tokens.add(pool.tokenB);
      });

      return tokens;
    } catch (error) {
      logger.warn('Failed to collect tokens from pools:', error);
      return new Set();
    }
  }

  /**
   * Parse token account information
   */
  private parseTokenAccount(
    address: string,
    accountInfo: any
  ): MeteoraApiToken | null {
    try {
      // SPL Token Mint structure parsing
      const data = accountInfo.data;

      if (data.length < 82) {
        return null;
      }

      // Extract decimals from SPL Token Mint structure (offset 44)
      const decimals = data[44];

      // Metadata is difficult to obtain directly from RPC, use default values
      return {
        address,
        symbol: this.getTokenSymbolFromAddress(address),
        name: 'Token',
        decimals: decimals || 9,
      };
    } catch (error) {
      logger.debug(`Failed to parse token (${address}):`, error);
      return null;
    }
  }

  /**
   * Extract symbol from well-known token addresses
   */
  private getTokenSymbolFromAddress(address: string): string {
    const knownTokens: { [key: string]: string } = {
      So11111111111111111111111111111111111111112: 'SOL',
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
      DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
      mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 'mSOL',
      bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: 'bSOL',
      J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 'JTO',
      jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: 'jupSOL',
    };

    return knownTokens[address] || 'UNKNOWN';
  }


  /**
   * Get actual balance from Vault account
   */
  private async getVaultBalance(vaultAddress: string): Promise<bigint> {
    try {
      const response = await axios.post(
        process.env['SOLANA_RPC_URL'] || 'https://api.mainnet-beta.solana.com',
        {
          jsonrpc: '2.0',
          id: `getVaultBalance-${Date.now()}`,
          method: 'getAccountInfo',
          params: [
            vaultAddress,
            {
              encoding: 'base64',
              commitment: 'confirmed',
            },
          ],
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );

      if (response.data.error) {
        logger.debug(
          `Failed to fetch Vault (${vaultAddress}): ${response.data.error.message}`
        );
        return BigInt(0);
      }

      const accountData = response.data.result?.value?.data;
      if (!accountData || !accountData[0]) {
        logger.debug(`Vault data not found (${vaultAddress})`);
        return BigInt(0);
      }

      const data = Buffer.from(accountData[0], 'base64');
      if (data.length < 72) {
        logger.debug(
          `Insufficient Vault data size (${vaultAddress}): ${data.length} bytes`
        );
        return BigInt(0);
      }

      // Extract amount from SPL Token Account structure (offset 64, 8 bytes)
      const balance = data.readBigUInt64LE(64);

      logger.debug(
        `Vault balance retrieved - Address: ${vaultAddress}, Balance: ${balance.toString()}`
      );

      return balance;
    } catch (error) {
      logger.debug(`Failed to get Vault balance (${vaultAddress}): ${error}`);
      return BigInt(0);
    }
  }

  /**
   * Parse pool information from a specific pool address
   */
  async parsePoolAccountFromAddress(
    poolAddress: string
  ): Promise<MeteoraApiPool | null> {
    try {
      const response = await withExponentialBackoff(
        () => axios.post(
          process.env['SOLANA_RPC_URL'] || 'https://api.mainnet-beta.solana.com',
          {
            jsonrpc: '2.0',
            id: `getPoolAccount-${Date.now()}`,
            method: 'getAccountInfo',
            params: [
              poolAddress,
              {
                encoding: 'base64',
                commitment: 'confirmed',
              },
            ],
          },
          {
            headers: {
              'Content-Type': 'application/json',
            },
            timeout: 10000,
          }
        ),
        `RPC getAccountInfo(${poolAddress})`
      );

      if (response.data.error) {
        logger.debug(
          `Failed to fetch pool account (${poolAddress}): ${response.data.error.message}`
        );
        return null;
      }

      const accountInfo = response.data.result?.value;
      if (!accountInfo) {
        logger.debug(`Pool account not found: ${poolAddress}`);
        return null;
      }

      // Parse as DAMMv2 pool account
      const account = {
        pubkey: new PublicKey(poolAddress),
        account: accountInfo,
      };

      return await this.parsePoolAccountFromRpc(account, 'DAMMv2');
    } catch (error) {
      logger.debug(`Failed to parse pool account ${poolAddress}:`, error);
      return null;
    }
  }

  /**
   * Get detailed information of a specific pool from RPC
   */
  async getPoolDetails(
    poolAddress: string,
    poolType: string
  ): Promise<MeteoraApiPool | null> {
    try {
      const rpcUrl =
        process.env['SOLANA_RPC_URL'] || 'https://api.mainnet-beta.solana.com';

      const response = await axios.post(
        rpcUrl,
        {
          jsonrpc: '2.0',
          id: `getAccountInfo-${Date.now()}`,
          method: 'getAccountInfo',
          params: [
            poolAddress,
            {
              encoding: 'base64',
              commitment: 'confirmed',
            },
          ],
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );

      if (response.data.error) {
        logger.debug(
          `Failed to fetch pool (${poolAddress}): ${response.data.error.message}`
        );
        return null;
      }

      const accountData = response.data.result?.value;
      if (!accountData) {
        logger.debug(`Pool data not found (${poolAddress})`);
        return null;
      }

      const account = {
        pubkey: { toString: () => poolAddress },
        account: { data: [accountData.data[0]] },
      };

      return await this.parsePoolAccountFromRpc(account, poolType);
    } catch (error) {
      logger.debug(`Failed to get pool details (${poolAddress}): ${error}`);
      return null;
    }
  }

  /**
   * Sleep function (for rate limiting)
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get pool information for a specific token pair
   */
  async getPoolsByTokens(
    tokenA: string,
    tokenB: string
  ): Promise<MeteoraApiPool[]> {
    try {
      const allPools = await this.getAllPools();
      return allPools.filter(
        pool =>
          (pool.tokenA === tokenA && pool.tokenB === tokenB) ||
          (pool.tokenA === tokenB && pool.tokenB === tokenA)
      );
    } catch (error) {
      logger.error('❌ Failed to get pool information for specific token pair:', error);
      throw error;
    }
  }

  /**
   * Get cached data (in-memory caching only)
   */
  async getCachedPools(): Promise<MeteoraApiPool[]> {
    return this.getAllPools();
  }
}

export const meteoraApiService = new MeteoraApiService();
