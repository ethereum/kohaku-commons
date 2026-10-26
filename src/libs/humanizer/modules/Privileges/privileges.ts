import { AbiCoder, getAddress, id, Interface, keccak256, ZeroHash } from 'ethers'

import AmbireAccount from '../../../../../contracts/compiled/AmbireAccount.json'
import { ENTRY_POINT_MARKER } from '../../../../consts/deploy'
import { AccountOp } from '../../../accountOp/accountOp'
import { HumanizerCallModule, HumanizerMeta, IrCall } from '../../interfaces'
import { getAction, getAddressVisualization, getKnownName, getLabel, getWarning } from '../../utils'

const iface = new Interface(AmbireAccount.abi)
const SET_ADDR_PRIVILEGE_SELECTOR = iface.getFunction('setAddrPrivilege')!.selector
// The recovery kit manager's commitSetup(address action, bytes32 setupCommitment, uint64 nonce,
// bytes publicMetadata, bytes privateMetadata)
const COMMIT_SETUP_SELECTOR = id('commitSetup(address,bytes32,uint64,bytes,bytes)').slice(0, 10)
const abiCoder = AbiCoder.defaultAbiCoder()

const isCallTo = (call: Pick<IrCall, 'to'>, addr: string): boolean =>
  !!call.to && call.to.toLowerCase() === addr.toLowerCase()

type RecoveryKitOp = Pick<AccountOp, 'accountAddr' | 'calls' | 'meta'>
type RecoveryKitCall = Pick<IrCall, 'to' | 'data' | 'fromUserRequestId'>

const kitSlot = (action: string): string =>
  getAddress(`0x${keccak256(abiCoder.encode(['string', 'address'], ['kit', action])).slice(-40)}`)

const kitGrantValue = (action: string): string =>
  keccak256(abiCoder.encode(['address', 'string'], [action, '']))

const isFromKitRequest = (
  accountOp: RecoveryKitOp,
  call: Pick<IrCall, 'fromUserRequestId'>
): boolean => {
  const recoveryKit = accountOp.meta?.recoveryKit
  return (
    !!recoveryKit &&
    call.fromUserRequestId !== undefined &&
    call.fromUserRequestId === recoveryKit.fromUserRequestId
  )
}

// A privilege write the recovery kit may make is a setAddrPrivilege call the account makes to
// itself, from the one user request that carries the recovery kit.
const decodeKitPrivilegeWrite = (
  accountOp: RecoveryKitOp,
  call: RecoveryKitCall
): { addr: string; priv: string } | undefined => {
  if (!accountOp.meta?.recoveryKit || !isCallTo(call, accountOp.accountAddr)) {
    return undefined
  }
  if (!isFromKitRequest(accountOp, call)) {
    return undefined
  }
  if (!call.data || call.data.slice(0, 10).toLowerCase() !== SET_ADDR_PRIVILEGE_SELECTOR) {
    return undefined
  }
  try {
    const [addr, priv] = iface.decodeFunctionData('setAddrPrivilege', call.data)
    return { addr, priv }
  } catch {
    return undefined
  }
}

// The recovery kit grants each audited action a privilege on the account through a call the
// account makes to itself: setAddrPrivilege(slot, value), where the slot is the address taken
// from keccak256(abi.encode("kit", action)) and the value is keccak256(abi.encode(action, "")).
// That exact call is trusted only when the same batch commits the kit's setup on its manager,
// and only when both calls come from the one user request that carries the recovery kit.
const findRecoveryKitAction = (
  accountOp: RecoveryKitOp,
  call: RecoveryKitCall
): string | undefined => {
  const recoveryKit = accountOp.meta?.recoveryKit
  const write = decodeKitPrivilegeWrite(accountOp, call)
  if (!recoveryKit || !write) {
    return undefined
  }
  const commitsSetup = accountOp.calls.some(
    (c) =>
      isFromKitRequest(accountOp, c) &&
      isCallTo(c, recoveryKit.manager) &&
      !!c.data &&
      c.data.slice(0, 10).toLowerCase() === COMMIT_SETUP_SELECTOR
  )
  if (!commitsSetup) {
    return undefined
  }
  return recoveryKit.auditedActions.find(
    (action) =>
      getAddress(write.addr) === kitSlot(action) &&
      write.priv.toLowerCase() === kitGrantValue(action)
  )
}

