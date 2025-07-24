/**
 * Custom error classes for Meteora fee extraction
 */

export class MeteoreFeeExtractionError extends Error {
  constructor(
    message: string,
    public poolAddress: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'MeteoreFeeExtractionError';
  }
}

export class PoolDataValidationError extends MeteoreFeeExtractionError {
  constructor(poolAddress: string, dataSize: number, expectedSize: number) {
    super(
      `Invalid pool data size: ${dataSize} bytes (expected ${expectedSize})`,
      poolAddress
    );
    this.name = 'PoolDataValidationError';
  }
}

export class SdkConnectionError extends MeteoreFeeExtractionError {
  constructor(poolAddress: string, cause: Error) {
    super(
      `Failed to connect to Meteora SDK for pool ${poolAddress}`,
      poolAddress,
      cause
    );
    this.name = 'SdkConnectionError';
  }
}

export class FeeCalculationError extends MeteoreFeeExtractionError {
  constructor(poolAddress: string, feeType: string, cause?: Error) {
    super(
      `Failed to calculate ${feeType} fee for pool ${poolAddress}`,
      poolAddress,
      cause
    );
    this.name = 'FeeCalculationError';
  }
}