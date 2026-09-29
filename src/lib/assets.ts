// 자산 식별 규칙 (서버 시세 모듈과 과세 이벤트 변환기가 함께 쓴다)

// 달러 스테이블코인. 시세가 없으면 1달러로 보고, 교환에서 가치 기준으로 쓴다.
export const STABLECOINS = new Set(["USDT", "USDC", "DAI", "FDUSD", "USDE", "TUSD", "USDS", "PYUSD"]);

// 같은 가격으로 보는 자산 (시세 조회용)
export const PRICE_ALIASES: Record<string, string> = {
  WETH: "ETH",
  WBTC: "BTC",
  CBBTC: "BTC",
  WPOL: "POL",
  MATIC: "POL",
  WMATIC: "POL",
};
