import { AbiCoder, getBytes, Interface, keccak256, toBeHex } from 'ethers'

// eslint-disable-next-line import/no-cycle
import { EIP7702Auth } from '../../consts/7702'
import { SINGLETON } from '../../consts/deploy'
import { AccountId } from '../../interfaces/account'
import { Key } from '../../interfaces/keystore'
import { AccountOpRecoveryKit } from '../../interfaces/recoveryKit'
import { SwapAndBridgeSendTxRequest } from '../../interfaces/swapAndBridge'
import { PaymasterService } from '../erc7677/types'
import { stringify } from '../richJson/richJson'
import { UserOperation } from '../userOperation/types'
import { AccountOpStatus, Call } from './types'

// This is an abstract representation of the gas fee payment
// 1) it cannot contain details about maxFeePerGas/baseFee because some networks might not be aware of EIP-1559; it only cares about total amount
// 2) it cannot contain info about the mechanism of payment (from EOA but on smart account, pure EOA paying it's fee directly, 4337 paymaster, 4337 direct, relayer, etc.)
// This info can be inferred when needed from the account type and whether we're running in 4337 mode or not
// 3) isGasTank and isERC4337 can both be true
// 4) whether those values are sane will be checked in an additional function (currently `canBroadcast`); for example, this function is meant to ensure that in case of an EOA, the fee is always paid in native
export interface GasFeePayment {
  isGasTank: boolean
  paidBy: string
  inToken: string
  // optional, because older versions of the extension did not have this stored locally
  feeTokenChainId?: bigint
  amount: bigint
  simulatedGasLimit: bigint
  gasPrice: bigint
  broadcastOption: string
  maxPriorityFeePerGas?: bigint
  isSponsored?: boolean
}

// Equivalent to ERC-4337 UserOp, but more universal than it since a AccountOp can be transformed to
// a UserOp, or to a direct EOA transaction, or relayed through the Ambire relayer
// it is more precisely defined than a UserOp though - UserOp just has calldata and this has individual `calls`
export interface AccountOp {
  accountAddr: string
  chainId: bigint
  // this may not be defined, in case the user has not picked a key yet
  signingKeyAddr: Key['addr'] | null
  signingKeyType: Key['type'] | null
  // this may not be set in case we haven't set it yet
  // this is a number and not a bigint because of ethers (it uses number for nonces)
  nonce: bigint | null
  // @TODO: nonce namespace? it is dependent on gasFeePayment
  calls: Call[]
  // the feeCall is an extra call we add manually when there's a
  // relayer/paymaster transaction so that the relayer/paymaster
  // can authorize the payment
  feeCall?: Call
  // the activator call is for cases where we want to activate the EntryPoint
  // it existed previously in the UserOperation type but now it is no longer
  // limited to it as we can broadcast none ERC-4337 txn with an activatorCall
  activatorCall?: Call
  gasLimit: number | null
  signature: string | null
  gasFeePayment: GasFeePayment | null
  // This is used when we have an account recovery to finalize before executing the AccountOp,
  // And we set this to the recovery finalization AccountOp; could be used in other scenarios too in the future,
  // for example account migration (from v1 QuickAcc to v2)
  // theoretically you can recurse these (an AccountOp set as *ToExecuteBefore can have another accountOpToExecuteBefore)
  // however, in practice we only use this for recovery atm and we never have a case with more than one
  // Supporting this can done relatively easily via executeMany() for v2 accounts, and with multiple UserOps via 4337 (again v2 accs)
  accountOpToExecuteBefore: AccountOp | null
  txnId?: string
  status?: AccountOpStatus
  // in the case of ERC-4337, we need an UserOperation structure for the AccountOp
  asUserOperation?: UserOperation
  // all kinds of custom accountOp properties that are needed in specific cases
  meta?: {
    // pass the entry point authorization signature for the deploy 4337 txn
    entryPointAuthorization?: string
    paymasterService?: PaymasterService
    swapTxn?: SwapAndBridgeSendTxRequest
    walletSendCallsVersion?: string
    delegation?: EIP7702Auth
    setDelegation?: boolean
    /** Used to determine if the account op is up-to-date with the latest quote */
    fromQuoteId?: string
    recoveryKit?: AccountOpRecoveryKit
  }
  flags?: {
    hideActivityBanner?: boolean
  }
}

/**
 * If we want to deploy a contract, the to field of Call will actually
 * be empty (undefined). In order to simulate it in a transaction or
 * perform it using a smart account, we need to transform the call to
 * a call to the singleton
 *
 * @param call
 * @returns Call
 */
