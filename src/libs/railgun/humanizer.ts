import { SubmittedAccountOp } from "libs/accountOp/submittedAccountOp"
import { IrCall } from "libs/humanizer/interfaces"

export const humanizeRailgunAccountOp = (submittedAccountOp: SubmittedAccountOp): IrCall[] => {
  const meta = submittedAccountOp.meta as any
  const isInternalTransfer = !!meta?.isRailgunInternalTransfer
  const withdrawalData = meta?.withdrawalData

  if (withdrawalData) {
    return [
      {
        id: 'railgun-withdrawal',
        value: 0n,
        data: '0x' as `0x${string}`,
        fullVisualization: [
          {
            type: 'action',
            content: isInternalTransfer ? 'Private Internal Transfer' : 'Private Transfer',
            id: 1
          },
          { type: 'label', content: 'of', id: 2 },
          {
            type: 'token',
            address: withdrawalData.token,
            value: BigInt(withdrawalData.amount),
            id: 3
          },
          { type: 'label', content: 'to', id: 4 },
          isInternalTransfer
            ? {
                type: 'label',
                content: `${withdrawalData.recipient.slice(
                  0,
                  8
                )}...${withdrawalData.recipient.slice(-6)}`,
                id: 5
              }
            : { type: 'address', address: withdrawalData.recipient, id: 5 },
          { type: 'label', content: 'via', id: 6 },
          { type: 'label', content: 'Railgun', id: 7 }
        ]
      }
    ]
  }

  return [
    {
      id: 'railgun-withdrawal',
      value: 0n,
      data: '0x' as `0x${string}`,
      fullVisualization: [
        {
          type: 'action',
          content: isInternalTransfer ? 'Private Internal Transfer' : 'Private Transfer',
          id: 1
        },
        { type: 'label', content: 'Via Railgun', id: 2 }
      ]
    }
  ]
}
