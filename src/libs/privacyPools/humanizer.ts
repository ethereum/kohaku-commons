import { SubmittedAccountOp } from '../accountOp/submittedAccountOp'
import { IrCall } from '../humanizer/interfaces'

/**
 * Custom humanizer for Privacy Pools transactions
 * These include:
 * - Relayer withdrawal transactions with empty calls arrays and special metadata
 * - Imported account records to track when accounts are imported into the wallet
 */
export const humanizePrivacyPoolsAccountOp = (submittedAccountOp: SubmittedAccountOp): IrCall[] => {
  // Handle imported account records
  if (submittedAccountOp.identifiedBy.type === 'ImportedAccount') {
    const accountName = submittedAccountOp.identifiedBy.identifier

    return [
      {
        id: 'privacy-pools-import-account',
        value: 0n,
        data: '0x' as `0x${string}`,
        fullVisualization: [
          {
            type: 'action',
            content: 'Imported Account',
            id: 1
          },
          {
            type: 'label',
            content: accountName,
            id: 2
          }
        ]
      }
    ]
  }

  // Handle privacy pools withdrawal transactions
  // @ts-ignore - Check if we have rich withdrawal data in meta
  const withdrawalData = submittedAccountOp.meta?.withdrawalData

  if (withdrawalData) {
    // Rich visualization with token, recipient, and relayer details
    return [
      {
        id: 'privacy-pools-withdrawal',
        value: 0n,
        data: '0x' as `0x${string}`,
        fullVisualization: [
          {
            type: 'action',
            content: 'Send',
            id: 1
          },
          {
            type: 'token',
            address: withdrawalData.token,
            value: BigInt(withdrawalData.amount),
            id: 2
          },
          {
            type: 'label',
            content: 'to',
            id: 3
          },
          {
            type: 'address',
            address: withdrawalData.recipient,
            id: 4
          },
          {
            type: 'label',
            content: 'via',
            id: 5
          },
          {
            type: 'address',
            address: withdrawalData.relayerAddress,
            id: 6
          }
        ]
      }
    ]
  }

  // Fallback to generic message if no withdrawal data
  return [
    {
      id: 'privacy-pools-withdrawal',
      value: 0n,
      data: '0x' as `0x${string}`,
      fullVisualization: [
        {
          type: 'action',
          content: 'Privacy Pools Transfer',
          id: 1
        },
        {
          type: 'label',
          content: 'Via Relayer',
          id: 2
        }
      ]
    }
  ]
}
