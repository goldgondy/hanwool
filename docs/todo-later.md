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
| 비트겟 | 장부 size의 수수료 포함 방식(자동 판별 결과 `convention`), bizOrderId ↔ 입출금 orderId 연결, 통합 계정(UTA) 사용자도 v2 API가 되는지 (안 되면 /api/v3/account/financial-records로 전환). 선물: 잔고 변동 = amount + fee 인지, 선물 잔고 = accountEquity − unrealizedPL 인지. Earn: 이자가 현물로 지급될 때 중복 제거가 맞는지, Earn 가입·환매가 현물 장부에 어떤 유형으로 찍히는지 | `src/lib/ledger/bitget-build.ts`, `bitget-sync.ts` |
| 게이트 | 장부 유형(type) 실제 값과 분류, new_order 등 주문 잠금이 잔고 변동으로 잡히는지. 선물 장부 페이지 넘김(offset)과 기간 제한, 선물 잔고 total에 미실현 손익이 빠지는지. 심플 언 잔고로 amount가 맞는지(current_amount와 비교) | `src/lib/ledger/gate-build.ts`, `gate-sync.ts` |
| MEXC | 거래쌍 추정(USDT·USDC)으로 빠지는 체결이 없는지, 출금 금액에 수수료 포함 여부. 선물: 서명 방식(가짜 키로는 "Internal error"만 와서 미확인), realised에 펀딩비 포함 여부, 선물 잔고 = equity − unrealized 인지 | `src/lib/ledger/mexc-build.ts`, `mexc-sync.ts` |
| 바이낸스 | 체결 거래쌍 추정(코인 × USDT·FDUSD·USDC·BTC·ETH·BNB)으로 빠지는 체결이 없는지, 출금 amount에 수수료 미포함이 맞는지, 소액 전환 transferedAmount가 수수료 전 금액인지, Simple Earn 이자와 배당(assetDividend) 중복 제거, P2P 응답 형식(data·commission)과 조회 기간 제한, Pay 응답 형식, 자동 투자 수수료가 지불 금액과 별도인지, 카드 결제 응답 형식, 마진 이자 중 BNB로 낸 이자(_CONVERTED 유형)의 실제 차감 코인, 듀얼 인베스트먼트 만기 결과 추정(만기 직전 1분 종가 vs 바이낸스 정산가, 연이율 표기 0.2 = 20% 여부) | `src/lib/ledger/binance-build.ts`, `binance-sync.ts` |
| 바이비트 | 펀딩 계정 Convert·Earn 기록 | `src/lib/ledger/bybit-build.ts` |

| 업비트 | 허용 IP 등록 후 동기화, 종료 주문 7일 구간 조회와 개별 주문 체결 금액 합계, 원화 입출금이 같은 목록에 나오는지, 입금 완료 상태 이름 | `src/lib/ledger/korea-build.ts`, `korea-sync.ts` |
| 빗썸 | 브라우저 직접 조회(CORS)·IP 제한, 주문 목록의 executed_funds, 원화 입출금 목록(/v1/deposits/krw, /v1/withdraws/krw) 응답 형식과 상태 이름 | 같은 파일 |

선물·Earn은 거래소 전체를 한 계좌로 보고(현물 + 선물 + Earn) 그 사이 이동을 원장에서 뺀다. 아직 포함하지 않는 계정: 마진·카피 트레이딩·봇·P2P (비트겟·게이트), 코인 마진 선물 (게이트), Earn (MEXC는 API 없음).

통과 기준:

## 2. 지갑 실데이터 점검에서 남은 차이 (2026-10-02, src/lib/ledger/wallets.live.test.ts)

비트코인 3/3 일치. 이더리움·아비트럼은 아래 외에는 일치. 주소 오염 가짜 전송·사칭 토큰(비영문 이름, 가짜 USDT·USDC)은 원장·잔고 모두에서 빼도록 고쳤다.
- **아비트럼 Blockscout 색인 누락**: 일부 주소에서 가장 오래된 기록 이전의 입금(USDC 54.58, ETH 극소량)이 Blockscout에 없다. 수수료 계산은 노드 영수증과 일치 확인.
  대안: 이더스캔 V2 API(무료 키, 아비트럼 지원 여부 확인) 등 두 번째 데이터 출처로 보완하거나 잔고 대조 조정으로 처리.
- **잔고가 이벤트 없이 바뀌는 토큰**: 반사형(KISHU 등 전송 수수료·분배), 이벤트 없이 잔고를 주는 스팸(HA138COM, GUYS). 잔고 대조에서 "설명되지 않는 차이"로 나온다 (검토 항목 #12와 연결).
- **Base·Optimism·Polygon**: Base Blockscout 시간 초과, OP·Polygon은 표본 주소를 못 찾음. 표본 방식을 바꿔 다시 점검할 것.

## 3. 배포: 중계 서버의 고정 IP (업비트)

업비트 API 키는 등록한 IP(최대 10개)에서만 동작하고, 업비트 개인 API는 브라우저 직접 호출을 막아 중계 서버를 거친다.
그래서 중계 서버의 나가는 IP가 **고정**이어야 사용자가 그 IP를 업비트에 등록할 수 있다. 일반 서버리스(Vercel 기본)는 IP가 바뀐다.
선택지: 고정 IP를 주는 호스팅(서울 리전 VM, Fly.io 고정 IP, Vercel Static IPs 등)에 중계만 따로 두기.
바이낸스 중계도 미국 IP를 막으므로 같은 서울 리전 중계 서버에 두면 함께 해결된다.

## 4. ✅ 빗썸 거래내역 파일 변환기 (2026-10-02 완료)

세무사가 준 "기간별 거래 내역" 엑셀 캡처로 만들었다: `src/lib/importers/bithumb.ts` (엑셀 .xlsx·CSV·엑셀에서 복사한 표 붙여넣기).
남은 확인: 실제 .xlsx 파일 업로드 (캡처라 칸이 글자인지 숫자인지 미확인), 매수·매도·입출금·포인트샵 입금 외 유형 이름
(에어드랍·이벤트·스테이킹 등은 이름으로 보상 추정, 모르는 유형은 검토 필요), 코인 출금의 거래수량에 수수료가 포함되는지 (원화 출금은 포함 확인).
옛 엑셀 형식(.xls)은 읽지 못해 .xlsx로 다시 저장하도록 안내한다.

(1번 표의) 통과 기준: 동기화 후 잔고 대조에서 차이 0 (또는 설명 가능한 차이), "처음 보는 유형" 경고 없음.
