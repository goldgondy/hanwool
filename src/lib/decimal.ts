import Decimal from "decimal.js";

// 모든 모듈은 decimal.js 대신 이 모듈을 import한다.
// - 기본 정밀도(유효숫자 20자리)로는 18자리 소수 토큰의 합산이 반올림되어 원장 대사가 어긋난다.
// - 아주 작은 수가 "1e-9" 같은 지수 표기 문자열로 저장되지 않게 한다.
Decimal.set({ precision: 60, toExpNeg: -40, toExpPos: 40 });

export default Decimal;
