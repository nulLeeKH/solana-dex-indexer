import { Connection, ConnectionConfig } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import { logger } from './logger';

dotenv.config();

export interface RpcProviderConfig {
  name: string;
  url: string;
  wsUrl?: string | undefined;
  headers?: Record<string, string> | undefined;
  connectionConfig?: ConnectionConfig | undefined;
}

export class RpcProviderManager {
  private static instance: RpcProviderManager;
  private currentProvider: RpcProviderConfig;
  private connection: Connection | null = null;
  
  private providers: Record<string, RpcProviderConfig> = {
    triton: {
      name: 'Triton',
      url: `https://${process.env['TRITON_RPC_ENDPOINT'] || 'api.mainnet-beta.solana.com'}`,
      wsUrl: `wss://${process.env['TRITON_RPC_ENDPOINT'] || 'api.mainnet-beta.solana.com'}`,
      headers: process.env['TRITON_RPC_TOKEN'] ? {
        'Authorization': process.env['TRITON_RPC_TOKEN'],
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      } : undefined,
    },
    helius: {
      name: 'Helius',
      url: process.env['HELIUS_RPC_URL'] || 'https://mainnet.helius-rpc.com/?api-key=demo',
      wsUrl: process.env['HELIUS_RPC_WS'] || 'wss://mainnet.helius-rpc.com/?api-key=demo',
    },
    quicknode: {
      name: 'QuickNode',
      url: process.env['QUICKNODE_RPC_URL'] || 'https://api.mainnet-beta.solana.com',
      wsUrl: process.env['QUICKNODE_RPC_WS'],
    },
    alchemy: {
      name: 'Alchemy',
      url: process.env['ALCHEMY_RPC_URL'] || 'https://api.mainnet-beta.solana.com',
      wsUrl: process.env['ALCHEMY_RPC_WS'],
    },
    solana: {
      name: 'Solana Labs',
      url: 'https://api.mainnet-beta.solana.com',
    },
  };

  private constructor() {
    // Check for standardized SOLANA_RPC_* environment variables first
    if (process.env['SOLANA_RPC_HTTP']) {
      const httpUrl = process.env['SOLANA_RPC_HTTP'];
      const hasTokenInUrl = httpUrl.includes('api-key=') || httpUrl.includes('/') && httpUrl.split('/').length > 3;
      
      // Create provider from standardized env vars
      this.currentProvider = {
        name: 'Custom',
        url: httpUrl,
        wsUrl: process.env['SOLANA_RPC_WSS'] || undefined,
        // Only use header auth if token is not already in URL
        headers: (!hasTokenInUrl && process.env['SOLANA_RPC_TOKEN']) ? {
          'Authorization': process.env['SOLANA_RPC_TOKEN'],
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        } : undefined,
      };
    } else {
      // Fallback to provider-specific configuration
      const providerName = process.env['RPC_PROVIDER'] || 'helius';
      
      // Backward compatibility: check if SOLANA_RPC_URL is set
      if (process.env['SOLANA_RPC_URL'] && !process.env['RPC_PROVIDER']) {
        // Create a custom provider from legacy env vars
        this.currentProvider = {
          name: 'Custom (Legacy)',
          url: process.env['SOLANA_RPC_URL'],
          wsUrl: process.env['SOLANA_RPC_WS'] || undefined,
        };
      } else {
        const selectedProvider = this.providers[providerName];
        this.currentProvider = selectedProvider || this.providers['solana']!;
      }
    }

    logger.info(`🔗 RPC Provider: ${this.currentProvider.name} (${this.currentProvider.url})`);
  }

  public static getInstance(): RpcProviderManager {
    if (!RpcProviderManager.instance) {
      RpcProviderManager.instance = new RpcProviderManager();
    }
    return RpcProviderManager.instance;
  }

  public getConnection(): Connection {
    if (!this.connection) {
      this.connection = this.createConnection();
    }
    return this.connection;
  }

  private createConnection(): Connection {
    const config: ConnectionConfig = {
      commitment: 'confirmed',
      ...(this.currentProvider.headers && { httpHeaders: this.currentProvider.headers }),
      ...this.currentProvider.connectionConfig,
    };

    logger.info(`🚀 Creating RPC connection to ${this.currentProvider.name}`);
    if (this.currentProvider.headers) {
      logger.debug(`📝 Using custom headers for ${this.currentProvider.name}`);
    }

    return new Connection(this.currentProvider.url, config);
  }

  public switchProvider(providerName: string): void {
    // Check if switching to standardized configuration
    if (providerName === 'standardized' && process.env['SOLANA_RPC_HTTP']) {
      const newProvider = {
        name: 'Standardized',
        url: process.env['SOLANA_RPC_HTTP'],
        wsUrl: process.env['SOLANA_RPC_WSS'] || undefined,
        headers: process.env['SOLANA_RPC_TOKEN'] ? {
          'Authorization': process.env['SOLANA_RPC_TOKEN'],
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        } : undefined,
      };
      
      logger.info(`🔄 Switching RPC provider: ${this.currentProvider.name} → ${newProvider.name}`);
      this.currentProvider = newProvider;
      this.connection = null; // Reset connection to force recreation
      return;
    }

    const newProvider = this.providers[providerName];
    if (!newProvider) {
      throw new Error(`Unknown RPC provider: ${providerName}`);
    }

    logger.info(`🔄 Switching RPC provider: ${this.currentProvider.name} → ${newProvider.name}`);
    this.currentProvider = newProvider;
    this.connection = null; // Reset connection to force recreation
  }

  public getCurrentProvider(): RpcProviderConfig {
    return this.currentProvider;
  }

  public getAvailableProviders(): string[] {
    const providers = Object.keys(this.providers);
    
    // Add standardized provider if configured
    if (process.env['SOLANA_RPC_HTTP']) {
      providers.push('standardized');
    }
    
    return providers;
  }

  public addCustomProvider(name: string, config: RpcProviderConfig): void {
    this.providers[name] = config;
    logger.info(`➕ Added custom RPC provider: ${name}`);
  }

  public testConnection(): Promise<boolean> {
    return new Promise(async (resolve) => {
      try {
        const connection = this.getConnection();
        const slot = await connection.getSlot();
        logger.info(`✅ RPC connection test successful - Current slot: ${slot}`);
        resolve(true);
      } catch (error) {
        logger.error(`❌ RPC connection test failed:`, error);
        resolve(false);
      }
    });
  }
}

// Export singleton instance
export const rpcProvider = RpcProviderManager.getInstance();

// Legacy export for backward compatibility
export function createConnection(): Connection {
  return rpcProvider.getConnection();
}