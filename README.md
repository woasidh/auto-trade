# Slice Trade

세븐스플릿 알고리즘을 과거 1분봉 데이터로 백테스트하는 로컬 UI 프로젝트입니다.

현재 v1은 빗썸 `KRW-USDT` 1분봉 데이터를 사용합니다.

## 요구사항

- Node.js 20 이상
- npm 10 이상

현재 환경에서 확인한 버전:

```bash
node -v
npm -v
```

## 설치

```bash
npm install
```

## 실행

```bash
npm run dev
```

실행 후 브라우저에서 엽니다.

```text
http://localhost:10001
```

개발 서버는 두 개가 함께 실행됩니다.

- UI: `http://localhost:10001`
- 로컬 API: `http://localhost:30001`

## 사용 방법

상단 내비게이션에서 페이지를 전환합니다.

- `시뮬레이션`: 기존 백테스트 화면
- `개발자 테스트`: 빗썸 Public API 연결 확인
- `설정`: 운영 설정 영역

### 시뮬레이션

1. 기간을 선택합니다.
   - `단일`: 하루치 데이터
   - `범위`: 여러 일자 데이터
2. 설정값을 입력합니다.
   - 슬롯 간격
   - 총 투자금
   - 상단 가격
   - 하단 가격
   - 목표 수익 단위
   - 수수료
3. `시뮬레이션 시작`을 누릅니다.
4. 결과를 확인합니다.
   - 차트 위 BUY/SELL 마커
   - 슬롯별 상태
   - 실현 손익
   - 미실현 손익
   - 총 손익
   - ROI
   - 슬롯별 거래 이력

### 개발자 테스트

빗썸 공식 Public API를 로컬 API 서버에서 프록시해 호출합니다. API Key 없이 다음 요청을 확인할 수 있습니다.

- 거래 대상 목록: `GET /v1/market/all`
- 현재가: `GET /v1/ticker`
- 호가: `GET /v1/orderbook`
- 분봉: `GET /v1/candles/minutes/{unit}`

### 설정

개발자 테스트 화면의 거래 페어, 분봉 단위, 조회 개수는 화면 안에서만 임시로 변경합니다. 테스트 기본값은 저장하지 않습니다.

```text
data/slice-trade.sqlite
```

SQLite DB는 이후 운영 설정과 자동매매 상태 저장 용도로 사용합니다. API 키, Secret Key, 계좌번호 같은 민감 정보는 DB에 저장하지 않습니다.

## 자동매매 실행 구조

- 전략 판단은 `strategyEngine`에서 수행하고, 주문 실행은 `TradingBroker` 인터페이스 뒤로 분리합니다.
- 빗썸 HTTP/JWT 인증은 `BithumbClient`로 분리되어 API 라우트와 브로커가 같은 구현을 사용합니다.
- `TradingRunner`는 전략 모드에 맞는 브로커만 호출합니다.
- 현재 기본 등록 브로커는 `PaperBroker`뿐입니다. PAPER 모드는 실제 빗썸 주문 API를 호출하지 않는 로컬 stage 모드로 동작하며, 슬롯별 지정가 주문을 미리 유지하고 mock 주문 상태를 동기화합니다.
- PAPER 주문은 빗썸 주문 응답과 비슷한 `order_id`, `client_order_id`, `state`, `executed_volume`, `executed_funds`, `paid_fee` 스냅샷을 `rawRequest`/`rawResponse`에 저장합니다.
- PAPER 매수 주문은 현재가 이하의 매수 슬롯에 선주문으로 접수되고, 지정가가 체결 가능해지면 `FILLED`로 동기화됩니다. 체결 직후 목표 매도 지정가 주문을 보충합니다.
- 러너의 무변화 tick은 판단 로그를 쌓지 않고 `runner_state`의 heartbeat와 마지막 tick 시각만 갱신합니다. 판단 로그는 주문, 체결, 오류, 복구, 의미 있는 보류 사유 같은 감사 이벤트 중심으로 남깁니다.
- `BithumbLiveBroker`는 주문 전 검증과 `/v2/orders` 요청 생성까지만 준비되어 있고, 실제 주문 POST와 주문 동기화는 아직 구현하지 않았습니다.
- LIVE 게이트가 꺼져 있으면 `BithumbLiveBroker.executeDecision`은 빗썸 private API를 호출하지 않고 차단합니다.
- 기존 수동 주문 테스트 엔드포인트도 `BITHUMB_LIVE_TRADING=true`, `BITHUMB_ORDER_SUBMISSION_ENABLED=true`, 요청 본문의 `confirmLive=true`가 모두 맞아야만 POST 주문을 보냅니다.
- LIVE 전략은 명시적인 LIVE 브로커와 안전장치가 추가되기 전까지 자동 실행되지 않습니다.

## 데이터 위치

현재 백테스트 데이터는 아래 경로에 있습니다.

```text
data/bithumb/KRW-USDT/1m
```

파일은 일자별 JSON입니다.

```text
data/bithumb/KRW-USDT/1m/2026-05-10.json
```

원본 데이터 파일은 수정하지 않습니다. 거래가 없어 빠진 1분봉은 API 응답 단계에서 이전 종가로 채우고 `synthetic: true`로 표시합니다.

## 테스트

```bash
npm test
```

## 빌드

```bash
npm run build
```

빌드 결과는 `dist` 디렉터리에 생성됩니다.

## 주요 API

로컬 API 서버가 파일 데이터를 읽어 UI에 제공합니다.

```http
GET http://localhost:30001/api/datasets
GET http://localhost:30001/api/candles?market=KRW-USDT&interval=1m&from=2026-05-10&to=2026-05-10
GET http://localhost:30001/api/settings
PUT http://localhost:30001/api/settings
GET http://localhost:30001/api/bithumb/markets?isDetails=true
GET http://localhost:30001/api/bithumb/ticker?markets=KRW-BTC
GET http://localhost:30001/api/bithumb/orderbook?markets=KRW-BTC
GET http://localhost:30001/api/bithumb/candles/minutes?unit=1&market=KRW-BTC&count=20
```

## 시뮬레이션 규칙

- 슬롯 매수가: `상단 가격`부터 `슬롯 간격`만큼 낮추며 생성하고, 마지막 슬롯은 `하단 가격`을 포함
- 슬롯당 자금: `총 투자금 / 생성된 슬롯 수`
- 목표 매도가: `슬롯 매수가 + 목표 수익 단위`
- 목표 순수익률: `(목표 매도가 * (1 - 수수료율)) / (슬롯 매수가 * (1 + 수수료율)) - 1`
- 매수 조건: 캔들 가격 구간이 슬롯 매수가를 통과하거나 터치할 때, 즉 `candle.low <= slot.buyPrice <= candle.high`
- 매도 조건: `candle.high >= slot.targetSellPrice`
- 같은 캔들에서 신규 매수된 슬롯은 그 캔들에서 매도하지 않습니다.
- 기존 보유 슬롯의 매도는 먼저 평가합니다.
- 같은 캔들에서 매도된 슬롯은 바로 재매수하지 않습니다.
- 수수료는 매수/매도 양쪽에 반영합니다.
