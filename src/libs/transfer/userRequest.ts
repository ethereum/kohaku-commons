import { Interface, parseUnits } from 'ethers'
import { v4 as uuidv4 } from 'uuid'

import IERC20 from '../../../contracts/compiled/IERC20.json'
import WALLETSupplyControllerABI from '../../../contracts/compiled/WALLETSupplyController.json'
import WETH from '../../../contracts/compiled/WETH.json'
import { Session } from '../../classes/session'
import { FEE_COLLECTOR, STK_WALLET, SUPPLY_CONTROLLER_ADDR } from '../../consts/addresses'
import { networks } from '../../consts/networks'
import { Calls, PlainTextMessage, SignUserRequest } from '../../interfaces/userRequest'
import { PaymasterService } from '../erc7677/types'
import { AddrVestingData, ClaimableRewardsData, TokenResult } from '../portfolio'
import { getSanitizedAmount } from './amount'

const ERC20 = new Interface(IERC20.abi)
const supplyControllerInterface = new Interface(WALLETSupplyControllerABI)

interface BuildUserRequestParams {
  amount: string
  selectedToken: TokenResult
  selectedAccount: string
  recipientAddress: string
  paymasterService?: PaymasterService
  windowId?: number
}

function buildMintVestingRequest({
  selectedAccount,
  selectedToken,
  addrVestingData,
  windowId
}: {
  selectedAccount: string
  selectedToken: TokenResult
  addrVestingData: AddrVestingData
  windowId?: number
}): SignUserRequest {
  const txn = {
    kind: 'calls' as Calls['kind'],
    calls: [
      {
        to: SUPPLY_CONTROLLER_ADDR,
        value: BigInt(0),
        data: supplyControllerInterface.encodeFunctionData('mintVesting', [
          addrVestingData?.addr,
          addrVestingData?.end,
          addrVestingData?.rate
        ])
      }
    ]
  }
  return {
    id: new Date().getTime(),
    action: txn,
    session: new Session({ windowId }),
    meta: {
      isSignAction: true,
      chainId: selectedToken.chainId,
      accountAddr: selectedAccount
    }
  }
}

function buildClaimWalletRequest({
  selectedAccount,
  selectedToken,
  claimableRewardsData,
  windowId
}: {
  selectedAccount: string
  selectedToken: TokenResult
  claimableRewardsData: ClaimableRewardsData
  windowId?: number
}): SignUserRequest {
  const txn = {
    kind: 'calls' as Calls['kind'],
    calls: [
      {
        to: SUPPLY_CONTROLLER_ADDR,
        value: BigInt(0),
        data: supplyControllerInterface.encodeFunctionData('claimWithRootUpdate', [
          claimableRewardsData?.totalClaimable,
          claimableRewardsData?.proof,
          0, // penalty bps, at the moment we run with 0; it's a safety feature to hardcode it
          STK_WALLET, // staking pool addr
          claimableRewardsData?.root,
          claimableRewardsData?.signedRoot
        ])
      }
    ]
  }
  return {
    id: new Date().getTime(),
    action: txn,
    session: new Session({ windowId }),
    meta: {
      isSignAction: true,
      chainId: selectedToken.chainId,
      accountAddr: selectedAccount
    }
  }
}

function buildTransferUserRequest({
  amount,
  selectedToken,
  selectedAccount,
  recipientAddress: _recipientAddress,
  paymasterService,
  windowId
}: BuildUserRequestParams): SignUserRequest | null {
  if (!selectedToken || !selectedAccount || !_recipientAddress) return null

  // if the request is a top up, the recipient is the relayer
  const recipientAddress = _recipientAddress?.toLowerCase()
  const sanitizedAmount = getSanitizedAmount(amount, selectedToken.decimals)

  const bigNumberHexAmount = `0x${parseUnits(
    sanitizedAmount,
    Number(selectedToken.decimals)
  ).toString(16)}`

  // if the top up is a native one, we should wrap the native before sending it
  // as otherwise a Transfer event is not emitted and the top up will not be
  // recorded
  const isNativeTopUp =
    Number(selectedToken.address) === 0 &&
    recipientAddress.toLowerCase() === FEE_COLLECTOR.toLowerCase()

  if (isNativeTopUp) {
    // if not predefined network, we cannot make a native top up
    const network = networks.find((n) => n.chainId === selectedToken.chainId)
    if (!network) return null

    // if a wrapped addr is not specified, we cannot make a native top up
    const wrappedAddr = network.wrappedAddr
    if (!wrappedAddr) return null

    const wrapped = new Interface(WETH)
    const deposit = wrapped.encodeFunctionData('deposit')
    const calls: Calls = {
      kind: 'calls' as const,
      calls: [
        {
          to: wrappedAddr,
          value: BigInt(bigNumberHexAmount),
          data: deposit
        },
        {
          to: wrappedAddr,
          value: BigInt(0),
          data: ERC20.encodeFunctionData('transfer', [recipientAddress, bigNumberHexAmount])
        }
      ]
    }

    return {
      id: new Date().getTime(),
      action: calls,
      session: new Session({ windowId }),
      meta: {
        isSignAction: true,
        chainId: selectedToken.chainId,
        accountAddr: selectedAccount,
        paymasterService
      }
    }
  }

  const txn = {
    kind: 'calls' as const,
    calls: [
      {
        to: selectedToken.address,
        value: BigInt(0),
        data: ERC20.encodeFunctionData('transfer', [recipientAddress, bigNumberHexAmount])
      }
    ]
  }

  if (Number(selectedToken.address) === 0) {
    txn.calls = [
      {
        to: recipientAddress,
        value: BigInt(bigNumberHexAmount),
        data: '0x'
      }
    ]
  }

  return {
    id: new Date().getTime(),
    action: txn,
    session: new Session({ windowId }),
    meta: {
      isSignAction: true,
      chainId: selectedToken.chainId,
      accountAddr: selectedAccount,
      paymasterService
    }
  }
}

