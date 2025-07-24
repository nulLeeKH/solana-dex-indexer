import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum QueueStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum PoolType {
  METEORA_DAMMV2 = 'METEORA-DAMMv2',
  // 향후 확장 가능
  // ORCA_WHIRLPOOL = 'ORCA-WHIRLPOOL',
  // RAYDIUM_CLMM = 'RAYDIUM-CLMM',
  // UNISWAP_V3 = 'UNISWAP-V3',
}

@Entity({ name: 'pool_queue' })
@Index(['status', 'createdAt'])
@Index(['status', 'priority', 'createdAt'])
@Index(['type', 'status'])
export class PoolQueue {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  address!: string;

  @Column({ 
    type: 'enum', 
    enum: QueueStatus, 
    default: QueueStatus.PENDING 
  })
  status!: QueueStatus;

  @Column({ 
    type: 'enum', 
    enum: PoolType, 
    default: PoolType.METEORA_DAMMV2 
  })
  type!: PoolType;

  @Column({ type: 'int', default: 1 })
  priority!: number; // 1=높음, 2=보통, 3=낮음

  @Column({ type: 'varchar', length: 32, nullable: true })
  processedBy?: string; // worker ID

  @Column({ type: 'timestamp', nullable: true })
  processedAt?: Date;

  @Column({ type: 'int', default: 0 })
  retryCount!: number;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @CreateDateColumn()
  createdAt!: Date;
}