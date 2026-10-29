import {
  AbiCoder,
  concat,
  getAddress,
  getBytes,
  hashMessage,
  hexlify,
  keccak256,
  recoverAddress,
  toUtf8Bytes,
  TypedDataEncoder,
  Wallet,
  ZeroHash
} from 'ethers'

import { describe, expect, jest, test } from '@jest/globals'
import { SignTypedDataVersion, TypedDataUtils } from '@metamask/eth-sig-util'

import { networks } from '../../consts/networks'
import { Account, AccountOnchainState } from '../../interfaces/account'
import { Hex } from '../../interfaces/hex'
import { Key } from '../../interfaces/keystore'
import { TypedMessage } from '../../interfaces/userRequest'
import { callToTuple } from '../accountOp/accountOp'
import { KeystoreSigner } from '../keystoreSigner/keystoreSigner'
import { getActivatorCall } from '../userOperation/userOperation'
import {
  adaptTypedMessageForMetaMaskSigUtil,
  getAmbireReadableTypedData,
  getEIP712Signature,
  getEntryPointAuthorization,
  getEntryPointAuthorizationSignature,
  getPlainTextSignature,
  getTypedData
} from './signMessage'

// The account's side, written from the account contract and its signature
// validator: the last byte of a signature selects the mode and is not signed;
// mode 0 recovers over the hash as given, mode 1 over the account's envelope
// of the hash; a 65 byte signature with no mode byte counts as mode 0; any
// other mode on a 66 byte ECDSA signature reverts.
const coder = AbiCoder.defaultAbiCoder()
const typeHash = (type: string) => keccak256(toUtf8Bytes(type))

const envelopeDigest = (chainId: bigint, account: string, hash: string): string => {
  const domainSeparator = keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address', 'bytes32'],
      [
        typeHash(
          'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)'
        ),
        typeHash('Ambire'),
        typeHash('1'),
        chainId,
        account,
        ZeroHash
      ]
    )
  )
  const structHash = keccak256(
    coder.encode(
      ['bytes32', 'address', 'bytes32'],
      [typeHash('AmbireOperation(address account,bytes32 hash)'), account, hash]
    )
  )
  return keccak256(concat(['0x1901', domainSeparator, structHash]))
}

const ecrecover = (digest: string, rsv: Uint8Array): string | null => {
  try {
    return recoverAddress(digest, hexlify(rsv))
  } catch {
    return null
  }
}

const recoverAsAccount = (
  chainId: bigint,
  account: string,
  hash: string,
  signature: string
): { signer: string; unprotected: boolean } | null => {
  const bytes = getBytes(signature)
  const mode = bytes[bytes.length - 1]
  if (mode >= 6) {
    if (bytes.length !== 65) return null
    const signer = ecrecover(hash, bytes)
    return signer ? { signer, unprotected: true } : null
  }
  if (mode > 1 || (bytes.length !== 65 && bytes.length !== 66)) return null
  const digest = mode === 0 ? hash : envelopeDigest(chainId, account, hash)
  const signer = ecrecover(digest, bytes.slice(0, 65))
  return signer ? { signer, unprotected: mode === 0 } : null
}

// privileges as the chain holds them, keyed by address
const privilegeOf = (privileges: Record<string, bigint>, key: string): bigint =>
  Object.entries(privileges).find(([addr]) => addr.toLowerCase() === key.toLowerCase())?.[1] ?? 0n

// isValidSignature: the signer's privilege must be above 1 for an unprotected
// signature and above 0 for a standard one
const isValidSignature = (
  privileges: Record<string, bigint>,
  chainId: bigint,
  account: string,
  hash: string,
  signature: string
): boolean => {
  const recovered = recoverAsAccount(chainId, account, hash, signature)
  if (!recovered) return false
  return privilegeOf(privileges, recovered.signer) > (recovered.unprotected ? 1n : 0n)
}

// operation acceptance: any ECDSA mode with the signer's privilege above 0, a
// superset of what the deployed account accepts in execute and
// validateUserOp, so a refusal here is a refusal on chain
const authorisesOperation = (
  privileges: Record<string, bigint>,
  chainId: bigint,
  account: string,
  operationHash: string,
  signature: string
): boolean => {
  const recovered = recoverAsAccount(chainId, account, operationHash, signature)
  if (!recovered) return false
  return privilegeOf(privileges, recovered.signer) > 0n
}

