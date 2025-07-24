import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'tokens' })
export class Token {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  address!: string;

  @Column({ type: 'varchar', length: 32 })
  symbol!: string;

  @Column({ type: 'varchar', length: 64 })
  name!: string;

  @Column({ type: 'int', default: 9 })
  decimals!: number;

  @Column({ type: 'varchar', length: 256, nullable: true })
  logoURI?: string;

  @Column({ type: 'varchar', length: 16, default: 'API' })
  source!: string;

  @Column({ type: 'timestamp', nullable: true })
  lastUpdated?: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastIndexed?: Date;
}
