import { ErrorRef } from '../controllers/eventEmitter/eventEmitter'

export default class ExternalSignerError extends Error {
  sendCrashReport?: ErrorRef['sendCrashReport']

  constructor(
    message: string,
    params?: {
      sendCrashReport?: ErrorRef['sendCrashReport']
    }
  ) {
    super()
    const { sendCrashReport = false } = params || {}
    this.name = 'ExternalSignerError'
    this.message = message
    // Don't send crash reports by default
    this.sendCrashReport = sendCrashReport
  }
}