// the hash the account computes over its own operation
const operationHash = (
  account: string,
  chainId: bigint,
  nonce: bigint,
  calls: [string, string, string][]
): string =>
  keccak256(
    coder.encode(
      ['address', 'uint', 'uint', 'tuple(address, uint, bytes)[]'],
      [account, chainId, nonce, calls]
    )
  )

// the two modes whose signature is a bare ECDSA signature; the others revert
// on a 66 byte signature
const ecdsaModes = ['00', '01']
const withMode = (signature: string, mode: string) => `${signature.slice(0, -2)}${mode}`
const modeOf = (signature: string) => signature.slice(-2)

// fixtures
const polygon = networks.find((n) => n.chainId === 137n)!
const ethereum = networks.find((n) => n.chainId === 1n)!

const accountAddr = getAddress('0x26d6a373397d553595cd6a7bbabd86debd60a1cc')
const otherAccountAddr = getAddress('0x254d526978d15c9619288949f9419e918977f9f3')
const tokenAddr = getAddress('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359')
const spenderAddr = getAddress('0x000000000022d473030f116ddee9f6b43ac78ba3')

const privKey = keccak256(toUtf8Bytes('throwaway recovered key'))

const keyAddr = new Wallet(privKey).address

const makeSigner = (dedicatedToOneSA: boolean, addr: string = keyAddr) => {
  const key: Key = {
    addr,
    type: 'internal',
    label: 'recovered key',
    dedicatedToOneSA,
    meta: { createdAt: null },
    isExternallyStored: false
  }
  return new KeystoreSigner(key, privKey)
}

const account: Account = {
  addr: accountAddr,
  associatedKeys: [keyAddr],
  creation: {
    factoryAddr: '0xa8202f888b9b2dfa5ceb2204865018133f6f179a',
    bytecode:
      '0x7f00000000000000000000000000000000000000000000000000000000000000027f4cddd6c90a7055aa3d00deceb0664950d2f31114946678b79df2a5540a3238f8553d602d80604d3d3981f3363d3d373d3d3d363d730e370942ebe4d026d05d2cf477ff386338fc415a5af43d82803e903d91602b57fd5bf3',
    salt: ZeroHash
  },
  initialPrivileges: [],
  preferences: { label: 'Recovered account', pfp: accountAddr }
}