export function toSingletonCall(call: Call): Call {
  if (call.to) return call

  const singletonABI = [
    {
      inputs: [
        { internalType: 'bytes', name: '_initCode', type: 'bytes' },
        { internalType: 'bytes32', name: '_salt', type: 'bytes32' }
      ],
      name: 'deploy',
      outputs: [{ internalType: 'address payable', name: 'createdContract', type: 'address' }],
      stateMutability: 'nonpayable',
      type: 'function'
    }
  ]
  const singletonInterface = new Interface(singletonABI)
  return {
    to: SINGLETON,
    value: call.value,
    data: singletonInterface.encodeFunctionData('deploy', [call.data, toBeHex(0, 32)])
  }
}

export function callToTuple(call: Call): [string, string, string] {
  return [call.to, call.value.toString(), call.data]
}

export function canBroadcast(op: AccountOp, accountIsEOA: boolean): boolean {
  if (op.signingKeyAddr === null) throw new Error('missing signingKeyAddr')
  if (op.signature === null) throw new Error('missing signature')
  if (op.gasFeePayment === null) throw new Error('missing gasFeePayment')
  if (op.gasLimit === null) throw new Error('missing gasLimit')
  if (op.nonce === null) throw new Error('missing nonce')
  if (accountIsEOA) {
    if (op.gasFeePayment.isGasTank)
      throw new Error('gas fee payment with gas tank cannot be used with an EOA')
    if (op.gasFeePayment.inToken !== '0x0000000000000000000000000000000000000000')
      throw new Error('gas fee payment needs to be in the native asset')
    if (op.gasFeePayment.paidBy !== op.accountAddr)
      throw new Error('gas fee payment cannot be paid by anyone other than the EOA that signed it')
  }
  return true
}

/**
 * Compare two AccountOps intents.
 *
 * By 'intent,' we are referring to the sender of the transaction, the network it is sent on, and the included calls.
 *
 * Since we are comparing the intents, we exclude any other properties of the AccountOps.
 */
export function isAccountOpsIntentEqual(
  accountOps1: AccountOp[],
  accountOps2: AccountOp[]
): boolean {
  const createIntent = (accountOps: AccountOp[]) => {
    return accountOps.map(({ accountAddr, chainId, calls }) => ({
      accountAddr,
      chainId,
      calls
    }))
  }

  return stringify(createIntent(accountOps1)) === stringify(createIntent(accountOps2))
}

export function getSignableCalls(op: AccountOp): [string, string, string][] {
  const callsToSign = op.calls.map(toSingletonCall).map(callToTuple)
  if (op.activatorCall) callsToSign.push(callToTuple(op.activatorCall))
  if (op.feeCall) callsToSign.push(callToTuple(op.feeCall))
  return callsToSign
}

export function getSignableHash(
  addr: AccountId,
  chainId: bigint,
  nonce: bigint,
  calls: [string, string, string][]
): Uint8Array {
  const abiCoder = new AbiCoder()
  return getBytes(
    keccak256(
      abiCoder.encode(
        ['address', 'uint', 'uint', 'tuple(address, uint, bytes)[]'],
        [addr, chainId, nonce, calls]
      )
    )
  )
}

/**
 * This function returns the hash as a Uint8Array instead of string
 * and the reason for this is the implementation that follows:
 *
 * const hash = accountOpSignableHash(op); // get the hash
 * const signature = await wallet.signMessage(hash)
 *
 * The signMessage method is an ethers method. It checks whether
 * the hash is a string or not. If it's a string, it calls
 * ethers.toUtf8Bytes to it, completing ignoring that the string
 * might actually be abi-encoded (like in our case).
 *
 * Applying ethers.toUtf8Bytes to a string is only correct if the
 * string is... a utf8 string. In our case, IT IS NOT.
 * That's why we need to wrap in with ethers.getBytes to prevent
 * the sign message from breaking it.
 *
 * If despite everything you wish to return a string instead of a Uint8Array,
 * you have to wrap the hash with ethers.getBytes each time before passing it
 * to signMessage. Also, the reverse method of ethers.getBytes is ethers.hexlify
 * if you need to transform it back.
 *
 * @param op AccountOp
 * @returns Uint8Array
 */
export function accountOpSignableHash(op: AccountOp, chainId: bigint): Uint8Array {
  return getSignableHash(op.accountAddr, chainId, op.nonce ?? 0n, getSignableCalls(op))
}
