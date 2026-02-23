import { HumanizerInfoType } from '../../../v1/hooks/useConstants'
import { FEE_COLLECTOR } from '../../consts/addresses'

const isValidAddress = (address: string) => /^0x[a-fA-F0-9]{40}$/.test(address)

// Check if address is a valid Railgun 0zk address
// Railgun addresses start with "0zk" followed by alphanumeric characters
const isValidRailgunAddress = (address: string) => {
  if (!address || typeof address !== 'string') return false
  // Railgun addresses start with "0zk" and are base58 encoded
  // Format: 0zk + base58 encoded address (exactly 127 characters)
  // Remove any whitespace before checking
  const trimmedAddress = address.trim()
  return /^0zk[a-zA-Z0-9]+$/.test(trimmedAddress) && trimmedAddress.length === 127
}

const isHumanizerKnownTokenOrSmartContract = (
  humanizerInfo: HumanizerInfoType,
  _address: string
) => {
  const address = _address.toLowerCase() // humanizer keys (addresses) are lowercase

  // In order to humanize the fee collector as "Gas Tank", it is included in the
  // "names" in the humanizer (all others are smart contract addresses). But the
  // fee collector is not a smart contract (or token). It is an EOA.
  if (address === FEE_COLLECTOR.toLowerCase()) return false

  return (
    Object.keys(humanizerInfo.tokens).includes(address) || // token addresses
    Object.keys(humanizerInfo.names).includes(address) // smart contract addresses
  )
}

export { isValidAddress, isValidRailgunAddress, isHumanizerKnownTokenOrSmartContract }
