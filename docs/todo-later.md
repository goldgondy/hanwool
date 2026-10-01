# 나중에 할 일

미뤄 둔 작업 목록. 세무 판단이 필요한 항목은 [tax-review-items.md](tax-review-items.md)에 따로 둔다.

## 1. 거래소 API 실제 키 검증 (2026-10-01 미룸)

거래소 과거 내역 조회는 공식 문서·SDK 기준으로 만들었고, 가짜 키로 중계가 거래소까지 닿는 것만 확인했다.
각 거래소에서 **읽기 전용 API 키**를 만들어 앱 화면에 직접 입력하고, 원장 화면에서 동기화 → 잔고 대조로 확인한다.
키는 채팅·문서에 붙여넣지 않는다.

| 거래소 | 확인할 것 | 코드 |
|---|---|---|
| OKX | 체결 수수료 분리(balChg − fee)가 맞는지, 펀딩 계정 유형 코드(130/131 이체, 75/76 심플 언), 입출금 페이지 넘김(after=시각) | `src/lib/ledger/okx-build.ts`, `okx-sync.ts` |
| 코인베이스 | v2 계정·거래 내역이 CDP 키(View 권한)로 열리는지, 카드 매수의 결제 금액에 수수료가 포함되는지, 달러 지갑 매수 시 같은 buy.id로 묶이는지 | `src/lib/ledger/coinbase-build.ts` |
| 비트겟 | 장부 size의 수수료 포함 방식(자동 판별 결과 `convention`), bizOrderId ↔ 입출금 orderId 연결, 통합 계정(UTA) 사용자도 v2 현물 API가 되는지 | `src/lib/ledger/bitget-build.ts` |
| 게이트 | 장부 유형(type) 실제 값과 분류, new_order 등 주문 잠금이 잔고 변동으로 잡히는지 | `src/lib/ledger/gate-build.ts` |
| MEXC | 거래쌍 추정(USDT·USDC)으로 빠지는 체결이 없는지, 출금 금액에 수수료 포함 여부 | `src/lib/ledger/mexc-build.ts` |
| 바이비트 | 펀딩 계정 Convert·Earn 기록 | `src/lib/ledger/bybit-build.ts` |

통과 기준: 동기화 후 잔고 대조에서 차이 0 (또는 설명 가능한 차이), "처음 보는 유형" 경고 없음.
