export type CallbackOptions = {
  /** The sender of the message. */
  sender: unknown /* chrome.runtime.MessageSender */
  /** The topic provided. */
  topic: string
  /** An optional scoped identifier. */
  id?: number | string
}

export type CallbackFunction<TPayload, TResponse> = (
  payload: TPayload,
  callbackOptions: CallbackOptions
) => Promise<TResponse>

export type Source = 'background' | 'content' | 'inpage'

export type SendMessage<TPayload> = {
  topic: string
  payload: TPayload
  id?: number | string
}

export type ReplyMessage<TResponse> = {
  topic: string
  id: number | string
  payload: { response: TResponse; error: Error }
}

export interface Messenger {
  /** Whether or not the messenger is available in the context. */
  available: boolean
  /** Name of the messenger */
  name: string
  /** Sends a message to the `reply` handler. */
  send: <TPayload, TResponse>(
    /** A scoped topic that the `reply` will listen for. */
    topic: string,
    /** The payload to send to the `reply` handler. */
    payload: TPayload,
    options?: {
      /** Identify & scope the request via an ID. */
      id?: string | number
      [key: string]: any
    }
  ) => Promise<TResponse>
  /** Replies to `send`. */
  reply: <TPayload, TResponse>(
    /** A scoped topic that was sent from `send`. */
    topic: string,
    callback: CallbackFunction<TPayload, TResponse>
  ) => () => void
}
