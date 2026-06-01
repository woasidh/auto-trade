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
http://localhost:5173
```

개발 서버는 두 개가 함께 실행됩니다.

- UI: `http://localhost:5173`
- 로컬 API: `http://localhost:5174`

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
GET http://localhost:5174/api/datasets
GET http://localhost:5174/api/candles?market=KRW-USDT&interval=1m&from=2026-05-10&to=2026-05-10
GET http://localhost:5174/api/settings
PUT http://localhost:5174/api/settings
GET http://localhost:5174/api/bithumb/markets?isDetails=true
GET http://localhost:5174/api/bithumb/ticker?markets=KRW-BTC
GET http://localhost:5174/api/bithumb/orderbook?markets=KRW-BTC
GET http://localhost:5174/api/bithumb/candles/minutes?unit=1&market=KRW-BTC&count=20
```

## 시뮬레이션 규칙

- 슬롯 매수가: `상단 가격`부터 `슬롯 간격`만큼 낮추며 생성하고, 마지막 슬롯은 `하단 가격`을 포함
- 슬롯당 자금: `총 투자금 / 생성된 슬롯 수`
- 목표 매도가: `슬롯 매수가 + 목표 수익 단위`
- 목표 순수익률: `(목표 매도가 * (1 - 수수료율)) / (슬롯 매수가 * (1 + 수수료율)) - 1`
- 매수 조건: `candle.low <= slot.buyPrice`
- 매도 조건: `candle.high >= slot.targetSellPrice`
- 같은 캔들에서 신규 매수된 슬롯은 그 캔들에서 매도하지 않습니다.
- 기존 보유 슬롯의 매도는 먼저 평가합니다.
- 같은 캔들에서 매도된 슬롯은 바로 재매수하지 않습니다.
- 수수료는 매수/매도 양쪽에 반영합니다.
