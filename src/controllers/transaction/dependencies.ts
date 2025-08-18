import { ExternalSignerControllers } from '../../interfaces/keystore'
import { LiFiAPI } from '../../services/lifi/api'
import { SocketAPI } from '../../services/socket/api'
import { AccountsController } from '../accounts/accounts'
import { ActivityController } from '../activity/activity'
import { InviteController } from '../invite/invite'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { PortfolioController } from '../portfolio/portfolio'
import { ProvidersController } from '../providers/providers'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { StorageController } from '../storage/storage'

export type TransactionDependencies = {
  accounts: AccountsController
  keystore: KeystoreController
  portfolio: PortfolioController
  externalSignerControllers: ExternalSignerControllers
  providers: ProvidersController
  selectedAccount: SelectedAccountController
  networks: NetworksController
  activity: ActivityController
  serviceProviderAPI: SocketAPI | LiFiAPI
  storage: StorageController
  invite: InviteController
  portfolioUpdate?: Function
}

export type ControllersTransactionDependencies = TransactionDependencies & {
  interopSDK: any
}
