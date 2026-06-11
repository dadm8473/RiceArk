import { Calculator, X } from "lucide-react";
import { useMemo, useState } from "react";

const DEFAULT_FEE_RATE = 0.05;
const MINIMUM_BID = 50;
const PARTY_SIZES = [4, 8, 16] as const;

export interface AuctionCalculationInput {
  marketPrice: number;
  partySize: number;
  feeRate?: number;
}

export interface AuctionCalculationResult {
  saleAfterFee: number;
  optimalBid: number;
  perPersonBenefit: number;
  missedAuctionShare: number;
}

function parseGoldInput(value: string): number {
  const normalized = value.replace(/,/g, "").trim();
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function normalizeAuctionPartySize(value: string): number {
  if (!value.trim()) return 4;
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return 4;
  if (parsed < 2) return 2;
  if (parsed > 64) return 64;
  return parsed;
}

export function calculateAuctionBid({
  marketPrice,
  partySize,
  feeRate = DEFAULT_FEE_RATE
}: AuctionCalculationInput): AuctionCalculationResult {
  const saleAfterFee = marketPrice * (1 - feeRate);
  const partyCoefficient = (partySize - 1) / partySize;
  const optimalBid = saleAfterFee * partyCoefficient;
  const perPersonBenefit = saleAfterFee / partySize;
  const missedAuctionShare = Math.max(0, (saleAfterFee - MINIMUM_BID) / partySize);

  return {
    saleAfterFee,
    optimalBid,
    perPersonBenefit,
    missedAuctionShare
  };
}

export function formatGoldAmount(value: number): string {
  return `${value.toLocaleString("ko-KR", {
    maximumFractionDigits: 2
  })}g`;
}

interface AuctionCalculatorModalProps {
  onClose: () => void;
}

export function AuctionCalculatorModal({ onClose }: AuctionCalculatorModalProps) {
  const [marketPrice, setMarketPrice] = useState("");
  const [partySizeInput, setPartySizeInput] = useState("4");
  const parsedMarketPrice = parseGoldInput(marketPrice);
  const partySize = normalizeAuctionPartySize(partySizeInput);
  const hasMarketPrice = parsedMarketPrice > 0;
  const result = useMemo(
    () => calculateAuctionBid({ marketPrice: parsedMarketPrice, partySize }),
    [parsedMarketPrice, partySize]
  );

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="tool-modal edit-modal auction-calculator-modal" aria-modal="true" role="dialog" aria-label="분배금 계산기">
        <header className="tool-modal-header">
          <h2>
            <Calculator aria-hidden="true" size={18} />
            분배금 계산기
          </h2>
          <button className="modal-close-button" type="button" aria-label="닫기" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="tool-modal-body edit-form auction-calculator-body">
          <div className="auction-input-grid">
            <label>
              경매가
              <input
                inputMode="numeric"
                min="0"
                placeholder="예: 7770"
                type="number"
                value={marketPrice}
                onChange={(event) => setMarketPrice(event.currentTarget.value)}
              />
            </label>
            <label>
              분배 인원 수
              <input
                inputMode="numeric"
                max="64"
                min="2"
                placeholder="예: 4"
                type="number"
                value={partySizeInput}
                onChange={(event) => setPartySizeInput(event.currentTarget.value)}
              />
            </label>
          </div>
          <fieldset className="auction-party-fieldset">
            <legend>빠른 선택</legend>
            <div className="auction-party-options" role="group" aria-label="분배 인원 수 선택">
              {PARTY_SIZES.map((size) => (
                <button
                  className={partySize === size ? "active" : undefined}
                  key={size}
                  type="button"
                  onClick={() => setPartySizeInput(String(size))}
                >
                  {size}인
                </button>
              ))}
            </div>
          </fieldset>
          <section className="auction-result-panel" aria-label="계산 결과">
            <div className="auction-result-card primary">
              <span>권장 최대 입찰가</span>
              <strong>{hasMarketPrice ? formatGoldAmount(result.optimalBid) : "-"}</strong>
            </div>
            <div className="auction-result-card">
              <span>경매장 판매 후</span>
              <strong>{hasMarketPrice ? formatGoldAmount(result.saleAfterFee) : "-"}</strong>
            </div>
            <div className="auction-result-card positive">
              <span>인당 이득 골드</span>
              <strong>{hasMarketPrice ? formatGoldAmount(result.perPersonBenefit) : "-"}</strong>
            </div>
            <div className="auction-result-card">
              <span>경미참 분배금</span>
              <strong>{hasMarketPrice ? formatGoldAmount(result.missedAuctionShare) : "-"}</strong>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
