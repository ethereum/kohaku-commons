import { Interface, toQuantity, Transaction } from 'ethers'

import { describe, expect, test } from '@jest/globals'

import AmbireAccount from '../../../contracts/compiled/AmbireAccount.json'
import AmbireFactory from '../../../contracts/compiled/AmbireFactory.json'
import { produceMemoryStore } from '../../../test/helpers'
import { mockWindowManager } from '../../../test/helpers/window'
import { KeystoreController } from '../../controllers/keystore/keystore'
import { StorageController } from '../../controllers/storage/storage'
import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import { networks } from '../../consts/networks'
import { Account, AccountOnchainState } from '../../interfaces/account'
import { Network } from '../../interfaces/network'
import { RPCProvider } from '../../interfaces/provider'
import { KeystoreSigner } from '../keystoreSigner/keystoreSigner'
import { AccountOp } from '../accountOp/accountOp'
import { BROADCAST_OPTIONS, buildRawTransaction } from './broadcast'

type ProviderStub = {
  provider: RPCProvider
  estimateFrom: string[]
  nonceReadsFor: string[]
}

const controllingKey = {
  privKey: '0x1941fd49fae923cae5ba789ac8ed2662066861960c7aa339443e76d309a80f6f',
  addr: '0x16c81367c30c71d6B712355255A07FCe8fd3b5bB',
  pass: 'testpass'
}

const network: Network = { ...networks.find((n) => n.chainId === 1n)!, chainId: 11155111n }

const smartAccount: Account = {
  addr: '0x4AA524DDa82630cE769e5C9d7ec7a45B94a41bc6',
  associatedKeys: [controllingKey.addr],
  initialPrivileges: [],
  creation: {
    factoryAddr: '0xa8202f888b9b2dfa5ceb2204865018133f6f179a',
    bytecode: '0x00',
    salt: '0x0000000000000000000000000000000000000000000000000000000000000000'
  },
  preferences: { label: DEFAULT_ACCOUNT_LABEL, pfp: '' }
}

const makeState = (isDeployed: boolean): AccountOnchainState => ({
  accountAddr: smartAccount.addr,
  isDeployed,
  eoaNonce: null,
  nonce: 0n,
  erc4337Nonce: 0n,
  associatedKeys: {},
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

const op: AccountOp = {
  accountAddr: smartAccount.addr,
  chainId: network.chainId,
  signingKeyAddr: controllingKey.addr,
  signingKeyType: 'internal',
  gasLimit: null,
  nonce: 0n,
  signature: '0x01',
  accountOpToExecuteBefore: null,
  calls: [{ to: smartAccount.addr, value: 0n, data: '0x' }],
  gasFeePayment: {
    paidBy: controllingKey.addr,
    isGasTank: false,
    inToken: '0x0000000000000000000000000000000000000000',
    feeTokenChainId: network.chainId,
    amount: 1n,
    simulatedGasLimit: 100000n,
    gasPrice: 2000000000n,
    maxPriorityFeePerGas: 1000000000n,
    broadcastOption: BROADCAST_OPTIONS.byOtherEOA
  }
}

const makeProvider = (payerNonce: number): ProviderStub => {
  const estimateFrom: string[] = []
  const nonceReadsFor: string[] = []
  const provider = {
    send: async (method: string, params: [{ from: string }]) => {
      if (method === 'eth_estimateGas') {
        estimateFrom.push(params[0].from)
      }
      return toQuantity(90000n)
    },
    getTransactionCount: async (addr: string) => {
      nonceReadsFor.push(addr)
      return payerNonce
    }
  } as unknown as RPCProvider
  return { provider, estimateFrom, nonceReadsFor }
}

const makeKeystore = async () => {
  const storage = new StorageController(produceMemoryStore())
  const keystore = new KeystoreController(
    'default',
    storage,
    { internal: KeystoreSigner },
    mockWindowManager().windowManager
  )
  await keystore.addSecret('passphrase', controllingKey.pass, '', false)
  await keystore.unlockWithSecret('passphrase', controllingKey.pass)
  await keystore.addKeys([
    {
      addr: controllingKey.addr,
      type: 'internal',
      label: 'Key 1',
      privateKey: controllingKey.privKey,
      dedicatedToOneSA: true,
      meta: { createdAt: new Date().getTime() }
    }
  ])
  return keystore
}

describe('Broadcast by another payer accepts a key the keystore holds that is not a listed account', () => {
  test('the key the keystore holds pays for an undeployed account: it signs a deploy and execute with its own nonce', async () => {
    const keystore = await makeKeystore()
    const payerNonce = 7
    const { provider, estimateFrom, nonceReadsFor } = makeProvider(payerNonce)

    const feePayerKey = keystore.getFeePayerKey(op)
    if (feePayerKey instanceof Error) {
      throw feePayerKey
    }
    expect(feePayerKey.addr).toBe(controllingKey.addr)

    const rawTxn = await buildRawTransaction(
      smartAccount,
      op,
      makeState(false),
      provider,
      network,
      payerNonce,
      BROADCAST_OPTIONS.byOtherEOA
    )
    const signer = await keystore.getSigner(feePayerKey.addr, feePayerKey.type)
    const signed = Transaction.from(await signer.signRawTransaction(rawTxn))

    expect(signed.from).toBe(controllingKey.addr)
    expect(signed.nonce).toBe(payerNonce)
    expect(signed.chainId).toBe(network.chainId)
    expect(signed.to?.toLowerCase()).toBe(smartAccount.creation!.factoryAddr.toLowerCase())
    expect(new Interface(AmbireFactory.abi).parseTransaction({ data: signed.data })?.name).toBe(
      'deployAndExecute'
    )
    expect(estimateFrom).toEqual([controllingKey.addr])
    expect(nonceReadsFor).toEqual([controllingKey.addr])
  })

  test('the key pays for a deployed account: it signs an execute on the account', async () => {
    const keystore = await makeKeystore()
    const { provider } = makeProvider(3)

    const rawTxn = await buildRawTransaction(
      smartAccount,
      op,
      makeState(true),
      provider,
      network,
      3,
      BROADCAST_OPTIONS.byOtherEOA
    )
    const signer = await keystore.getSigner(controllingKey.addr, 'internal')
    const signed = Transaction.from(await signer.signRawTransaction(rawTxn))

    expect(signed.from).toBe(controllingKey.addr)
    expect(signed.to).toBe(smartAccount.addr)
    expect(new Interface(AmbireAccount.abi).parseTransaction({ data: signed.data })?.name).toBe(
      'execute'
    )
  })

  test('a payer the keystore does not hold is refused', async () => {
    const keystore = await makeKeystore()
    const strangerOp: AccountOp = {
      ...op,
      gasFeePayment: { ...op.gasFeePayment!, paidBy: '0x141A14B5C4dbA2aC7a7943E02eDFE2E7eDfdA28F' }
    }

    expect(keystore.getFeePayerKey(strangerOp)).toBeInstanceOf(Error)
  })
})
