// Remove unused import
import {
  getPythProgramKeyForCluster,
  PythHttpClient,
} from '@pythnetwork/client';
import { rpcProvider } from './rpcProvider';

const PYTH_CLUSTER = 'mainnet-beta';

const connection = rpcProvider.getConnection();
const pythProgramKey = getPythProgramKeyForCluster(PYTH_CLUSTER);
const pythClient = new PythHttpClient(connection, pythProgramKey);

/**
 * Pyth에서 토큰(심볼 또는 주소) 가격을 가져옴
 * @param symbolOrAddress 예: 'SOL/USD' 또는 price account address
 */
export async function getTokenPrice(
  symbolOrAddress: string
): Promise<number | null> {
  const data = await pythClient.getData();
  let priceData;
  if (symbolOrAddress.startsWith('0x') || symbolOrAddress.length > 40) {
    // address로 찾기
    priceData = data.products.find(
      (p: any) => p['priceAccountKey'] === symbolOrAddress
    );
  } else {
    // 심볼로 찾기
    priceData = data.products.find((p: any) => p['symbol'] === symbolOrAddress);
  }
  if (!priceData || !priceData['priceAccountKey']) return null;
  const priceInfo = data.productPrice.get(priceData['priceAccountKey']);
  if (!priceInfo || priceInfo.price === undefined || priceInfo.price === null)
    return null;
  return priceInfo.price;
}
