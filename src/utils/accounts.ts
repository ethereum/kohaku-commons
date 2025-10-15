import { Key } from 'ambire-common/src/interfaces/keystore'

const getIsViewOnly = (keys: Key[], accountKeys: string[]) => {
  return keys.every((k) => !accountKeys.includes(k.addr))
}

export { getIsViewOnly }
