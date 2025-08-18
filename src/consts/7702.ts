import { Hex } from '../interfaces/hex'
import { EIP_7702_AMBIRE_ACCOUNT } from './deploy'

export interface Custom7702Settings {
  [chainId: string]: {
    implementation: Hex
  }
}

export const networks7702: Custom7702Settings = {
  // odyssey
  '911867': {
    implementation: EIP_7702_AMBIRE_ACCOUNT
  },
  // sepolia
  '11155111': {
    implementation: EIP_7702_AMBIRE_ACCOUNT
  },
  // gnosis
  '100': {
    implementation: EIP_7702_AMBIRE_ACCOUNT
  },
  // katana, they don't have the singleton
  '747474': {
    implementation: '0x8226995E02C70293595E0634C5F89547EDb08126'
  }
}

export interface EIP7702Auth {
  address: Hex
  chainId: Hex
  nonce: Hex
  r: Hex
  s: Hex
  v: Hex
  yParity: Hex
}
