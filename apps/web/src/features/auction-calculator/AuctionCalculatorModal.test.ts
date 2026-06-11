import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AuctionCalculatorModal,
  calculateAuctionBid,
  formatGoldAmount,
  normalizeAuctionPartySize
} from "./AuctionCalculatorModal";

describe("calculateAuctionBid", () => {
  it("calculates the quick maximum bid from the Lost Ark auction formula", () => {
    const result = calculateAuctionBid({ marketPrice: 7770, partySize: 4 });

    expect(result.saleAfterFee).toBe(7381.5);
    expect(result.optimalBid).toBe(5536.125);
    expect(result.perPersonBenefit).toBe(1845.375);
    expect(result.missedAuctionShare).toBe(1832.875);
  });

  it("uses the party size coefficient for 4, 8, 16, and custom person raids", () => {
    expect(calculateAuctionBid({ marketPrice: 10000, partySize: 4 }).optimalBid).toBe(7125);
    expect(calculateAuctionBid({ marketPrice: 10000, partySize: 8 }).optimalBid).toBe(8312.5);
    expect(calculateAuctionBid({ marketPrice: 10000, partySize: 16 }).optimalBid).toBe(8906.25);
    expect(calculateAuctionBid({ marketPrice: 10000, partySize: 3 }).optimalBid).toBeCloseTo(6333.333333, 5);
  });
});

describe("normalizeAuctionPartySize", () => {
  it("keeps custom party sizes useful for quick manual input", () => {
    expect(normalizeAuctionPartySize("3")).toBe(3);
    expect(normalizeAuctionPartySize("12")).toBe(12);
    expect(normalizeAuctionPartySize("1")).toBe(2);
    expect(normalizeAuctionPartySize("99")).toBe(64);
    expect(normalizeAuctionPartySize("")).toBe(4);
  });
});

describe("formatGoldAmount", () => {
  it("keeps useful decimal values while formatting gold with Korean separators", () => {
    expect(formatGoldAmount(-618.5)).toBe("-618.5g");
    expect(formatGoldAmount(5536.125)).toBe("5,536.13g");
    expect(formatGoldAmount(2000)).toBe("2,000g");
  });
});

describe("AuctionCalculatorModal", () => {
  it("renders the calculator fields and result labels in a modal", () => {
    const html = renderToStaticMarkup(createElement(AuctionCalculatorModal, { onClose: vi.fn() }));

    expect(html).toContain("분배금 계산기");
    expect(html).toContain("경매가");
    expect(html).toContain("분배 인원 수");
    expect(html).toContain("권장 최대 입찰가");
    expect(html).toContain("경매장 판매 후");
    expect(html).toContain("인당 이득 골드");
    expect(html).toContain("경미참 분배금");
    expect(html).not.toContain("<label>입찰가");
    expect(html).not.toContain("수수료 5%");
    expect(html).not.toContain("순이익");
    expect(html).not.toContain("계수");
    expect(html).not.toContain("g 이하");
  });
});
