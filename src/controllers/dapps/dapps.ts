import { getSessionId, Session, SessionInitProps, SessionProp } from '../../classes/session'
import predefinedDapps from '../../consts/dappCatalog.json'
import { Dapp } from '../../interfaces/dapp'
import { Messenger } from '../../interfaces/messenger'
import { getDappIdFromUrl, patchStorageApps } from '../../libs/dapps/helpers'
import EventEmitter from '../eventEmitter/eventEmitter'
import { StorageController } from '../storage/storage'

// The DappsController is responsible for the following tasks:
// 1. Managing the dApp catalog
// 2. Handling active sessions between dApps and the wallet
// 3. Broadcasting events from the wallet to connected dApps via the Session

// The possible events include: accountsChanged, chainChanged, disconnect, lock, unlock, and connect.

export class DappsController extends EventEmitter {
  #dapps: Dapp[] = []

  #storage: StorageController

  dappSessions: { [sessionId: string]: Session } = {}

  // Holds the initial load promise, so that one can wait until it completes
  initialLoadPromise: Promise<void>

  constructor(storage: StorageController) {
    super()

    this.#storage = storage

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.initialLoadPromise = this.#load()
  }

  get isReady() {
    return !!this.dapps
  }

  get dapps(): Dapp[] {
    const combined = [...this.#dapps, ...predefinedDapps]

    return combined.reduce((acc: Dapp[], curr): Dapp[] => {
      const id = 'id' in curr ? curr.id : getDappIdFromUrl(curr.url)

      if (!acc.some((dapp) => dapp.id === id)) {
        acc.push({
          id,
          name: curr.name,
          description: curr.description,
          url: curr.url,
          icon: curr.icon,
          isConnected: 'isConnected' in curr ? curr.isConnected : false,
          chainId: 'chainId' in curr ? curr.chainId : 1,
          favorite: 'favorite' in curr ? curr.favorite : false,
          account: 'account' in curr ? curr.account : undefined
        })
      }

      return acc
    }, [])
  }

  set dapps(updatedDapps: Dapp[]) {
    this.#dapps = updatedDapps
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.#storage.set('dapps', updatedDapps)
  }

  async #load() {
    // Before extension version 4.55.0, dappSessions were stored in storage.
    // This logic is no longer needed, so we remove the data from the user's storage.
    // Keeping this here as a reminder to handle future use of the `dappSessions` key with caution.
    this.#storage.remove('dappSessions')
    const storedDapps = await this.#storage.get('dapps', [])

    this.#dapps = patchStorageApps(storedDapps)
    this.emitUpdate()
  }

  #createDappSession = (initProps: SessionInitProps) => {
    const dappSession = new Session(initProps)
    this.dappSessions[dappSession.sessionId] = dappSession

    this.emitUpdate()

    return dappSession
  }

  getOrCreateDappSession = (initProps: SessionInitProps) => {
    if (!initProps.tabId || !initProps.origin)
      throw new Error('Invalid props passed to getOrCreateDappSession')

    const sessionId = getSessionId(initProps)
    if (this.dappSessions[sessionId]) return this.dappSessions[sessionId]

    return this.#createDappSession(initProps)
  }

  setSessionMessenger = (sessionId: string, messenger: Messenger) => {
    this.dappSessions[sessionId].setMessenger(messenger)
  }

  setSessionLastHandledRequestsId = (sessionId: string, id: number, isWeb3AppRequest?: boolean) => {
    if (id > this.dappSessions[sessionId].lastHandledRequestId) {
      this.dappSessions[sessionId].lastHandledRequestId = id
      if (isWeb3AppRequest && !this.dappSessions[sessionId].isWeb3App) {
        this.dappSessions[sessionId].isWeb3App = true
        this.emitUpdate()
      }
    }
  }

  resetSessionLastHandledRequestsId = (sessionId: string) => {
    this.dappSessions[sessionId].lastHandledRequestId = -1
  }

  setSessionProp = (sessionId: string, props: SessionProp) => {
    this.dappSessions[sessionId].setProp(props)
  }

  deleteDappSession = (sessionId: string) => {
    delete this.dappSessions[sessionId]

    this.emitUpdate()
  }

  broadcastDappSessionEvent = async (
    ev: any,
    data?: any,
    id?: string,
    skipPermissionCheck?: boolean
  ) => {
    await this.initialLoadPromise

    let dappSessions: { sessionId: string; data: Session }[] = []
    Object.keys(this.dappSessions).forEach((sessionId) => {
      const hasPermissionToBroadcast =
        skipPermissionCheck || this.hasPermission(this.dappSessions[sessionId].id)
      if (this.dappSessions[sessionId] && hasPermissionToBroadcast) {
        dappSessions.push({ sessionId, data: this.dappSessions[sessionId] })
      }
    })
    if (id) {
      dappSessions = dappSessions.filter((dappSession) => dappSession.data.id === id)
    }

    dappSessions.forEach((dappSession) => {
      try {
        dappSession.data.sendMessage?.(ev, data)
      } catch (e) {
        if (this.dappSessions[dappSession.sessionId]) {
          this.deleteDappSession(dappSession.sessionId)
        }
      }
    })
  }

  addDapp(dapp: Dapp) {
    if (!this.isReady) return

    const doesAlreadyExist = this.dapps.find((d) => d.id === dapp.id)

    if (doesAlreadyExist) {
      this.updateDapp(dapp.id, {
        chainId: dapp.chainId,
        isConnected: dapp.isConnected,
        favorite: dapp.favorite,
        grantedPermissionId: dapp.grantedPermissionId,
        grantedPermissionAt: dapp.grantedPermissionAt,
        account: dapp.account
      })
      return
    }
    this.dapps = [...this.dapps, dapp]
    this.emitUpdate()
  }

  updateDapp(id: string, dapp: Partial<Dapp>) {
    if (!this.isReady) return

    this.dapps = this.dapps.map((d) => {
      if (d.id === id) return { ...d, ...dapp }
      return d
    })
    this.emitUpdate()
  }

  removeDapp(id: string) {
    if (!this.isReady) return

    const dapp = this.dapps.find((d) => d.id === id)

    if (!dapp) return

    // do not remove predefined dapps
    if (predefinedDapps.find((d) => getDappIdFromUrl(d.url) === dapp.id)) return
    this.dapps = this.dapps.filter((d) => d.id !== id)

    this.emitUpdate()
  }

  hasPermission(id: string) {
    if (!id) return false

    const dapp = this.dapps.find((d) => d.id === id)
    if (!dapp) return false

    return dapp.isConnected
  }

  getDapp(id: string) {
    if (!this.isReady) return

    return this.dapps.find((d) => d.id === id)
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      dapps: this.dapps,
      isReady: this.isReady
    }
  }
}
