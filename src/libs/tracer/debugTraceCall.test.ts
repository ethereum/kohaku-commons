import { Interface, MaxUint256, solidityPackedKeccak256, toBeHex } from 'ethers'

import { beforeAll, expect } from '@jest/globals'

import { Account, AccountOnchainState } from '../../interfaces/account'
import { getRpcProvider } from '../../services/provider'
import { AccountOp } from '../accountOp/accountOp'
import { BROADCAST_OPTIONS } from '../broadcast/broadcast'
import { ERC20, ERC721 } from '../humanizer/const/abis'
import { debugTraceCall } from './debugTraceCall'

const NFT_ADDRESS = '0x3Bd57Bf93dE179d2e47e86319F144d7482503C7d'
const USDT_ADDRESS_OPTIMISM = '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'
const USDC_ADDRESS_OPTIMISM = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
const ACCOUNT_ADDRESS = '0x46C0C59591EbbD9b7994d10efF172bFB9325E240'

// @TODO add minting and burning test
describe('Debug tracecall detection for transactions', () => {
  const provider = getRpcProvider({
    rpcUrls: ['https://invictus.ambire.com/optimism'],
    chainId: 10n
  })
  let account: Account
  let accountOp: AccountOp
  const nftIface: Interface = new Interface(ERC721)
  const tokenIface: Interface = new Interface(ERC20)
  let state: AccountOnchainState
  beforeAll(async () => {
    account = {
      addr: ACCOUNT_ADDRESS,
      initialPrivileges: [
        [
          '0x02be1F941b6B777D4c30f110E997704fFc26B379',
          '0x0000000000000000000000000000000000000000000000000000000000000002'
        ]
      ],
      associatedKeys: ['0x02be1F941b6B777D4c30f110E997704fFc26B379'],
      creation: {
        factoryAddr: '0x26cE6745A633030A6faC5e64e41D21fb6246dc2d',
        bytecode:
          '0x7f00000000000000000000000000000000000000000000000000000000000000027fa27fd83f65c3d89187ef0fd4fe62738d42ec134f8b2d8bf78612bd1cad581bb5553d602d80604d3d3981f3363d3d373d3d3d363d730f2aa7bcda3d9d210df69a394b6965cb2566c8285af43d82803e903d91602b57fd5bf3',
        salt: '0x0000000000000000000000000000000000000000000000000000000000000000'
      },
      preferences: { label: 'TEST SMART', pfp: ACCOUNT_ADDRESS },
      // usedOnNetworks: [],
      newlyCreated: false,
      newlyAdded: false
    }
    accountOp = {
      accountAddr: ACCOUNT_ADDRESS,
      chainId: 10n,
      signingKeyAddr: '"0x02be1F941b6B777D4c30f110E997704fFc26B379"',
      signingKeyType: 'internal',
      gasLimit: null,
      gasFeePayment: {
        paidBy: '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8',
        broadcastOption: BROADCAST_OPTIONS.byRelayer,
        isGasTank: false,
        inToken: '0x0000000000000000000000000000000000000000',
        amount: 5205038755874012n,
        simulatedGasLimit: 139864n,
        gasPrice: 33831818155n
      },
      nonce: 1n,
      signature: '0x000000000000000000000000db26aeea3b986887feaba661df6d211e725797a003',
      accountOpToExecuteBefore: null,
      calls: [
        {
          to: '0xb7330c592dc5feafda855867b1e172be3a8d4abf',
          value: 0n,
          data: '0x23b872dd000000000000000000000000d034ddc997283b8179a12fe8d36a7356f01f2ddd00000000000000000000000073573bacb097a65786ebd7968e5775cbb89c73570000000000000000000000000000000000000000000000000000000000000003',
          fromUserRequestId: 1723530835106
        }
      ]
    }
    state = {
      accountAddr: ACCOUNT_ADDRESS,
      nonce: 1n,
      eoaNonce: 1n,
      erc4337Nonce: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
      isDeployed: true,
      isV2: true,
      associatedKeys: {
        '0xe5a4Dad2Ea987215460379Ab285DF87136E83BEA': toBeHex(1, 32)
      },
      isSmarterEoa: false,
      balance: 989858878709479465n,
      isEOA: false,
      isErc4337Enabled: false,
      currentBlock: 60529438n,
      deployError: false,
      isErc4337Nonce: false,
      delegatedContract: null,
      delegatedContractName: null
    }
  })

  it('Detects nfts and tokens in and out', async () => {
    accountOp.calls = [
      {
        to: NFT_ADDRESS,
        value: 0n,
        data: nftIface.encodeFunctionData(
          'transferFrom(address from, address to, uint256 tokenId)',
          [account.addr, '0xC2E6dFcc2C6722866aD65F211D5757e1D2879337', 25n]
        )
      },
      {
        to: NFT_ADDRESS,
        value: 0n,
        data: nftIface.encodeFunctionData(
          'transferFrom(address from, address to, uint256 tokenId)',
          ['0x6969174FD72466430a46e18234D0b530c9FD5f49', account.addr, 0n]
        )
      },
      // usdc transfer
      {
        to: USDC_ADDRESS_OPTIMISM,
        value: 0n,
        data: tokenIface.encodeFunctionData('transfer', [
          '0xC2E6dFcc2C6722866aD65F211D5757e1D2879337',
          2000n
        ])
      },
      // usdt pull
      {
        to: USDT_ADDRESS_OPTIMISM,
        value: 0n,
        data: tokenIface.encodeFunctionData(
          'transferFrom(address from, address to, uint256 tokenId)',
          ['0x6969174FD72466430a46e18234D0b530c9FD5f49', account.addr, 100000n]
        )
      }
    ]

    const approvalStorageSlotUSDC = solidityPackedKeccak256(
      ['uint256', 'uint256'],
      [
        ACCOUNT_ADDRESS,
        solidityPackedKeccak256(
          ['uint256', 'uint256'],
          ['0x6969174FD72466430a46e18234D0b530c9FD5f49', 10000000000]
        )
      ]
    )
    const overrideData = {
      [USDT_ADDRESS_OPTIMISM]: {
        stateDiff: {
          [approvalStorageSlotUSDC]: `0x${MaxUint256.toString(16)}`
        }
      }
    }

    const res = await debugTraceCall(account, accountOp, provider, state, true, overrideData)

    expect(res.nfts.length).toBe(1)
    expect(res.nfts[0][0]).toBe(NFT_ADDRESS)
    expect(res.nfts[0][1]).toContain(25n)
    expect(res.tokens.length).toBe(2)
    expect(res.tokens).toContain(USDC_ADDRESS_OPTIMISM)
    expect(res.tokens).toContain(USDT_ADDRESS_OPTIMISM)
  })
})
