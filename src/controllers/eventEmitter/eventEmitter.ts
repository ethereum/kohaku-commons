/* eslint-disable no-restricted-syntax */
import wait from '../../utils/wait'

const LIMIT_ON_THE_NUMBER_OF_ERRORS = 100

export type ErrorRef = {
  /**
   * User-friendly message, ideally containing call to action
   */
  message: string
  /**
   * Logged in the console - all
   * Displayed as a banner - expected, major
   * Reported to the error tracking service by default - all, except `expected`
   */
  level: 'expected' | 'minor' | 'silent' | 'major'

  /**
   * Whether the error be reported to the error tracking service (e.g. Sentry).
   * The default value depends on the error level. See the `level` property for more info.
   */
  sendCrashReport?: boolean
  /**
   * The original error, containing technical details and stack trace
   */
  error: Error
}

export type Statuses<T extends string> = {
  [key in T]: 'INITIAL' | 'LOADING' | 'SUCCESS' | 'ERROR' | string
}

export default class EventEmitter {
  #callbacksWithId: {
    id: string | null
    cb: (forceEmit?: true) => void
  }[] = []

  #callbacks: ((forceEmit?: true) => void)[] = []

  #errorCallbacksWithId: {
    id: string | null
    cb: (error: ErrorRef) => void
  }[] = []

  #errorCallbacks: ((error: ErrorRef) => void)[] = []

  #errors: ErrorRef[] = []

  statuses: Statuses<string> = {}

  get onUpdateIds() {
    return this.#callbacksWithId.map((item) => item.id)
  }

  get onErrorIds() {
    return this.#errorCallbacksWithId.map((item) => item.id)
  }

  // called emittedErrors and not just errors because some of the other controllers
  // that extend this one have errors defined already
  get emittedErrors() {
    return this.#errors
  }

  /**
   * Using this function to emit an update bypasses both background and React batching,
   * ensuring that the state update is immediately applied at the application level (React/Extension).
   *
   * This is particularly handy when multiple status flags are being updated rapidly.
   * Without the `forceEmitUpdate` option, the application will only render the very first and last status updates,
   * batching the ones in between.
   */
  async forceEmitUpdate() {
    await wait(1)
    // eslint-disable-next-line no-restricted-syntax
    for (const i of this.#callbacksWithId) i.cb(true)
    // eslint-disable-next-line no-restricted-syntax
    for (const cb of this.#callbacks) cb(true)
  }

  protected emitUpdate() {
    // eslint-disable-next-line no-restricted-syntax
    for (const i of this.#callbacksWithId) i.cb()
    // eslint-disable-next-line no-restricted-syntax
    for (const cb of this.#callbacks) cb()
  }

  protected emitError(error: ErrorRef) {
    this.#errors.push(error)
    this.#trimErrorsIfNeeded()
    console.log(
      `[Еmitted error in controller ${this.constructor.name}] ${error.message}`,
      this.#errors
    )

    // eslint-disable-next-line no-restricted-syntax
    for (const i of this.#errorCallbacksWithId) i.cb(error)
    // eslint-disable-next-line no-restricted-syntax
    for (const cb of this.#errorCallbacks) cb(error)
  }

  protected async withStatus(
    callName: string,
    fn: Function,
    allowConcurrentActions = false,
    // Silence this error in prod to avoid displaying wired error messages.
    // The only benefit of displaying it is for devs to see when an action is dispatched twice.
    // TODO: If this happens on PROD, ideally we should get an error report somehow somewhere.
    errorLevel: ErrorRef['level'] = process.env.APP_ENV === 'production' &&
    process.env.IS_TESTING !== 'true'
      ? 'silent'
      : 'minor'
  ) {
    const someStatusIsLoading = Object.values(this.statuses).some((status) => status !== 'INITIAL')

    if (!this.statuses[callName]) {
      console.error(`${callName} is not defined in "statuses".`)
    }

    // By default, concurrent actions are disallowed to maintain consistency, particularly within sub-controllers where
    // simultaneous actions can lead to unintended side effects. The 'allowConcurrentActions' flag is provided to enable
    // concurrent execution at the main controller level. This is useful when multiple actions need to modify the state
    // of different sub-controllers simultaneously.
    if ((someStatusIsLoading && !allowConcurrentActions) || this.statuses[callName] !== 'INITIAL') {
      this.emitError({
        level: errorLevel,
        message: `Please wait for the completion of the previous action before initiating another one.', ${callName}`,
        error: new Error(
          'Another function is already being handled by withStatus refrain from invoking a second function.'
        )
      })

      return
    }

    this.statuses[callName] = 'LOADING'
    await this.forceEmitUpdate()

    try {
      await fn()

      this.statuses[callName] = 'SUCCESS'
      await this.forceEmitUpdate()
    } catch (error: any) {
      this.statuses[callName] = 'ERROR'
      if ('message' in error && 'level' in error && 'error' in error) {
        this.emitError(error)

        // Sometimes we don't want to show an error message to the user. For example, if the user cancels a request
        // we don't want to go through the SUCCESS state, but we also don't want to show an error message.
      } else if (error?.message) {
        this.emitError({
          message: error?.message || 'An unexpected error occurred',
          level: 'major',
          error
        })
      }
      await this.forceEmitUpdate()
    }

    this.statuses[callName] = 'INITIAL'
    await this.forceEmitUpdate()
  }

  // Prevents memory leaks and storing huge amount of errors
  #trimErrorsIfNeeded() {
    if (this.#errors.length > LIMIT_ON_THE_NUMBER_OF_ERRORS) {
      const excessErrors = this.#errors.length - LIMIT_ON_THE_NUMBER_OF_ERRORS
      this.#errors = this.#errors.slice(excessErrors)
    }
  }

  // returns an unsub function
  onUpdate(cb: (forceUpdate?: boolean) => void, id?: string): () => void {
    if (id) {
      this.#callbacksWithId.push({ id, cb })
    } else {
      this.#callbacks.push(cb)
    }

    return () => {
      if (id) {
        this.#callbacksWithId = this.#callbacksWithId.filter(
          (callbackItem) => callbackItem.id !== id
        )
      } else {
        this.#callbacks.splice(this.#callbacks.indexOf(cb), 1)
      }
    }
  }

  // returns an unsub function for error events
  onError(cb: (error: ErrorRef) => void, id?: string): () => void {
    if (id) {
      this.#errorCallbacksWithId.push({ id, cb })
    } else {
      this.#errorCallbacks.push(cb)
    }

    return () => {
      if (id) {
        this.#errorCallbacksWithId = this.#errorCallbacksWithId.filter(
          (callbackItem) => callbackItem.id !== id
        )
      } else {
        this.#errorCallbacks.splice(this.#errorCallbacks.indexOf(cb), 1)
      }
    }
  }

  toJSON() {
    return {
      ...this,
      emittedErrors: this.emittedErrors // includes the getter in the stringified instance
    }
  }
}
