import { AddressState, AddressStateOptional } from './domains'

export type ExtendedAddressState = AddressState & {
  interopAddress: string
}

export type ExtendedAddressStateOptional = AddressStateOptional & {
  interopAddress?: string
}
