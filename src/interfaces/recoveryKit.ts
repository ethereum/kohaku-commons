/** The recovery kit whose audited actions an account op may grant a privilege on the account */
export interface RecoveryKit {
  manager: string
  auditedActions: string[]
}

/** The recovery kit on an account op, with the id of the one user request that carries it */
export interface AccountOpRecoveryKit extends RecoveryKit {
  fromUserRequestId: string | number
}
