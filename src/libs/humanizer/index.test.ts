/* eslint-disable no-console */
import { ethers } from 'ethers'

import { describe, test } from '@jest/globals'

import AmbireAccount from '../../../contracts/compiled/AmbireAccount.json'
import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import { Account } from '../../interfaces/account'
import { Key } from '../../interfaces/keystore'
import { TypedMessage } from '../../interfaces/userRequest'
import { AccountOp } from '../accountOp/accountOp'
import { humanizeAccountOp, humanizeMessage } from './index'
import { IrCall } from './interfaces'
import { compareHumanizerVisualizations, compareVisualizations } from './testHelpers'
import { getAction, getAddressVisualization, getDeadline, getLabel, getToken } from './utils'

// const address1 = '0x6942069420694206942069420694206942069420'
const address2 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const WETH_ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

const accountOp: AccountOp = {
  accountAddr: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
  chainId: 1n,
  // this may not be defined, in case the user has not picked a key yet
  signingKeyAddr: null,
  signingKeyType: null,
  // signingKeyType: 'internal',
  // this may not be set in case we haven't set it yet
  nonce: null,
  calls: [],
  gasLimit: null,
  signature: null,
  gasFeePayment: null,
  // This is used when we have an account recovery to finalize before executing the AccountOp,
  // And we set this to the recovery finalization AccountOp; could be used in other scenarios too in the future,
  // for example account migration (from v1 QuickAcc to v2)
  accountOpToExecuteBefore: null
  // This is fed into the humanizer to help visualize the accountOp
  // This can contain info like the value of specific share tokens at the time of signing,
  // or any other data that needs to otherwise be retrieved in an async manner and/or needs to be
  // "remembered" at the time of signing in order to visualize history properly
  // humanizerMeta: {}
}

