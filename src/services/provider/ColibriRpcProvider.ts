import Colibri, { C4Config } from '@corpus-core/colibri-stateless'
import { JsonRpcApiProviderOptions, JsonRpcProvider, Network } from 'ethers'

type ColibriConfig = Partial<C4Config>
export type ColibriRpcProviderOptions = JsonRpcApiProviderOptions & {
    /**
     * Optional Colibri configuration overrides.
     * Note: `chainId` and `rpcs` are enforced by the provider based on the selected network and RPC URL.
     */
    colibri?: ColibriConfig
}

/**
 * Central allowlist for Colibri-supported chains.
 *
 * This keeps rollout safe while we evaluate proof coverage/performance before enabling more networks.
 */
export const isColibriSupportedChain = (chainId?: bigint | number) => {
    if (!chainId) return false
    // TODO we sould fetch the supported chains from colibri itself, as soon as colibri offers a function to do so
    const supportedChains = [1, 11155111, 100, 10200]
    return supportedChains.includes(Number(chainId))
}

function parseCsvEnv(value: string | undefined): string[] | null {
    if (!value) return null
    const parts = value
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    return parts.length ? parts : null
}

/**
 * Colibri-backed RPC provider.
 *
 * We extend `ethers.JsonRpcProvider` (instead of swapping types across the codebase)
 * because multiple parts of ambire-common rely on JsonRpcProvider internals such as:
 * - `_getConnection().url` for RPC tracking
 * - `destroy()` for lifecycle management
 *
 * For supported methods, requests are routed through Colibri (EIP-1193 `request()`),
 * which will verify proofs where possible and may fall back to unverified RPC based
 * on Colibri's configured proof strategy.
 */
export class ColibriRpcProvider extends JsonRpcProvider {
    readonly #colibri: Colibri

    constructor(rpcUrl: string, chainId: bigint | number, options?: ColibriRpcProviderOptions) {
        const { colibri, ...ethersOptions } = options || {}
        const staticNetwork = Network.from(Number(chainId))
        super(rpcUrl, staticNetwork, {
            ...(staticNetwork ? { staticNetwork } : {}),
            ...(ethersOptions || {})
        })

        // Defaults can be overridden both via env vars and via `options.colibri`.
        // `options.colibri` wins to allow programmatic overrides (useful for tests/integration).
        const proverUrls =
            colibri?.prover ??
            parseCsvEnv(process.env.COLIBRI_PROVER_URLS) ??
            ['https://sepolia.colibri-proof.tech/']
        const trustedCheckpoint =
            colibri?.trusted_checkpoint ?? (process.env.COLIBRI_TRUSTED_CHECKPOINT || undefined)
        const debug = colibri?.debug ?? process.env.COLIBRI_DEBUG === 'true'
        const verify = colibri?.verify ?? (() => true)

        const colibriConfig: ColibriConfig = {
            // Base config (env + defaults)
            prover: proverUrls,
            ...(trustedCheckpoint ? { trusted_checkpoint: trustedCheckpoint } : {}),
            verify,
            debug,
            // User overrides (except enforced fields below)
            ...(colibri || {}),
            // Enforced by the provider based on network selection to avoid inconsistent configs.
            // (Do not allow callers to accidentally mismatch `chainId`/`rpcs`.)
            chainId: Number(chainId),
            rpcs: [rpcUrl],
            zk_proof: true
        }

        this.#colibri = new Colibri(colibriConfig)
    }

    override async send(method: string, params: Array<any> | Record<string, any> = []): Promise<any> {
        // Colibri implements EIP-1193. Use it as the request entrypoint.
        // Its internal proof strategy decides whether to verify or fall back for unsupported methods.
        return this.#colibri.request({ method, params })
    }
}

