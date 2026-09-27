import type Decimal from "decimal.js";

export interface RawBalance {
  location: string;
  asset: string;
  rawAsset: string;
  amount: Decimal;
}