const accounts: Account[] = [
  {
    addr: '0xAAbBbC841F29Dc6b09EF9f6c8fd59DA807bc6248',
    associatedKeys: ['string[]'],
    initialPrivileges: [],
    creation: null,
    preferences: {
      label: DEFAULT_ACCOUNT_LABEL,
      pfp: '0xAAbBbC841F29Dc6b09EF9f6c8fd59DA807bc6248'
    }
  }
]
const keys: Key[] = [
  {
    addr: '0xABcdeF398CBb1285Eeb2DC42be2c429eB1d55f02',
    type: 'internal',
    label: 'Key 1',
    dedicatedToOneSA: true,
    isExternallyStored: true,
    meta: {
      createdAt: new Date().getTime()
    }
  }
]
const transactions = {
  generic: [
    // simple transafer
    { to: '0xc4ce03b36f057591b2a360d773edb9896255051e', value: BigInt(10 ** 18), data: '0x' },
    // simple contract call (WETH approve)
    {
      to: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      value: BigInt(0),
      data: '0x095ea7b3000000000000000000000000e5c783ee536cf5e63e792988335c4255169be4e1ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    }
  ],
  // currently with USDT
  erc20: [
    // approve erc-20 token USDT
    {
      to: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      value: BigInt(0),
      data: '0x095ea7b300000000000000000000000046705dfff24256421a05d056c29e81bdc09723b8000000000000000000000000000000000000000000000000000000003b9aca00'
    },
    // revoke approval  erc-20 token USDT
    {
      to: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      value: BigInt(0),
      data: '0x095ea7b300000000000000000000000046705dfff24256421a05d056c29e81bdc09723b8000000000000000000000000000000000000000000000000000000003b9aca00'
    },
    // transferFrom A to me  erc-20 token USDT
    {
      to: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      value: BigInt(0),
      data: `0x23b872dd00000000000000000000000046705dfff24256421a05d056c29e81bdc09723b8000000000000000000000000${accountOp.accountAddr.substring(
        2
      )}000000000000000000000000000000000000000000000000000000003b9aca00`
    },
    // transferFrom A to B (bad example - B is USDT) erc-20 token USDT
    {
      to: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      value: BigInt(0),
      data: '0x23b872dd00000000000000000000000046705dfff24256421a05d056c29e81bdc09723b8000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7000000000000000000000000000000000000000000000000000000003b9aca00'
    },
    // transferFrom me to A  erc-20 token USDT (bad example, in such case transfer will be used)
    {
      to: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      value: BigInt(0),
      data: `0x23b872dd000000000000000000000000${accountOp.accountAddr.substring(
        2
      )}00000000000000000000000046705dfff24256421a05d056c29e81bdc09723b8000000000000000000000000000000000000000000000000000000003b9aca00`
    },
    // transfer erc-20 tokens USDT
    {
      to: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      value: BigInt(0),
      data: '0xa9059cbb00000000000000000000000046705dfff24256421a05d056c29e81bdc09723b8000000000000000000000000000000000000000000000000000000003b9aca00'
    }
  ],
  erc721: [
    // grant approval nft 1
    {
      to: '0x59468516a8259058bad1ca5f8f4bff190d30e066',
      value: BigInt(0),
      data: '0x095ea7b300000000000000000000000046705dfff24256421a05d056c29e81bdc09723b80000000000000000000000000000000000000000000000000000000000000001'
    },
    // revoke approval nft 1
    {
      to: '0x59468516a8259058bad1ca5f8f4bff190d30e066',
      value: BigInt(0),
      data: `0x095ea7b3000000000000000000000000${ethers.ZeroAddress.substring(
        2
      )}0000000000000000000000000000000000000000000000000000000000000001`
    },
    // approve all
    {
      to: '0x59468516a8259058bad1ca5f8f4bff190d30e066',
      value: BigInt(0),
      data: '0xa22cb46500000000000000000000000046705dfff24256421a05d056c29e81bdc09723b80000000000000000000000000000000000000000000000000000000000000001'
    },
    // revoke all approvals
    {
      to: '0x59468516a8259058bad1ca5f8f4bff190d30e066',
      value: BigInt(0),
      data: '0xa22cb46500000000000000000000000046705dfff24256421a05d056c29e81bdc09723b80000000000000000000000000000000000000000000000000000000000000000'
    },
    // transfer from me to A
    {
      to: '0x59468516a8259058bad1ca5f8f4bff190d30e066',
      value: BigInt(0),
      data: '0x23b872dd000000000000000000000000B674F3fd5F43464dB0448a57529eAF37F04cceA500000000000000000000000046705dfff24256421a05d056c29e81bdc09723b80000000000000000000000000000000000000000000000000000000000000000'
    },
    // transfer from B to A
    {
      to: '0x59468516a8259058bad1ca5f8f4bff190d30e066',
      value: BigInt(0),
      data: '0x23b872dd000000000000000000000000C89B38119C58536d818f3Bf19a9E3870828C199400000000000000000000000046705dfff24256421a05d056c29e81bdc09723b80000000000000000000000000000000000000000000000000000000000000000'
    },
    // safe transfer from A to B
    {
      to: '0x59468516a8259058bad1ca5f8f4bff190d30e066',
      value: BigInt(0),
      data: '0x42842e0e000000000000000000000000C89B38119C58536d818f3Bf19a9E3870828C199400000000000000000000000046705dfff24256421a05d056c29e81bdc09723b80000000000000000000000000000000000000000000000000000000000000000'
    }
  ],
  toKnownAddresses: [
    // ETH to uniswap (bad example, sending eth to contract)
    {
      to: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
      value: BigInt(10 * 18),
      data: '0x'
    },
    // USDT to uniswap (bad example, sending erc-20 to contract)
    {
      to: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      value: BigInt(0),
      data: '0xa9059cbb000000000000000000000000B674F3fd5F43464dB0448a57529eAF37F04cceA5000000000000000000000000000000000000000000000000000000003b9aca00'
    }
  ],
  uniV3: [
    // Swap exact WALLET for at least x  USDC
    {
      to: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
      value: BigInt(0),
      data: '0x5ae401dc0000000000000000000000000000000000000000000000000000000064c236530000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000124b858183f00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000080000000000000000000000000b674f3fd5f43464db0448a57529eaf37f04ccea500000000000000000000000000000000000000000000003635c9adc5dea000000000000000000000000000000000000000000000000000000000000000835074000000000000000000000000000000000000000000000000000000000000004288800092ff476844f74dc2fc427974bbee2794ae002710c02aaa39b223fe8d0a0e5c4f27ead9083c756cc20001f4a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
    },
    // Swap up to x Adex to exact DAI
    {
      to: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
      value: BigInt(0),
      data: '0x5ae401dc0000000000000000000000000000000000000000000000000000000064c233bf000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000012409b8134600000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000080000000000000000000000000b674f3fd5f43464db0448a57529eaf37f04ccea50000000000000000000000000000000000000000000000056bc75e2d63100000000000000000000000000000000000000000000000000025faff1f58be30f6ec00000000000000000000000000000000000000000000000000000000000000426b175474e89094c44da98b954eedeac495271d0f000064dac17f958d2ee523a2206206994597c13d831ec7000bb8ade00c28244d5ce17d72e40330b1c318cd12b7c300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
    }
  ],
  unknownFuncSelector: [
    {
      to: '0x519856887af544de7e67f51a4f2271521b01432b',
      value: BigInt(0),
      data: '0xd96a094a0000000000000000000000000000000000000000000000000000000064c233bf'
    }
  ],

  accountOrKeyArg: [
    // approve erc-20 token USDT
    {
      to: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      value: BigInt(0),
      data: '0x095ea7b3000000000000000000000000aabbbC841f29Dc6B09eF9F6c8fD59da807Bc6248000000000000000000000000000000000000000000000000000000003b9aca00'
    },
    {
      to: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      value: BigInt(0),
      data: '0x095ea7b3000000000000000000000000ABcdeF398CBb1285Eeb2DC42be2c429eB1d55f02000000000000000000000000000000000000000000000000000000003b9aca00'
    }
  ]
}

describe('Humanizer main function', () => {
  beforeEach(async () => {
    accountOp.calls = []
  })

  test('generic humanize', async () => {
    // const ir: Ir = []
    const expectedVisualizations = [
      [
        getAction('Send'),
        getToken('0x0000000000000000000000000000000000000000', 1000000000000000000n),
        getLabel('to'),
        getAddressVisualization('0xc4ce03b36f057591b2a360d773edb9896255051e'),
        getToken('0xc4ce03b36f057591b2a360d773edb9896255051e', 0n, true)
      ],
      [
        getAction('Grant approval'),
        getLabel('for'),
        getToken(
          '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          115792089237316195423570985008687907853269984665640564039457584007913129639935n
        ),
        getLabel('to'),
        getAddressVisualization('0xe5c783ee536cf5e63e792988335c4255169be4e1'),
        getToken('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 0n, true)
      ]
    ]

    accountOp.calls = [...transactions.generic]
    const irCalls = humanizeAccountOp(accountOp, {})
    compareHumanizerVisualizations(irCalls, expectedVisualizations)
  })
})

describe('TypedMessages', () => {
  test('simple humanization', async () => {
    const message = {
      details: [
        {
          token: WETH_ADDRESS,
          amount: ethers.parseEther('1'),
          expiration: 968187600n,
          nonce: 1n
        },
        {
          token: WETH_ADDRESS,
          amount: ethers.parseEther('0.5'),
          expiration: 969187600n,
          nonce: 2n
        }
      ],
      spender: address2,
      sigDeadline: 968187600n
    }
    const tmTemplate: TypedMessage = {
      kind: 'typedMessage',
      domain: {
        name: 'random contract',
        version: '1',
        chainId: 1n,
        verifyingContract: '0x000000000022d473030f116ddee9f6b43ac78ba3',
        salt: '1'
      },
      types: { PermitBatch: [{ name: 'details', type: 'PermitDetails[]' }] },
      message,
      primaryType: 'Permit'
    }
    const fullMessage = {
      fromActionId: 1,
      accountAddr: accountOp.accountAddr,
      content: tmTemplate,
      signature: null,
      chainId: 1n
    }

    const expectedVisualizations = [
      getAction('Approve'),
      getAddressVisualization(address2),
      getLabel('to use'),
      getToken('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 1000000000000000000n),
      getLabel('and'),
      getAddressVisualization(address2),
      getLabel('to use'),
      getToken('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 500000000000000000n),
      getDeadline(968187600n)
    ]

    const irMessage = humanizeMessage(fullMessage)
    compareVisualizations(irMessage.fullVisualization || [], expectedVisualizations)
  })
})

describe('with (Account | Key)[] arg', () => {
  beforeEach(async () => {
    accountOp.calls = []
  })
  test('with calls', async () => {
    const expectedVisualizations = [
      [
        getAction('Grant approval'),
        getLabel('for'),
        getToken('0xdac17f958d2ee523a2206206994597c13d831ec7', 1000000000n),
        getLabel('to'),
        getAddressVisualization(accounts[0].addr.toLowerCase()),
        getToken('0xdac17f958d2ee523a2206206994597c13d831ec7', 0n, true)
      ],
      [
        getAction('Grant approval'),
        getLabel('for'),
        getToken('0xdac17f958d2ee523a2206206994597c13d831ec7', 1000000000n),
        getLabel('to'),
        getAddressVisualization(keys[0].addr.toLowerCase()),
        getToken('0xdac17f958d2ee523a2206206994597c13d831ec7', 0n, true)
      ]
    ]
    accountOp.calls = [...transactions.accountOrKeyArg]

    const irCalls = humanizeAccountOp(accountOp, {})
    compareHumanizerVisualizations(irCalls, expectedVisualizations)
  })
})

describe('the recovery kit grant', () => {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder()
  const ambireAccount = new ethers.Interface(AmbireAccount.abi)
  const manager = '0x1111111111111111111111111111111111111111'
  const auditedAction = '0x2222222222222222222222222222222222222222'
  const stranger = '0x6969174FD72466430a46e18234D0b530c9FD5f49'
  const kitSlot = ethers.getAddress(
    `0x${ethers
      .keccak256(abiCoder.encode(['string', 'address'], ['kit', auditedAction]))
      .slice(-40)}`
  )
  const kitValue = ethers.keccak256(abiCoder.encode(['address', 'string'], [auditedAction, '']))
  const kitRequestId = 1
  const grant = (addr: string, priv: string, fromUserRequestId = kitRequestId) => ({
    to: accountOp.accountAddr,
    value: 0n,
    data: ambireAccount.encodeFunctionData('setAddrPrivilege', [addr, priv]),
    fromUserRequestId
  })
  const commitSetup = {
    to: manager,
    value: 0n,
    data: new ethers.Interface([
      'function commitSetup(address, bytes32, uint64, bytes, bytes)'
    ]).encodeFunctionData('commitSetup', [auditedAction, ethers.ZeroHash, 1, '0x', '0x']),
    fromUserRequestId: kitRequestId
  }
  const unrelatedCall = transactions.generic[1]
  const humanize = (calls: AccountOp['calls']): IrCall[] =>
    humanizeAccountOp(
      {
        ...accountOp,
        calls,
        meta: {
          recoveryKit: { manager, auditedActions: [auditedAction], fromUserRequestId: kitRequestId }
        }
      },
      {}
    )

  test('is shown as its own action with no warning', () => {
    const [, kitGrant] = humanize([commitSetup, grant(kitSlot, kitValue)])

    compareHumanizerVisualizations(
      [kitGrant],
      [
        [
          getAction('Enable recovery module'),
          getAddressVisualization(auditedAction),
          getToken(accountOp.accountAddr, 0n, true)
        ]
      ]
    )
    expect(kitGrant.fullVisualization).not.toContainEqual(
      expect.objectContaining({ warning: true })
    )
    expect(kitGrant.warnings ?? []).toEqual([])
  })

  test('the same grant and commitSetup from another request keep the danger warning', () => {
    const [, , otherGrant] = humanize([
      { ...unrelatedCall, fromUserRequestId: kitRequestId },
      { ...commitSetup, fromUserRequestId: 2 },
      grant(kitSlot, kitValue, 2)
    ])

    expect(otherGrant.fullVisualization?.[0]).toMatchObject({
      content: 'Update access status',
      warning: true
    })
    expect(otherGrant.warnings).toContainEqual(expect.objectContaining({ level: 'danger' }))
  })

  test('a grant to an address outside the audited list keeps the warning', () => {
    const [, strangerGrant] = humanize([
      commitSetup,
      grant(stranger, ethers.zeroPadValue('0x01', 32))
    ])

    expect(strangerGrant.fullVisualization?.[0]).toMatchObject({
      type: 'action',
      content: 'Update access status',
      warning: true
    })
    expect(strangerGrant.warnings).toEqual([
      {
        content: `This transaction grants control of this account to ${stranger}!`,
        level: 'danger'
      }
    ])
  })

  test('leaves the warnings of an unrelated call unchanged', () => {
    const [, , unrelatedInBatch] = humanize([commitSetup, grant(kitSlot, kitValue), unrelatedCall])
    const [unrelatedAlone] = humanizeAccountOp({ ...accountOp, calls: [unrelatedCall] }, {})

    expect(unrelatedInBatch.warnings).toEqual(unrelatedAlone.warnings)
    compareHumanizerVisualizations([unrelatedInBatch], [unrelatedAlone.fullVisualization!])
  })
})
