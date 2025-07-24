import {
  Entity,
  PrimaryColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'pools' })
@Index(['tokenA', 'tokenB'])
export class Pool {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  address!: string;

  @Column({ type: 'varchar', length: 64 })
  tokenA!: string;

  @Column({ type: 'varchar', length: 64 })
  tokenB!: string;

  // Raw balance as integer string (no decimal conversion)
  @Column({ type: 'varchar', length: 32, default: '0' })
  tokenABalance!: string;

  @Column({ type: 'varchar', length: 32, default: '0' })
  tokenBBalance!: string;

  // Decimal information for proper conversion
  @Column({ type: 'int', default: 6 })
  tokenADecimals!: number;

  @Column({ type: 'int', default: 6 })
  tokenBDecimals!: number;

  @Column({ type: 'float', default: 0.01 })
  fee!: number; // Total trading fee including dynamic adjustments

  @Column({ type: 'float', default: 0.002, nullable: true })
  protocolFee?: number; // Protocol fee (0.2% default)

  @Column({ type: 'float', default: 0, nullable: true })
  dynamicFeeAmount?: number; // Dynamic fee adjustment amount

  @Column({ type: 'varchar', length: 32, default: 'METEORA-DAMMv2' })
  type!: string;

  // 가격 관련 필드 추가
  @Column({ type: 'numeric', precision: 32, scale: 12, nullable: true })
  priceAToB?: string;

  @Column({ type: 'numeric', precision: 32, scale: 12, nullable: true })
  priceBToA?: string;

  @Column({ type: 'timestamp', nullable: true })
  lastUpdated?: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastIndexed?: Date;
}
