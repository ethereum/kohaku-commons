import { SubmittedAccountOp } from '../accountOp/submittedAccountOp'
import { IrCall } from '../humanizer/interfaces'

/**
 * Custom humanizer for Privacy Pools relayer transactions
 * These transactions have empty calls arrays and special metadata
 * that needs to be transformed into a rich visualization
 */
export const humanizePrivacyPoolsAccountOp = (submittedAccountOp: SubmittedAccountOp): IrCall[] => {
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