export const isRecoveryKitGrant = (accountOp: RecoveryKitOp, call: RecoveryKitCall): boolean =>
  findRecoveryKitAction(accountOp, call) !== undefined

// The recovery kit revokes an audited action's privilege by writing the zero word at that
// action's kit slot, from the request that carries the recovery kit. Taking a privilege away
// needs no setup beside it.
const findRecoveryKitRevokedAction = (
  accountOp: RecoveryKitOp,
  call: RecoveryKitCall
): string | undefined => {
  const recoveryKit = accountOp.meta?.recoveryKit
  const write = decodeKitPrivilegeWrite(accountOp, call)
  if (!recoveryKit || !write || write.priv.toLowerCase() !== ZeroHash) {
    return undefined
  }
  return recoveryKit.auditedActions.find((action) => getAddress(write.addr) === kitSlot(action))
}

const isRecoveryKitRevoke = (accountOp: RecoveryKitOp, call: RecoveryKitCall): boolean =>
  findRecoveryKitRevokedAction(accountOp, call) !== undefined

export const isRecoveryKitPrivilegeWrite = (
  accountOp: RecoveryKitOp,
  call: RecoveryKitCall
): boolean => isRecoveryKitGrant(accountOp, call) || isRecoveryKitRevoke(accountOp, call)

// Any grant other than the entry point's lets the granted address act as the called account,
// so it is shown as a danger. The call may target another account than the one signing,
// in which case the warning names that account. Warnings earlier modules attached are kept.
const parsePrivilegeCall = (
  accountOp: AccountOp,
  humanizerMeta: HumanizerMeta,
  call: IrCall
): Pick<IrCall, 'fullVisualization' | 'warnings'> => {
  const { addr, priv } = iface.parseTransaction(call)!.args
  if (getKnownName(humanizerMeta, addr)?.includes('entry point') && priv === ENTRY_POINT_MARKER)
    return { fullVisualization: [getAction('Enable'), getAddressVisualization(addr)] }
  if (priv === ZeroHash)
    return {
      fullVisualization: [getAction('Revoke access'), getLabel('of'), getAddressVisualization(addr)]
    }
  return {
    fullVisualization: [
      getAction('Update access status', { warning: true }),
      getLabel('of'),
      getAddressVisualization(addr),
      getLabel('to'),
      priv === '0x0000000000000000000000000000000000000000000000000000000000000001'
        ? getLabel('regular access')
        : getLabel(priv)
    ],
    warnings: [
      ...(call.warnings || []),
      getWarning(
        `This transaction grants control of ${
          !call.to || call.to.toLowerCase() === accountOp.accountAddr.toLowerCase()
            ? 'this account'
            : `the account ${getAddress(call.to)}`
        } to ${getAddress(addr)}!`,
        'danger'
      )
    ]
  }
}

export const privilegeHumanizer: HumanizerCallModule = (
  accountOp: AccountOp,
  irCalls: IrCall[],
  humanizerMeta: HumanizerMeta
) => {
  const newCalls = irCalls.map((call) => {
    const recoveryKitAction = findRecoveryKitAction(accountOp, call)
    if (recoveryKitAction) {
      return {
        ...call,
        fullVisualization: [
          getAction('Enable recovery module'),
          getAddressVisualization(recoveryKitAction)
        ]
      }
    }
    const revokedAction = findRecoveryKitRevokedAction(accountOp, call)
    if (revokedAction) {
      return {
        ...call,
        fullVisualization: [
          getAction('Disable recovery module'),
          getAddressVisualization(revokedAction)
        ]
      }
    }
    if (call.data.slice(0, 10).toLowerCase() === SET_ADDR_PRIVILEGE_SELECTOR) {
      return {
        ...call,
        ...parsePrivilegeCall(accountOp, humanizerMeta, call)
      }
    }
    return call
  })
  return newCalls
}
