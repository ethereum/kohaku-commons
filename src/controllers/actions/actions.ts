import EmittableError from '../../classes/EmittableError'
import { Account } from '../../interfaces/account'
import {
  AccountOpAction,
  Action,
  BenzinAction,
  DappRequestAction,
  SignMessageAction,
  SwapAndBridgeAction,
  SwitchAccountAction
} from '../../interfaces/actions'
import { NotificationManager } from '../../interfaces/notification'
import { FocusWindowParams, WindowManager, WindowProps } from '../../interfaces/window'
// eslint-disable-next-line import/no-cycle
import { messageOnNewAction } from '../../libs/actions/actions'
import { getDappActionRequestsBanners } from '../../libs/banners/banners'
import EventEmitter from '../eventEmitter/eventEmitter'
// Kind of inevitable, the AccountsController has SelectedAccountController, which has ActionsController
// eslint-disable-next-line import/no-cycle
import { SelectedAccountController } from '../selectedAccount/selectedAccount'

// TODO: Temporarily. Refactor imports across the codebase to ref /interfaces/actions instead.
export type {
  AccountOpAction,
  Action,
  BenzinAction,
  DappRequestAction,
  SignMessageAction,
  SwitchAccountAction,
  SwapAndBridgeAction
}

export type ActionPosition = 'first' | 'last'

export type ActionExecutionType = 'queue' | 'queue-but-open-action-window' | 'open-action-window'

export type OpenActionWindowParams = {
  skipFocus?: boolean
  baseWindowId?: number
}

const SWAP_AND_BRIDGE_WINDOW_SIZE = {
  width: 640,
  height: 640
}
/**
 * The ActionsController is responsible for storing the converted userRequests
 * from the MainController into actions. After adding an action an action-window will be opened with the first action form actionsQueue
 * For most userRequests, there is a corresponding action in the actionsQueue
 * containing the details of the userRequest needed for displaying it to the user.
 * However, some userRequests can be batched together, resulting in a single action created for multiple requests.
 *
 * After being opened, the action-window will remain visible to the user until all actions are resolved or rejected,
 * or until the user forcefully closes the window using the system close icon (X).
 * All pending/unresolved actions can be accessed later from the banners on the Dashboard screen.
 */
export class ActionsController extends EventEmitter {
  #selectedAccount: SelectedAccountController

  #windowManager: WindowManager

  #notificationManager: NotificationManager

  actionWindow: {
    windowProps: WindowProps
    openWindowPromise?: Promise<WindowProps>
    focusWindowPromise?: Promise<WindowProps>
    closeWindowPromise?: Promise<void>
    loaded: boolean
    pendingMessage: {
      message: string
      options?: {
        timeout?: number
        type?: 'error' | 'success' | 'info' | 'warning'
        sticky?: boolean
      }
    } | null
  } = {
    windowProps: null,
    loaded: false,
    pendingMessage: null
  }

  actionsQueue: Action[] = []

  currentAction: Action | null = null

  #onActionWindowClose: () => Promise<void>

  get visibleActionsQueue(): Action[] {
    return this.actionsQueue.filter((a) => {
      if (a.type === 'accountOp') {
        return a.accountOp.accountAddr === this.#selectedAccount.account?.addr
      }
      if (a.type === 'signMessage') {
        return a.userRequest.meta.accountAddr === this.#selectedAccount.account?.addr
      }
      if (a.type === 'benzin') {
        return a.userRequest.meta.accountAddr === this.#selectedAccount.account?.addr
      }
      if (a.type === 'switchAccount') {
        return a.userRequest.meta.switchToAccountAddr !== this.#selectedAccount.account?.addr
      }
      if (a.type === 'swapAndBridge' || a.type === 'transfer') {
        return a.userRequest.meta.accountAddr === this.#selectedAccount.account?.addr
      }

      return true
    })
  }