interface PrepareIntentUserRequestParams {
  selectedToken: TokenResult
  selectedAccount: string
  recipientAddress: string
  paymasterService?: PaymasterService
  transactions: {
    from: string
    to: string
    value?: string
    data: string
  }[]
  windowId?: number
}
function prepareIntentUserRequest({
  selectedToken,
  selectedAccount,
  recipientAddress,
  paymasterService,
  transactions,
  windowId
}: PrepareIntentUserRequestParams): SignUserRequest[] {
  if (!selectedToken || !selectedAccount || !recipientAddress) return []

  const id = uuidv4()
  // const txn = {
  //   kind: 'calls' as const,
  //   calls: [
  //     {
  //       fromUserRequestId: id,
  //       id: `${id}-0`,
  //       to: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  //       value: BigInt(0),
  //       data: '0x095ea7b300000000000000000000000073f70aabdad84cc5d6f58c85e655eaf1edeb918400000000000000000000000000000000000000000000000000000000005b8d80'
  //     }
  //   ]
  // }
  // const id2 = uuidv4()
  // const txn2 = {
  //   kind: 'calls' as const,
  //   calls: [
  //     {
  //       fromUserRequestId: id2,
  //       id: `${id2}-0`,
  //       to: '0x73f70aABDAD84cC5d6F58c85E655EAF1eDeB9184',
  //       value: BigInt(0),
  //       data: '0xe917a962000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000682510949df4b782e7bbc178b3b93bfe8aafb909e84e39484d7f3c59f400f1b4691f85e20000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000200000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c723800000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e00000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000014a34000000000000000000000000389cf18484e8b0338e94c5c6df3dbc2e229dade800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000000'
  //     }
  //   ]
  // }

  const txn = {
    kind: 'calls' as const,
    calls: transactions.map((transaction, index) => ({
      fromUserRequestId: id,
      id: `${id}-${index}`,
      to: transaction.to,
      value: BigInt(transaction.value || '0'),
      data: transaction.data
    }))
  }

  // return [
  //   {
  //     id,
  //     action: txn,
  //     meta: {
  //       isSignAction: true,
  //       chainId: selectedToken.chainId,
  //       accountAddr: selectedAccount,
  //       paymasterService,
  //       isSwapAndBridgeCall: true,
  //       activeRouteId: id
  //     }
  //   },
  //   {
  //     id: id2,
  //     action: txn2,
  //     meta: {
  //       isSignAction: true,
  //       chainId: selectedToken.chainId,
  //       accountAddr: selectedAccount,
  //       paymasterService,
  //       isSwapAndBridgeCall: true,
  //       activeRouteId: id2
  //     }
  //   }
  // ]

  return [
    {
      id,
      action: txn,
      session: new Session({ windowId }),
      meta: {
        isSignAction: true,
        chainId: selectedToken.chainId,
        accountAddr: selectedAccount,
        paymasterService,
        isSwapAndBridgeCall: true,
        activeRouteId: id
      }
    }
  ]
}

const isPlainTextMessage = (
  messageContent: SignUserRequest['action']
): messageContent is PlainTextMessage => {
  return messageContent.kind === 'message'
}

export {
  buildClaimWalletRequest,
  buildMintVestingRequest,
  buildTransferUserRequest,
  prepareIntentUserRequest,
  isPlainTextMessage
}
