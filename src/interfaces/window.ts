import { EventEmitter } from 'events'

export type WindowId = number

export type WindowProps = {
  id: WindowId
  top: number
  left: number
  width: number
  height: number
  focused: boolean
  createdFromWindowId?: number
} | null

export type FocusWindowParams = {
  /**
   * In some cases, the passed window cannot be focused (e.g., on Arc browser). If the window cannot be focused
   * within 1 second, a new window is created and the old one is removed.
   */
  reopenIfNeeded?: boolean
}

export interface WindowManager {
  event: EventEmitter
  open: (options?: {
    route?: string
    customSize?: { width: number; height: number }
    baseWindowId?: number
  }) => Promise<WindowProps>
  focus: (windowProps: WindowProps, params?: FocusWindowParams) => Promise<WindowProps>
  closePopupWithUrl: (url: string) => Promise<void>
  remove: (winId: WindowId | 'popup') => Promise<void>
  sendWindowToastMessage: (
    message: string,
    options?: {
      timeout?: number
      type?: 'error' | 'success' | 'info' | 'warning'
      sticky?: boolean
    }
  ) => void
  sendWindowUiMessage: (params: {}) => void
}
