import { ErrorRef } from '../controllers/eventEmitter/eventEmitter'

export default class EmittableError extends Error {
  level: ErrorRef['level']

  message: ErrorRef['message']

  error: ErrorRef['error']

  sendCrashReport?: ErrorRef['sendCrashReport']

  constructor(errorRef: {
    message: ErrorRef['message']
    level: ErrorRef['level']
    error?: ErrorRef['error']
    sendCrashReport?: ErrorRef['sendCrashReport']
  }) {
    super()
    this.message = errorRef.message
    this.name = 'EmittableError'
    this.level = errorRef.level
    this.sendCrashReport = errorRef.sendCrashReport

    if (!errorRef.error) {
      this.error = new Error(errorRef.message)
    } else {
      this.error = errorRef.error
    }
  }
}