const privilegeWord = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`

const makeAccountState = (associatedKeys: { [key: string]: string }): AccountOnchainState => ({
  accountAddr,
  isDeployed: true,
  eoaNonce: null,
  nonce: 0n,
  erc4337Nonce: 0n,
  associatedKeys,
  deployError: false,
  balance: 0n,
  isEOA: false,
  isErc4337Enabled: false,
  isErc4337Nonce: false,
  isV2: true,
  currentBlock: 0n,
  isSmarterEoa: false,
  delegatedContract: null,
  delegatedContractName: null
})

const stateWithPrivilege = (value: bigint) => makeAccountState({ [keyAddr]: privilegeWord(value) })

const messageHex = hexlify(toUtf8Bytes('Sign in to the example app')) as Hex

const permitTypes = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
}

const makePermit = (chainId: bigint): TypedMessage => ({
  kind: 'typedMessage',
  domain: {
    name: 'USD Coin',
    version: '2',
    chainId: chainId.toString(),
    verifyingContract: tokenAddr
  },
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' }
    ],
    ...permitTypes
  },
  message: {
    owner: accountAddr,
    spender: spenderAddr,
    value: '1000000',
    nonce: '0',
    deadline: '1893456000'
  },
  primaryType: 'Permit'
})

const typedDigest = (typed: TypedMessage): string => {
  const { EIP712Domain, ...types } = typed.types
  return TypedDataEncoder.hash(typed.domain, types, typed.message)
}

const signTyped = (typed: TypedMessage, signer: KeystoreSigner, state: AccountOnchainState) =>
  getEIP712Signature(typed, account, state, signer, polygon)

const expectStandardOver = (
  signature: string,
  hash: string,
  chainPrivileges: Record<string, bigint>
) => {
  expect(modeOf(signature)).toBe('01')
  expect(recoverAsAccount(polygon.chainId, accountAddr, hash, signature)?.signer).toBe(keyAddr)
  expect(isValidSignature(chainPrivileges, polygon.chainId, accountAddr, hash, signature)).toBe(
    true
  )
}

describe('v2 signature mode follows the privilege the key holds on the account', () => {
  const atOne = { [keyAddr]: 1n }
  const atTwo = { [keyAddr]: 2n }

  const flagValues = [true, false]
  flagValues.forEach((dedicatedToOneSA) => {
    const label = dedicatedToOneSA ? 'a dedicated key' : 'a key not dedicated to one account'

    test(`${label} at the standard-signing value signs a plain message the account accepts`, async () => {
      const signature = await getPlainTextSignature(
        messageHex,
        polygon,
        account,
        stateWithPrivilege(1n),
        makeSigner(dedicatedToOneSA)
      )
      expectStandardOver(signature, hashMessage(getBytes(messageHex)), atOne)
      expect(
        isValidSignature(
          atOne,
          polygon.chainId,
          accountAddr,
          hashMessage(getBytes(messageHex)),
          withMode(signature, '00')
        )
      ).toBe(false)
    })

    test(`${label} at the standard-signing value signs a permit the account accepts`, async () => {
      const permit = makePermit(polygon.chainId)
      const signature = await signTyped(
        permit,
        makeSigner(dedicatedToOneSA),
        stateWithPrivilege(1n)
      )
      expectStandardOver(signature, typedDigest(permit), atOne)
    })
  })

  test('a dedicated key above the standard-signing value keeps the unprotected mode for both kinds', async () => {
    const signer = makeSigner(true)
    const state = stateWithPrivilege(2n)
    const permit = makePermit(polygon.chainId)
    const plainHash = hashMessage(getBytes(messageHex))

    const plain = await getPlainTextSignature(messageHex, polygon, account, state, signer)
    const typed = await signTyped(permit, signer, state)

    expect(modeOf(plain)).toBe('00')
    expect(modeOf(typed)).toBe('00')
    expect(recoverAsAccount(polygon.chainId, accountAddr, plainHash, plain)?.signer).toBe(keyAddr)
    expect(recoverAsAccount(polygon.chainId, accountAddr, typedDigest(permit), typed)?.signer).toBe(
      keyAddr
    )
    expect(isValidSignature(atTwo, polygon.chainId, accountAddr, plainHash, plain)).toBe(true)
    expect(isValidSignature(atTwo, polygon.chainId, accountAddr, typedDigest(permit), typed)).toBe(
      true
    )
  })

  const unknownOrZero: [string, AccountOnchainState][] = [
    ['missing from the account state', makeAccountState({})],
    ['at zero', stateWithPrivilege(0n)]
  ]
  unknownOrZero.forEach(([label, state]) => {
    test(`a dedicated key ${label} signs both kinds in the standard mode`, async () => {
      const signer = makeSigner(true)
      const permit = makePermit(polygon.chainId)
      const plain = await getPlainTextSignature(messageHex, polygon, account, state, signer)
      const typed = await signTyped(permit, signer, state)

      // the chain may know the key at the standard-signing value even when
      // the account state the wallet holds does not list it
      expectStandardOver(plain, hashMessage(getBytes(messageHex)), atOne)
      expectStandardOver(typed, typedDigest(permit), atOne)
    })
  })

  const caseVariants: [string, string, string][] = [
    ['lower case in the account state', keyAddr.toLowerCase(), keyAddr],
    ['lower case on the key', keyAddr, keyAddr.toLowerCase()]
  ]
  caseVariants.forEach(([label, stateAddr, signerAddr]) => {
    test(`the privilege is found with the address in ${label}`, async () => {
      const signer = makeSigner(true, signerAddr)
      const state = makeAccountState({ [stateAddr]: privilegeWord(2n) })
      const permit = makePermit(polygon.chainId)

      const plain = await getPlainTextSignature(messageHex, polygon, account, state, signer)
      const typed = await signTyped(permit, signer, state)

      expect(modeOf(plain)).toBe('00')
      expect(modeOf(typed)).toBe('00')
    })
  })

  test('typed data is wrapped with the chain the account runs on, not the chain its domain names', async () => {
    const permit = makePermit(ethereum.chainId)
    const signature = await signTyped(permit, makeSigner(true), stateWithPrivilege(1n))

    expectStandardOver(signature, typedDigest(permit), atOne)
    expect(
      isValidSignature(atOne, ethereum.chainId, accountAddr, typedDigest(permit), signature)
    ).toBe(false)
  })
})

describe("the account's own envelope sent as a request", () => {
  const calls: [string, string, string][] = [[spenderAddr, '1000000000000000000', '0x']]
  const innerHash = operationHash(accountAddr, polygon.chainId, 7n, calls)
  const ownEnvelope = getTypedData(polygon.chainId, accountAddr, innerHash)
  const ownEnvelopeDigest = typedDigest(ownEnvelope)

  const cases: [string, boolean, bigint][] = [
    ['a dedicated key at the standard-signing value', true, 1n],
    ['a key not dedicated to one account at the standard-signing value', false, 1n],
    ['a dedicated key above the standard-signing value', true, 2n]
  ]

  cases.forEach(([label, dedicatedToOneSA, privilege]) => {
    const chainPrivileges = { [keyAddr]: privilege }

    test(`${label} signs it wrapped again, never as an authorisation of its inner hash`, async () => {
      const signature = await signTyped(
        ownEnvelope,
        makeSigner(dedicatedToOneSA),
        stateWithPrivilege(privilege)
      )

      // the envelope's own digest is the inner hash wrapped once
      expect(ownEnvelopeDigest).toBe(envelopeDigest(polygon.chainId, accountAddr, innerHash))
      expect(ecrecover(ownEnvelopeDigest, getBytes(signature).slice(0, 65))).not.toBe(keyAddr)

      // the mode byte is not signed: no choice of it turns the signature
      // into one over the inner hash or over the envelope's own digest
      ecdsaModes.forEach((mode) => {
        const swapped = withMode(signature, mode)
        expect(
          isValidSignature(chainPrivileges, polygon.chainId, accountAddr, innerHash, swapped)
        ).toBe(false)
        expect(
          authorisesOperation(chainPrivileges, polygon.chainId, accountAddr, innerHash, swapped)
        ).toBe(false)
      })
      expect(
        isValidSignature(
          chainPrivileges,
          polygon.chainId,
          accountAddr,
          ownEnvelopeDigest,
          withMode(signature, '00')
        )
      ).toBe(false)
      // what the request gets is a signature over the digest it asked for,
      // bound to this account by a second envelope
      expect(
        isValidSignature(
          chainPrivileges,
          polygon.chainId,
          accountAddr,
          ownEnvelopeDigest,
          signature
        )
      ).toBe(true)
      expect(modeOf(signature)).toBe('01')
      expect(
        recoverAsAccount(polygon.chainId, accountAddr, ownEnvelopeDigest, signature)?.signer
      ).toBe(keyAddr)
    })
  })

  test('an envelope whose domain name is a number spelling the same bytes is wrapped again', async () => {
    const numericName = getTypedData(polygon.chainId, accountAddr, innerHash)
    numericName.domain = {
      ...numericName.domain,
      name: 71938058318437 as unknown as string
    }
    // the signing library hashes the number as the bytes of "Ambire", so its
    // digest is the account's own envelope digest
    expect(
      hexlify(
        TypedDataUtils.eip712Hash(
          adaptTypedMessageForMetaMaskSigUtil(numericName),
          SignTypedDataVersion.V4
        )
      )
    ).toBe(ownEnvelopeDigest)

    const chainPrivileges = { [keyAddr]: 2n }
    const signature = await signTyped(numericName, makeSigner(true), stateWithPrivilege(2n))

    expect(ecrecover(ownEnvelopeDigest, getBytes(signature).slice(0, 65))).not.toBe(keyAddr)
    ecdsaModes.forEach((mode) => {
      const swapped = withMode(signature, mode)
      expect(
        isValidSignature(chainPrivileges, polygon.chainId, accountAddr, innerHash, swapped)
      ).toBe(false)
      expect(
        authorisesOperation(chainPrivileges, polygon.chainId, accountAddr, innerHash, swapped)
      ).toBe(false)
    })
    expect(
      isValidSignature(
        chainPrivileges,
        polygon.chainId,
        accountAddr,
        ownEnvelopeDigest,
        withMode(signature, '00')
      )
    ).toBe(false)
    expect(modeOf(signature)).toBe('01')
  })

  test("another account's envelope is wrapped again, so it authorises nothing on that account where the key also holds a privilege", async () => {
    const otherInnerHash = operationHash(otherAccountAddr, polygon.chainId, 0n, calls)
    const otherEnvelope = getTypedData(polygon.chainId, otherAccountAddr, otherInnerHash)
    const otherEnvelopeDigest = typedDigest(otherEnvelope)
    const otherPrivileges = { [keyAddr]: 1n }

    const signature = await signTyped(otherEnvelope, makeSigner(true), stateWithPrivilege(2n))

    expect(ecrecover(otherEnvelopeDigest, getBytes(signature).slice(0, 65))).not.toBe(keyAddr)
    ecdsaModes.forEach((mode) => {
      const swapped = withMode(signature, mode)
      const hashes = [otherInnerHash, otherEnvelopeDigest]
      hashes.forEach((hash) => {
        expect(
          isValidSignature(otherPrivileges, polygon.chainId, otherAccountAddr, hash, swapped)
        ).toBe(false)
        expect(
          authorisesOperation(otherPrivileges, polygon.chainId, otherAccountAddr, hash, swapped)
        ).toBe(false)
      })
    })
    expect(modeOf(signature)).toBe('01')
  })
})

describe('the account operation types sent as a request', () => {
  const transactionType = [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }
  ]
  const domainType = [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
    { name: 'salt', type: 'bytes32' }
  ]
  const domain = {
    name: 'Ambire',
    version: '1',
    chainId: polygon.chainId.toString(),
    verifyingContract: accountAddr,
    salt: ZeroHash
  }
  const call = { to: spenderAddr, value: '1000000000000000000', data: '0x' }

  const executeOp: TypedMessage = {
    kind: 'typedMessage',
    domain,
    types: {
      EIP712Domain: domainType,
      Transaction: transactionType,
      AmbireExecuteAccountOp: [
        { name: 'account', type: 'address' },
        { name: 'chainId', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'calls', type: 'Transaction[]' },
        { name: 'hash', type: 'bytes32' }
      ]
    },
    message: {
      account: accountAddr,
      chainId: polygon.chainId.toString(),
      nonce: '0',
      calls: [call],
      hash: operationHash(accountAddr, polygon.chainId, 0n, [[call.to, call.value, call.data]])
    },
    primaryType: 'AmbireExecuteAccountOp'
  }

  const userOp: TypedMessage = {
    kind: 'typedMessage',
    domain,
    types: {
      EIP712Domain: domainType,
      Transaction: transactionType,
      Ambire4337AccountOp: [
        { name: 'account', type: 'address' },
        { name: 'chainId', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'initCode', type: 'bytes' },
        { name: 'accountGasLimits', type: 'bytes32' },
        { name: 'preVerificationGas', type: 'uint256' },
        { name: 'gasFees', type: 'bytes32' },
        { name: 'paymasterAndData', type: 'bytes' },
        { name: 'callData', type: 'bytes' },
        { name: 'calls', type: 'Transaction[]' },
        { name: 'hash', type: 'bytes32' }
      ]
    },
    message: {
      account: accountAddr,
      chainId: polygon.chainId.toString(),
      nonce: '0',
      initCode: '0x',
      accountGasLimits: ZeroHash,
      preVerificationGas: '0',
      gasFees: ZeroHash,
      paymasterAndData: '0x',
      callData: '0x',
      calls: [call],
      hash: ZeroHash
    },
    primaryType: 'Ambire4337AccountOp'
  }

  const messages: TypedMessage[] = [executeOp, userOp]
  const signers: [string, boolean, bigint][] = [
    ['a dedicated key above the standard-signing value', true, 2n],
    ['a dedicated key at the standard-signing value', true, 1n],
    ['a key not dedicated to one account at the standard-signing value', false, 1n]
  ]
  messages.forEach((message) => {
    signers.forEach(([label, dedicatedToOneSA, privilege]) => {
      test(`${label} is refused an ${String(message.primaryType)} and signs nothing`, async () => {
        const signer = makeSigner(dedicatedToOneSA)
        const signTypedData = jest.spyOn(signer, 'signTypedData')
        const signMessage = jest.spyOn(signer, 'signMessage')

        await expect(signTyped(message, signer, stateWithPrivilege(privilege))).rejects.toThrow(
          'Ambire account operation'
        )
        expect(signTypedData).not.toHaveBeenCalled()
        expect(signMessage).not.toHaveBeenCalled()
      })
    })
  })
})

describe('the wallet authorising the entry point on the first ERC-4337 operation', () => {
  const nonce = 0n
  const activator = getActivatorCall(accountAddr)
  const activatorHash = operationHash(accountAddr, polygon.chainId, nonce, [callToTuple(activator)])

  const signers: [string, boolean, bigint][] = [
    ['a dedicated key', true, 2n],
    ['a key not dedicated to one account', false, 1n]
  ]
  signers.forEach(([label, dedicatedToOneSA, privilege]) => {
    test(`${label} gives a standard signature that authorises the activation`, async () => {
      const signature = await getEntryPointAuthorizationSignature(
        accountAddr,
        polygon.chainId,
        nonce,
        makeSigner(dedicatedToOneSA)
      )

      expect(modeOf(signature)).toBe('01')
      expect(recoverAsAccount(polygon.chainId, accountAddr, activatorHash, signature)?.signer).toBe(
        keyAddr
      )
      expect(
        authorisesOperation(
          { [keyAddr]: privilege },
          polygon.chainId,
          accountAddr,
          activatorHash,
          signature
        )
      ).toBe(true)
    })
  })

  test('for a dedicated key above the standard-signing value, the bytes equal a raw unprotected signature of the envelope with its last byte made standard', async () => {
    const authorization = await getEntryPointAuthorization(accountAddr, polygon.chainId, nonce)
    const signer = makeSigner(true)
    const rawUnprotected = `${await signer.signTypedData(authorization)}00`

    expect(
      await getEntryPointAuthorizationSignature(accountAddr, polygon.chainId, nonce, signer)
    ).toBe(withMode(rawUnprotected, '01'))
  })
})

describe('an AmbireReadableOperation signed for another account', () => {
  const readable = {
    addr: otherAccountAddr as Hex,
    chainId: polygon.chainId,
    nonce: 3n,
    calls: [{ to: spenderAddr as Hex, value: 0n, data: '0x' as Hex }]
  }
  const readableHash = operationHash(
    readable.addr,
    readable.chainId,
    readable.nonce,
    readable.calls.map(callToTuple)
  )

  const signers: [string, boolean, bigint][] = [
    ['a dedicated key above the standard-signing value', true, 2n],
    ['a dedicated key at the standard-signing value', true, 1n],
    ['a key not dedicated to one account at the standard-signing value', false, 1n]
  ]
  signers.forEach(([label, dedicatedToOneSA, privilege]) => {
    test(`${label} signs as the account, with the account's address before the wallet mode`, async () => {
      const typed = getAmbireReadableTypedData(polygon.chainId, accountAddr, readable)
      const signature = await signTyped(
        typed,
        makeSigner(dedicatedToOneSA),
        stateWithPrivilege(privilege)
      )

      expect(modeOf(signature)).toBe('02')
      const walletWord = signature.slice(-66, -2)
      expect(getAddress(`0x${walletWord.slice(24)}`)).toBe(accountAddr)
      expect(walletWord.slice(0, 24)).toBe('0'.repeat(24))

      const inner = signature.slice(0, -66)
      expect(recoverAsAccount(readable.chainId, accountAddr, readableHash, inner)?.signer).toBe(
        keyAddr
      )
      expect(
        isValidSignature(
          { [keyAddr]: privilege },
          readable.chainId,
          accountAddr,
          readableHash,
          inner
        )
      ).toBe(true)
    })
  })
})
