import { sha256, toBytes } from 'viem'
import { english } from 'viem/accounts'

function bytesToBits(bytes: Uint8Array): string {
  let bits = ''
  // eslint-disable-next-line no-restricted-syntax
  for (const b of bytes) bits += b.toString(2).padStart(8, '0')
  return bits
}

// Minimal BIP39 entropy -> mnemonic (English) implementation
export async function mnemonicFromEntropy(entropy: Uint8Array): Promise<string> {
  // force 128 bits (12 words)
  const truncated = entropy.slice(0, 16)

  const ENT = truncated.length * 8
  const CS = ENT / 32
  const hash = sha256(truncated)
  // Build bitstring of entropy + checksum
  const bits = bytesToBits(truncated) + bytesToBits(toBytes(hash)).slice(0, CS)
  const words: string[] = []
  for (let i = 0; i < bits.length; i += 11) {
    const chunk = bits.slice(i, i + 11)
    if (chunk.length < 11) break
    const idx = parseInt(chunk, 2)
    words.push(english[idx])
  }
  return words.join(' ')
}
