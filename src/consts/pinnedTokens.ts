import { PinnedTokens } from '../libs/portfolio/interfaces'

// Rules:
// 1. Pinned gas tank tokens with the same address are shared between networks. This means
// that if ETH is pinned on Ethereum and onGasTank is true, the same token shouldn't be
// onGasTank on Optimism.
// 2. Addresses must be checksummed.
export const PINNED_TOKENS: PinnedTokens = [
  // $ETH
  {
    chainId: 1n,
    address: '0x0000000000000000000000000000000000000000',
    onGasTank: true
  },
  {
    chainId: 10n,
    address: '0x0000000000000000000000000000000000000000',
    onGasTank: false
  },
  // $WALLET
  {
    chainId: 1n,
    address: '0x88800092fF476844f74dC2FC427974BBee2794Ae',
    onGasTank: false
  },
  // $USDC
  {
    chainId: 1n,
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    onGasTank: true
  },
  {
    chainId: 10n,
    address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    onGasTank: true
  },
  {
    chainId: 11155111n,
    address: '0x0000000000000000000000000000000000000000',
    onGasTank: false
  },
  {
    chainId: 11155111n,
    address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    onGasTank: false
  },
  {
    chainId: 421614n,
    address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    onGasTank: false
  }
]
