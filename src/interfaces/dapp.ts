import { Session } from '../classes/session'

export interface Dapp {
  id: string
  name: string
  description: string
  url: string
  icon: string | null
  isConnected: boolean
  chainId: number
  favorite: boolean
  // Associated dapp account address
  account?: string
  blacklisted?: boolean
  grantedPermissionId?: string
  grantedPermissionAt?: number
}

export interface DappProviderRequest {
  method: string
  params?: any
  session: Session
  origin: string
  meta?: { [key: string]: any }
}