  async #handleActionWindowClose(winId: number) {
    if (
      winId === this.actionWindow.windowProps?.id ||
      (!this.visibleActionsQueue.length && this.currentAction && this.actionWindow.windowProps)
    ) {
      this.actionWindow.windowProps = null
      this.actionWindow.loaded = false
      this.actionWindow.pendingMessage = null
      this.currentAction = null

      this.actionsQueue = this.actionsQueue.filter((a) => a.type === 'accountOp')
      if (this.visibleActionsQueue.length) {
        await this.#notificationManager.create({
          title:
            this.actionsQueue.length > 1
              ? `${this.actionsQueue.length} transactions queued`
              : 'Transaction queued',
          message: 'Queued pending transactions are available on your Dashboard.'
        })
      }
      await this.#onActionWindowClose()
      this.emitUpdate()
    }
  }

  constructor({
    selectedAccount,
    windowManager,
    notificationManager,
    onActionWindowClose
  }: {
    selectedAccount: SelectedAccountController
    windowManager: WindowManager
    notificationManager: NotificationManager
    onActionWindowClose: () => Promise<void>
  }) {
    super()

    this.#selectedAccount = selectedAccount
    this.#windowManager = windowManager
    this.#notificationManager = notificationManager
    this.#onActionWindowClose = onActionWindowClose

    this.#windowManager.event.on('windowRemoved', async (winId: number) => {
      // When windowManager.focus is called, it may close and reopen the action window as part of its fallback logic.
      // To avoid prematurely running the cleanup logic during that transition, we wait for focusWindowPromise to resolve.
      await this.actionWindow.focusWindowPromise

      await this.#handleActionWindowClose(winId)
    })

    this.#windowManager.event.on('windowFocusChange', async (winId: number) => {
      if (this.actionWindow.windowProps) {
        if (this.actionWindow.windowProps.id === winId && !this.actionWindow.windowProps.focused) {
          this.actionWindow.windowProps.focused = true
          this.emitUpdate()
        } else if (
          this.actionWindow.windowProps.id !== winId &&
          this.actionWindow.windowProps.focused
        ) {
          this.actionWindow.windowProps.focused = false
          this.emitUpdate()
        }
      }
    })
  }

  async addOrUpdateActions(
    newActions: Action[],
    {
      position = 'last',
      executionType = 'open-action-window',
      skipFocus = false,
      baseWindowId = undefined
    }: {
      position?: ActionPosition
      executionType?: ActionExecutionType
      skipFocus?: boolean
      baseWindowId?: number
    } = {}
  ) {
    // remove the benzin action if a new actions is added
    this.actionsQueue = this.actionsQueue.filter((a) => {
      if (a.type === 'benzin') return false

      if (a.type === 'switchAccount') {
        return a.userRequest.meta.switchToAccountAddr !== this.#selectedAccount.account?.addr
      }

      return true
    })
    if (this.currentAction && this.currentAction.type === 'benzin') {
      this.currentAction = null
    }

    newActions.forEach((newAction) => {
      const actionIndex = this.actionsQueue.findIndex((a) => a.id === newAction.id)

      if (actionIndex !== -1) {
        this.actionsQueue[actionIndex] = newAction
        if (executionType === 'open-action-window') {
          this.sendNewActionMessage(newAction, 'updated')
        } else if (executionType === 'queue-but-open-action-window') {
          this.sendNewActionMessage(newAction, 'queued')
        }
      } else if (position === 'first') {
        this.actionsQueue.unshift(newAction)
      } else {
        this.actionsQueue.push(newAction)
      }
    })

    const nextAction = newActions[0]

    if (executionType !== 'queue') {
      let currentAction = null
      if (executionType === 'open-action-window') {
        currentAction = this.visibleActionsQueue.find((a) => a.id === nextAction.id) || null
      } else if (executionType === 'queue-but-open-action-window') {
        this.sendNewActionMessage(nextAction, 'queued')
        currentAction = this.currentAction || this.visibleActionsQueue[0] || null
      }
      await this.#setCurrentAction(currentAction, {
        skipFocus,
        baseWindowId
      })
    } else {
      this.emitUpdate()
    }
  }

  async removeActions(actionIds: Action['id'][], shouldOpenNextAction: boolean = true) {
    this.actionsQueue = this.actionsQueue.filter((a) => !actionIds.includes(a.id))

    if (!this.visibleActionsQueue.length) {
      await this.#setCurrentAction(null)
    } else if (shouldOpenNextAction) {
      await this.#setCurrentAction(this.visibleActionsQueue[0], {
        skipFocus: true
      })
    }
  }

  async #awaitPendingPromises() {
    await this.actionWindow.closeWindowPromise
    await this.actionWindow.focusWindowPromise
    await this.actionWindow.openWindowPromise
  }

  async #setCurrentAction(nextAction: Action | null, params?: OpenActionWindowParams) {
    this.currentAction = nextAction
    this.emitUpdate()

    if (nextAction) {
      await this.openActionWindow(params)
      return
    }

    await this.closeActionWindow()
  }

  async setCurrentActionById(actionId: Action['id'], params?: OpenActionWindowParams) {
    const action = this.visibleActionsQueue.find((a) => a.id.toString() === actionId.toString())
    if (!action)
      throw new EmittableError({
        message:
          'Failed to open request window. If the issue persists, please reject the request and try again.',
        level: 'major',
        error: new Error(`Action not found. Id: ${actionId}`)
      })
    await this.#setCurrentAction(action, params)
  }

  async setCurrentActionByIndex(actionIndex: number, params?: OpenActionWindowParams) {
    const action = this.visibleActionsQueue[actionIndex]
    if (!action)
      throw new EmittableError({
        message:
          'Failed to open request window. If the issue persists, please reject the request and try again.',
        level: 'major',
        error: new Error(`Action not found. Index: ${actionIndex}`)
      })
    await this.#setCurrentAction(action, params)
  }

  sendNewActionMessage(newAction: Action, type: 'queued' | 'updated') {
    if (this.visibleActionsQueue.length > 1 && newAction.type !== 'benzin') {
      if (this.actionWindow.loaded) {
        const message = messageOnNewAction(newAction, type)
        if (message) this.#windowManager.sendWindowToastMessage(message, { type: 'success' })
      } else {
        const message = messageOnNewAction(newAction, type)
        if (message) this.actionWindow.pendingMessage = { message, options: { type: 'success' } }
      }
    }
  }

  async openActionWindow(params?: OpenActionWindowParams) {
    const { skipFocus, baseWindowId } = params || {}
    await this.#awaitPendingPromises()

    if (this.actionWindow.windowProps) {
      if (!skipFocus) await this.focusActionWindow()
    } else {
      let customSize

      if (this.currentAction?.type === 'swapAndBridge') {
        customSize = SWAP_AND_BRIDGE_WINDOW_SIZE
      }

      try {
        await this.#windowManager.remove('popup')
        this.actionWindow.openWindowPromise = this.#windowManager
          .open({ customSize, baseWindowId })
          .finally(() => {
            this.actionWindow.openWindowPromise = undefined
          })
        this.actionWindow.windowProps = await this.actionWindow.openWindowPromise

        this.emitUpdate()
      } catch (err) {
        this.emitError({
          message:
            'Failed to open a new request window. Please restart your browser if the issue persists.',
          level: 'major',
          error: err as Error
        })
      }
    }
  }

  async focusActionWindow(params?: FocusWindowParams) {
    await this.#awaitPendingPromises()

    if (!this.visibleActionsQueue.length || !this.currentAction || !this.actionWindow.windowProps)
      return

    try {
      await this.#windowManager.remove('popup')
      this.actionWindow.focusWindowPromise = this.#windowManager
        .focus(this.actionWindow.windowProps, params)
        .finally(() => {
          this.actionWindow.focusWindowPromise = undefined
        })

      const newActionWindowProps = await this.actionWindow.focusWindowPromise

      if (newActionWindowProps) {
        this.actionWindow.windowProps = newActionWindowProps
      }

      this.emitUpdate()
    } catch (err) {
      this.emitError({
        message:
          'Failed to focus the request window. Please restart your browser if the issue persists.',
        level: 'major',
        error: err as Error
      })
    }
  }

  async closeActionWindow() {
    await this.#awaitPendingPromises()

    if (!this.actionWindow.windowProps) return

    this.actionWindow.closeWindowPromise = this.#windowManager
      .remove(this.actionWindow.windowProps.id)
      .finally(() => {
        this.actionWindow.closeWindowPromise = undefined
      })

    await this.actionWindow.closeWindowPromise

    if (!this.actionWindow.windowProps) return

    await this.#handleActionWindowClose(this.actionWindow.windowProps.id)
  }

  setWindowLoaded() {
    if (!this.actionWindow.windowProps) return
    this.actionWindow.loaded = true

    if (this.actionWindow.pendingMessage) {
      this.#windowManager.sendWindowToastMessage(
        this.actionWindow.pendingMessage.message,
        this.actionWindow.pendingMessage.options
      )
      this.actionWindow.pendingMessage = null
    }
    this.emitUpdate()
  }

  removeAccountData(address: Account['addr']) {
    this.actionsQueue = this.actionsQueue.filter((a) => {
      if (a.type === 'accountOp') {
        return a.accountOp.accountAddr !== address
      }
      if (a.type === 'signMessage') {
        return a.userRequest.meta.accountAddr !== address
      }
      if (a.type === 'benzin') {
        return a.userRequest.meta.accountAddr !== address
      }
      if (a.type === 'switchAccount') {
        return a.userRequest.meta.switchToAccountAddr !== address
      }
      if (a.type === 'swapAndBridge') {
        return a.userRequest.meta.accountAddr !== address
      }

      return true
    })

    this.emitUpdate()
  }

  get banners() {
    return getDappActionRequestsBanners(this.visibleActionsQueue)
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      visibleActionsQueue: this.visibleActionsQueue,
      banners: this.banners
    }
  }
}
