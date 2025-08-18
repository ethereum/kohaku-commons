import { defaultFeatureFlags, FeatureFlags } from '../../consts/featureFlags'
import EventEmitter from '../eventEmitter/eventEmitter'

/**
 * Responsible for managing (enable/disable) feature flags within the app. The
 * long-term vision for this is to support dynamic management, currently it
 * enables or disables features only at runtime. Can be useful for feature
 * toggling, A/B testing, and gradual feature roll-outs.
 */
export class FeatureFlagsController extends EventEmitter {
  #flags: FeatureFlags

  constructor(featureFlags: Partial<FeatureFlags>) {
    super()

    this.#flags = { ...defaultFeatureFlags, ...(featureFlags || {}) }
  }

  /** Syntactic sugar for checking if a feature flag is enabled */
  isFeatureEnabled(flag: keyof FeatureFlags) {
    return this.#flags[flag]
  }

  setFeatureFlag(flag: keyof typeof defaultFeatureFlags, value: boolean): void {
    this.#flags[flag] = value
    this.emitUpdate()
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON()
    }
  }
}
