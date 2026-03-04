import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { address, type Address } from "gill";
import {
  getProtocolConfigPda,
  getOrganizationPda,
  getAssetPda,
  getAssetTokenPda,
  getCollectionAuthorityPda,
  getFundraisingRoundPda,
  getInvestmentPda,
  getEscrowPda,
  getListingPda,
  getOfferPda,
  getOfferEscrowPda,
  getDistributionPda,
  getDistributionEscrowPda,
  getEmergencyRecordPda,
} from "../../src/pdas.js";

function randAddr(): Address {
  return address(Keypair.generate().publicKey.toBase58());
}

const customProgramId = randAddr();

// PDA Determinism + Uniqueness Tests

describe("getProtocolConfigPda", () => {
  it("is deterministic", async () => {
    const [a1] = await getProtocolConfigPda();
    const [a2] = await getProtocolConfigPda();
    expect(a1).toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getProtocolConfigPda();
    const [a2] = await getProtocolConfigPda(customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getOrganizationPda", () => {
  it("is deterministic", async () => {
    const [a1] = await getOrganizationPda(0);
    const [a2] = await getOrganizationPda(0);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getOrganizationPda(0);
    const [a2] = await getOrganizationPda(1);
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getOrganizationPda(0);
    const [a2] = await getOrganizationPda(0, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getAssetPda", () => {
  const org = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getAssetPda(org, 0);
    const [a2] = await getAssetPda(org, 0);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getAssetPda(org, 0);
    const [a2] = await getAssetPda(org, 1);
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getAssetPda(org, 0);
    const [a2] = await getAssetPda(org, 0, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getAssetTokenPda", () => {
  const asset = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getAssetTokenPda(asset, 0);
    const [a2] = await getAssetTokenPda(asset, 0);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getAssetTokenPda(asset, 0);
    const [a2] = await getAssetTokenPda(asset, 1);
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getAssetTokenPda(asset, 0);
    const [a2] = await getAssetTokenPda(asset, 0, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getCollectionAuthorityPda", () => {
  const coll = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getCollectionAuthorityPda(coll);
    const [a2] = await getCollectionAuthorityPda(coll);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getCollectionAuthorityPda(coll);
    const [a2] = await getCollectionAuthorityPda(randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getCollectionAuthorityPda(coll);
    const [a2] = await getCollectionAuthorityPda(coll, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getFundraisingRoundPda", () => {
  const asset = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getFundraisingRoundPda(asset, 0);
    const [a2] = await getFundraisingRoundPda(asset, 0);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getFundraisingRoundPda(asset, 0);
    const [a2] = await getFundraisingRoundPda(asset, 1);
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getFundraisingRoundPda(asset, 0);
    const [a2] = await getFundraisingRoundPda(asset, 0, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getInvestmentPda", () => {
  const round = randAddr();
  const investor = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getInvestmentPda(round, investor);
    const [a2] = await getInvestmentPda(round, investor);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getInvestmentPda(round, investor);
    const [a2] = await getInvestmentPda(round, randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getInvestmentPda(round, investor);
    const [a2] = await getInvestmentPda(round, investor, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getEscrowPda", () => {
  const round = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getEscrowPda(round);
    const [a2] = await getEscrowPda(round);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getEscrowPda(round);
    const [a2] = await getEscrowPda(randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getEscrowPda(round);
    const [a2] = await getEscrowPda(round, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getListingPda", () => {
  const at = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getListingPda(at);
    const [a2] = await getListingPda(at);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getListingPda(at);
    const [a2] = await getListingPda(randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getListingPda(at);
    const [a2] = await getListingPda(at, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getOfferPda", () => {
  const at = randAddr();
  const buyer = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getOfferPda(at, buyer);
    const [a2] = await getOfferPda(at, buyer);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getOfferPda(at, buyer);
    const [a2] = await getOfferPda(at, randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getOfferPda(at, buyer);
    const [a2] = await getOfferPda(at, buyer, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getOfferEscrowPda", () => {
  const offer = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getOfferEscrowPda(offer);
    const [a2] = await getOfferEscrowPda(offer);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getOfferEscrowPda(offer);
    const [a2] = await getOfferEscrowPda(randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getOfferEscrowPda(offer);
    const [a2] = await getOfferEscrowPda(offer, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getDistributionPda", () => {
  const asset = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getDistributionPda(asset, 0);
    const [a2] = await getDistributionPda(asset, 0);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getDistributionPda(asset, 0);
    const [a2] = await getDistributionPda(asset, 1);
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getDistributionPda(asset, 0);
    const [a2] = await getDistributionPda(asset, 0, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getDistributionEscrowPda", () => {
  const dist = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getDistributionEscrowPda(dist);
    const [a2] = await getDistributionEscrowPda(dist);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getDistributionEscrowPda(dist);
    const [a2] = await getDistributionEscrowPda(randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getDistributionEscrowPda(dist);
    const [a2] = await getDistributionEscrowPda(dist, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getEmergencyRecordPda", () => {
  const at = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getEmergencyRecordPda(at);
    const [a2] = await getEmergencyRecordPda(at);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getEmergencyRecordPda(at);
    const [a2] = await getEmergencyRecordPda(randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getEmergencyRecordPda(at);
    const [a2] = await getEmergencyRecordPda(at, customProgramId);
    expect(a1).not.toBe(a2);
  });
});
