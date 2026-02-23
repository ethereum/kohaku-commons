import { Address, bytesToHex, hexToBytes, keccak256, toBytes, parseCompactSignature } from 'viem'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { TypedMessage } from '../../interfaces/userRequest'

export function getEip712Payload(appIdentifier: string, addressHash: string): TypedMessage {
  return {
    kind: 'typedMessage',
    domain: {
      name: 'Standardized Secret Derivation',
      version: '1',
      verifyingContract: '0x0000000000000000000000000000000000000000',
      salt: keccak256(toBytes(appIdentifier))
    },
    message: {
      purpose:
        'This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas.',
      addressHash
    },
    primaryType: 'SecretDerivation',
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'verifyingContract', type: 'address' },
        { name: 'salt', type: 'bytes32' }
      ],
      SecretDerivation: [
        { name: 'purpose', type: 'string' },
        { name: 'addressHash', type: 'bytes32' }
      ]
    }
  } as TypedMessage
}

export function getAppSecret(
  signature: string,
  signerAddress: Address,
  appIdentifier: string,
  appInfo: string
): string {
  const compactSignature = parseCompactSignature(signature as `0x${string}`)

  const rValue = compactSignature.r
  compactSignature.yParityAndS = '0x' // Destroy s component

  // Step 4: Derive root secret
  const rBytes = hexToBytes(rValue)
  const saltBytes = hexToBytes(signerAddress)
  const rootInfoBytes = new TextEncoder().encode('Standardized-Secret-Derivation-v1-Root')

  const rootSecret = hkdf(sha256, rBytes, saltBytes, rootInfoBytes, 32)

  // Step 5: Derive application secret
  const appSaltBytes = new TextEncoder().encode(appIdentifier)
  const appInfoBytes = new TextEncoder().encode(appInfo)

  const appSecretBytes = hkdf(sha256, rootSecret, appSaltBytes, appInfoBytes, 32)
  const appSecret = bytesToHex(appSecretBytes)
  // Securely wipe root secret
  rootSecret.fill(0)

  return appSecret
}
