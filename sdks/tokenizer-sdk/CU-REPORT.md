# Compute Unit Report

CU consumption per instruction as measured by LiteSVM.

Regenerate with: `npx vitest run cu-report`

## Summary

| Category     | Instruction                      |       CU |
|--------------|----------------------------------|----------|
| Protocol     | initializeProtocol               |    4,900 |
| Protocol     | updateConfigFeeBps               |    1,839 |
| Protocol     | updateConfigFeeTreasury          |    1,869 |
| Protocol     | updateConfigAddMint              |    1,898 |
| Protocol     | updateConfigRemoveMint           |    1,898 |
| Protocol     | updateConfigSetOperator          |    1,869 |
| Protocol     | updateConfigMinProposalWeightBps |    1,841 |
| Protocol     | pauseProtocol                    |    1,813 |
| Protocol     | unpauseProtocol                  |    1,813 |
| Organization | registerOrganization             |    8,268 |
| Organization | updateOrgAddMint                 |    3,724 |
| Organization | updateOrgRemoveMint              |    3,664 |
| Organization | deregisterOrganization           |    3,554 |
| Asset        | initAsset                        |   21,310 |
| Asset        | mintToken                        |   48,184 |
| Asset        | updateMetadata                   |   14,598 |
| Fundraising  | createRound                      |   18,591 |
| Fundraising  | invest                           |   13,041 |
| Fundraising  | finalizeRound                    |   40,053 |
| Fundraising  | mintRoundTokens (1 investor)     |   48,274 |
| Fundraising  | cancelRound                      |    6,872 |
| Fundraising  | refundInvestment (1 investor)    |   14,315 |
| Market       | listForSale                      |   10,086 |
| Market       | buyListedToken (full)            |   81,649 |
| Market       | delist                           |    3,597 |
| Market       | makeOffer                        |   27,403 |
| Market       | rejectOffer                      |   15,597 |
| Market       | cancelOffer                      |   13,883 |
| Market       | acceptOffer (partial)            |  124,552 |
| Market       | transferToken                    |   45,109 |
| Market       | consolidateTokens (2 sources)    |   95,133 |
| Distribution | createDistribution               |   27,441 |
| Distribution | claimDistribution (1 claim)      |   13,218 |
| Distribution | closeDistribution                |    9,763 |
| Emergency    | burnAndRemint                    |   71,356 |
| Emergency    | splitAndRemint (2 recipients)    |  107,464 |
| Buyout       | createBuyoutOffer                |    8,788 |
| Buyout       | fundBuyoutOffer                  |   18,277 |
| Buyout       | cancelBuyout                     |   11,269 |
| Governance   | createOrgRealm                   |   86,830 |
| Governance   | createRegistrar                  |    6,560 |
| Governance   | createVoterWeightRecord          |    7,990 |
| Governance   | createMaxVoterWeightRecord       |    8,053 |
| Governance   | createAssetGovernance            |   36,107 |

## Notes

- All measurements use a single LiteSVM instance per category with minimal setup.
- Instructions with variable account counts (e.g. `mintRoundTokens`, `claimDistribution`, `consolidateTokens`, `splitAndRemint`) scale linearly — multiply per-item cost for estimates.
