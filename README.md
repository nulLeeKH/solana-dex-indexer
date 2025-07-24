# 🔍 Solana DEX Indexer

A high-performance, multi-protocol DEX indexing system for Solana with queue-based processing and horizontal scaling capabilities.

## Overview

Solana DEX Indexer is designed to monitor and index multiple DEX protocols on Solana, starting with Meteora DAMMv2. The architecture supports easy addition of new protocols while maintaining consistent data structures and processing patterns.

## Architecture

The system uses a 4-script architecture designed for reliability and scalability:

1. **Sync** - Protocol-specific pool discovery
2. **Consumer** - Queue processing and data persistence  
3. **Monitor** - Real-time transaction monitoring
4. **Checker** - Background verification and updates

### Key Features

- **Multi-Protocol Support**: Extensible architecture for multiple DEX protocols
- **Queue-Based Processing**: PostgreSQL-backed queue for reliability
- **Horizontal Scaling**: Run multiple instances for increased throughput
- **Real-Time Updates**: WebSocket monitoring for instant updates
- **Priority System**: Intelligent processing order (Monitor > Sync > Checker)

## Supported Protocols

### ✅ Implemented
- **Meteora DAMMv2**: Full support for Dynamic AMM v2 pools

### 🚧 Planned
- Orca Whirlpools
- Raydium CLMM
- Phoenix
- OpenBook v2

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 12+
- Solana RPC access (Helius recommended)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/solana-dex-indexer
cd solana-dex-indexer

# Install dependencies
npm install

# Configure environment
cp env.example .env
# Edit .env with your settings
```

### Database Setup

```bash
# Create database
createdb solana_dex_indexer

# Run migrations
npm run migration:run
```

### Running the Indexer

```bash
# Initial pool discovery
npm run sync

# Start processing (scale as needed)
npm run consumer

# Real-time monitoring
npm run monitor

# Background verification
npm run checker
```

## Configuration

### RPC Providers
```env
RPC_PROVIDER=helius
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

### Database
```env
DB_TYPE=postgres
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=dex_indexer
DB_PASSWORD=your_password
DB_DATABASE=solana_dex_indexer
```

### Protocol Configuration
```env
# Meteora
METEORA_PROGRAM_ID=cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG

# Future protocols
# ORCA_WHIRLPOOL_PROGRAM_ID=...
# RAYDIUM_CLMM_PROGRAM_ID=...
```

## Database Schema

### Core Tables

#### pool_queue
Central processing queue for all protocols:
- `address`: Pool address (primary key)
- `type`: Protocol type (METEORA-DAMMv2, etc.)
- `status`: PENDING, PROCESSING, COMPLETED, FAILED
- `priority`: 1 (Monitor), 2 (Sync), 3 (Checker)

#### pools
Unified pool data across all protocols:
- `address`: Pool address
- `type`: Protocol identifier
- `tokenA/tokenB`: Token mint addresses
- `tokenABalance/tokenBBalance`: Current balances
- `fee`: Trading fee
- `priceAToB/priceBToA`: Calculated prices

#### tokens
Token metadata:
- `address`: Token mint address
- `symbol`: Token symbol
- `name`: Token name
- `decimals`: Token decimals

## Scripts

### sync.ts
Discovers pools for configured protocols:
```bash
npm run sync
```
- Scans each protocol's program accounts
- Adds discovered pools to queue
- Supports incremental discovery

### consumer.ts
Processes queued pools:
```bash
# Run multiple instances for scaling
npm run consumer
```
- Fetches current pool state from chain
- Updates database with latest data
- Handles retries and failures

### monitor.ts
Real-time transaction monitoring:
```bash
npm run monitor
```
- WebSocket connection for live updates
- Captures pool state changes instantly
- Adds high-priority updates to queue

### checker.ts
Background verification:
```bash
npm run checker
```
- Randomly samples pools for freshness
- Re-queues stale data for updates
- Ensures data accuracy over time

## Adding New Protocols

1. **Define Protocol Type**
```typescript
// src/models/PoolQueue.ts
export enum PoolType {
  METEORA_DAMMV2 = 'METEORA-DAMMv2',
  ORCA_WHIRLPOOL = 'ORCA-WHIRLPOOL',  // New protocol
}
```

2. **Implement Pool Discovery**
```typescript
// In sync.ts
async discoverOrcaPools() {
  const accounts = await connection.getProgramAccounts(
    ORCA_PROGRAM_ID,
    { filters: [...] }
  );
  // Add to queue with type: PoolType.ORCA_WHIRLPOOL
}
```

3. **Add Pool Parser**
```typescript
// In consumer.ts
async parseOrcaPool(account: any) {
  // Protocol-specific parsing logic
  // Return normalized pool data
}
```

## Performance

- **Discovery**: ~50K pools in 5-10 minutes
- **Processing**: 1-3 pools/second per consumer
- **Memory**: ~50-100MB per script
- **Database**: ~1-2GB for 50K pools with history

## Monitoring

### Queue Health
```sql
SELECT type, status, COUNT(*) 
FROM pool_queue 
GROUP BY type, status;
```

### Processing Rate
```sql
SELECT 
  DATE_TRUNC('hour', updated_at) as hour,
  COUNT(*) as pools_updated
FROM pools
WHERE updated_at > NOW() - INTERVAL '24 hours'
GROUP BY hour
ORDER BY hour;
```

### Protocol Coverage
```sql
SELECT type, COUNT(*) as pool_count
FROM pools
GROUP BY type;
```

## API Usage

The indexed data can be queried directly from PostgreSQL for:
- DEX aggregation/routing
- Analytics and reporting
- Trading bots and strategies
- Research and analysis

Example queries are provided in `docs/queries.sql`.

## Development

### Project Structure
```
solana-dex-indexer/
├── scripts/         # Main indexing scripts
│   ├── sync.ts     # Pool discovery
│   ├── consumer.ts # Queue processing
│   ├── monitor.ts  # Live monitoring
│   └── checker.ts  # Verification
├── src/
│   ├── models/     # Database models
│   ├── services/   # Protocol services
│   └── utils/      # Shared utilities
```

### Testing
```bash
npm run build       # Compile TypeScript
npm run type-check  # Type checking
npm run lint        # Code linting
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new protocols
4. Submit a pull request

### Adding Protocol Support
- Follow existing patterns in `sync.ts` and `consumer.ts`
- Normalize data to fit the unified schema
- Document protocol-specific logic
- Add integration tests

## License

MIT License - see LICENSE file for details

## Acknowledgments

Built for the Solana ecosystem to provide reliable, real-time DEX data for developers, traders, and researchers.