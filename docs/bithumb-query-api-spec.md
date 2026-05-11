# 빗썸 조회 API 스펙

작성일: 2026-05-11

이 문서는 세븐스플릿 자동매매 시스템에서 빗썸 API를 연동할 때 필요한 조회 API를 정리한다. 기준 문서는 빗썸 공식 Developer Docs v2.1.5이다.

## 기본 정보

- REST API Base URL: `https://api.bithumb.com`
- Public API Base Path: `https://api.bithumb.com/v1`
- 응답 포맷: JSON
- Public API: 인증 없이 호출
- Private API: 요청마다 JWT 인증 토큰 필요
- 거래 페어 심볼 형식: `KRW-BTC`, `BTC-ETH` 등

## 요청 수 제한

공식 문서 기준 요청 제한은 다음과 같다.

- Public API: 초당 최대 150회
- Private API: 초당 최대 140회
- 주문 생성/취소 등 주문 관련 API: 초당 10회 초과 시 제한 가능

자동매매 시스템에서는 제한값보다 낮은 내부 호출 한도를 둔다.

- 시세 폴링은 종목별 최소 1초 이상 간격을 기본값으로 둔다.
- Private API는 주문 상태 확인, 계좌 확인 등 꼭 필요한 시점에만 호출한다.
- 제한 초과 응답을 받으면 즉시 재시도하지 말고 backoff 후 재시도한다.

## Private API 인증

Private API는 `Authorization: Bearer {JWT}` 헤더를 사용한다.

JWT Payload 필드:

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `access_key` | 항상 | 발급받은 API Key |
| `nonce` | 항상 | 요청마다 고유한 값. UUID 권장 |
| `timestamp` | 항상 | 현재 시각. Unix timestamp ms |
| `query_hash` | 파라미터 있을 때 | 쿼리 문자열의 SHA-512 해시 |
| `query_hash_alg` | 파라미터 있을 때 | `"SHA512"` 고정 |

인증 구현 규칙:

- JWT는 요청마다 새로 생성한다.
- 같은 JWT를 재사용하지 않는다.
- Secret Key는 환경 변수 또는 시크릿 저장소에서 읽는다.
- GET 쿼리 파라미터가 있으면 실제 요청에 붙는 쿼리 문자열과 동일한 문자열로 `query_hash`를 만든다.
- 배열 파라미터는 `uuids[]=id1&uuids[]=id2` 형태로 전개한다.
- 파라미터가 있는데 `query_hash`를 누락하면 인증 오류가 발생한다.

## Public 조회 API

### 거래 대상 목록 조회

빗썸에서 제공하는 거래 대상 페어 목록을 조회한다.

- Method: `GET`
- Endpoint: `/v1/market/all`
- Auth: 없음

Query Params:

| 이름 | 타입 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- | --- |
| `isDetails` | boolean | 아니오 | `false` | `true`면 유의 종목 여부인 `market_warning` 반환 |

주요 응답 필드:

| 필드 | 설명 |
| --- | --- |
| `market` | 거래 페어 심볼. 예: `KRW-BTC` |
| `korean_name` | 한글명 |
| `english_name` | 영문명 |
| `market_warning` | `NONE` 또는 `CAUTION`. `isDetails=true`일 때 사용 |

자동매매 사용처:

- 지원 종목 목록 동기화
- 사용자가 입력한 거래 페어 검증
- 유의 종목 필터링

예시:

```http
GET https://api.bithumb.com/v1/market/all?isDetails=true
```

### 현재가 조회

요청 시점의 종목 스냅샷을 조회한다.

- Method: `GET`
- Endpoint: `/v1/ticker`
- Auth: 없음

Query Params:

| 이름 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `markets` | string | 예 | 거래 페어 심볼. 여러 개는 쉼표로 구분 |

주요 응답 필드:

| 필드 | 설명 |
| --- | --- |
| `market` | 거래 페어 심볼 |
| `trade_price` | 현재가 또는 종가 |
| `trade_timestamp` | 최근 거래 시각. Unix timestamp ms |
| `opening_price` | 시가 |
| `high_price` | 고가 |
| `low_price` | 저가 |
| `prev_closing_price` | 전일 종가 |
| `change` | `EVEN`, `RISE`, `FALL` |
| `signed_change_price` | 부호 있는 전일 대비 변화액 |
| `signed_change_rate` | 부호 있는 전일 대비 변화율 |
| `acc_trade_price_24h` | 24시간 누적 거래대금 |
| `acc_trade_volume_24h` | 24시간 누적 거래량 |
| `timestamp` | 현재가 정보 생성 시각. Unix timestamp ms |

자동매매 사용처:

- 세븐스플릿 슬롯별 매수/매도 트리거 판단
- 상단/하단 가격 밴드 이탈 판단
- 현재가 기반 평가 손익 계산

예시:

```http
GET https://api.bithumb.com/v1/ticker?markets=KRW-BTC
GET https://api.bithumb.com/v1/ticker?markets=KRW-BTC,KRW-ETH
```

### 호가 조회

지정한 거래 페어의 호가 정보를 조회한다.

- Method: `GET`
- Endpoint: `/v1/orderbook`
- Auth: 없음

Query Params:

| 이름 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `markets` | string | 예 | 거래 페어 심볼. 여러 개는 쉼표로 구분 |

주요 응답 필드:

| 필드 | 설명 |
| --- | --- |
| `market` | 거래 페어 심볼 |
| `timestamp` | 호가 정보 생성 시각. Unix timestamp ms |
| `total_ask_size` | 매도 총 잔량 |
| `total_bid_size` | 매수 총 잔량 |
| `orderbook_units[].ask_price` | 매도 호가 |
| `orderbook_units[].bid_price` | 매수 호가 |
| `orderbook_units[].ask_size` | 매도 잔량 |
| `orderbook_units[].bid_size` | 매수 잔량 |

호가 깊이:

- `markets`가 단일 페어이면 30호가까지 제공
- `markets`가 복수 페어이면 15호가까지 제공

자동매매 사용처:

- 지정가 주문 가격 보정
- 스프레드 확인
- 주문 전 유동성 점검
- 예상 체결 가능성 추정

예시:

```http
GET https://api.bithumb.com/v1/orderbook?markets=KRW-BTC
```

### 체결 내역 조회

최근 체결된 거래 내역을 조회한다.

- Method: `GET`
- Endpoint: `/v1/trades/ticks`
- Auth: 없음

Query Params:

| 이름 | 타입 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- | --- |
| `market` | string | 예 | 없음 | 거래 페어 심볼 |
| `to` | string | 아니오 | 없음 | 조회 기준 시각 KST. `HHmmss` 또는 `HH:mm:ss` |
| `count` | int32 | 아니오 | `1` | 조회 개수. 1-500 |
| `cursor` | string | 아니오 | 없음 | 이전 응답의 `sequential_id`로 다음 페이지 조회 |
| `daysAgo` | int32 | 아니오 | 없음 | 과거 조회 범위. 1-7일 |

주요 응답 필드:

| 필드 | 설명 |
| --- | --- |
| `market` | 거래 페어 심볼 |
| `trade_date_utc` | 체결 일자 UTC |
| `trade_time_utc` | 체결 시각 UTC |
| `timestamp` | 체결 시각. Unix timestamp ms |
| `trade_price` | 체결 가격 |
| `trade_volume` | 체결량 |
| `ask_bid` | `BID` 또는 `ASK` |
| `sequential_id` | 체결 고유 ID. 유일성 식별용이며 순서 보장은 아님 |

자동매매 사용처:

- 최근 체결가 기반 현재가 보조 확인
- 백테스트 또는 슬리피지 추정용 데이터 수집
- 급격한 체결 흐름 감지

예시:

```http
GET https://api.bithumb.com/v1/trades/ticks?market=KRW-BTC&count=50
```

### 분 캔들 조회

분 단위 캔들 데이터를 조회한다.

- Method: `GET`
- Endpoint: `/v1/candles/minutes/{unit}`
- Auth: 없음

Path Params:

| 이름 | 타입 | 필수 | 허용값 | 설명 |
| --- | --- | --- | --- | --- |
| `unit` | int32 | 예 | `1`, `3`, `5`, `10`, `15`, `30`, `60`, `240` | 캔들 분 단위 |

Query Params:

| 이름 | 타입 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- | --- |
| `market` | string | 예 | `KRW-BTC` | 거래 페어 심볼 |
| `to` | string | 아니오 | 없음 | 조회 기준 시각 KST. 해당 시각의 캔들은 제외 |
| `count` | integer | 아니오 | `1` | 조회 개수. max 200 |

주요 응답 필드:

| 필드 | 설명 |
| --- | --- |
| `market` | 거래 페어 심볼 |
| `candle_date_time_utc` | 캔들 기준 시각 UTC |
| `candle_date_time_kst` | 캔들 기준 시각 KST |
| `opening_price` | 시가 |
| `high_price` | 고가 |
| `low_price` | 저가 |
| `trade_price` | 종가 |
| `timestamp` | 캔들 기간 중 마지막 거래 시각. Unix timestamp ms |
| `candle_acc_trade_price` | 캔들 기간 중 누적 거래 금액 |
| `candle_acc_trade_volume` | 캔들 기간 중 누적 거래량 |
| `unit` | 분 단위 |

자동매매 사용처:

- 밴드 재설정 판단 보조
- 가격이 상단/하단 밖에 일정 기간 머물렀는지 확인
- 운영 대시보드 차트 표시

예시:

```http
GET https://api.bithumb.com/v1/candles/minutes/1?market=KRW-BTC&count=200
```

### 일 캔들 조회

일 단위 캔들 데이터를 조회한다.

- Method: `GET`
- Endpoint: `/v1/candles/days`
- Auth: 없음

Query Params:

| 이름 | 타입 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- | --- |
| `market` | string | 예 | 없음 | 거래 페어 심볼 |
| `to` | string | 아니오 | 없음 | 조회 기준 시각 KST. 해당 시각의 캔들은 제외 |
| `count` | int32 | 아니오 | `1` | 조회 개수. max 200 |
| `convertingPriceUnit` | string | 아니오 | 없음 | 원화 마켓이 아닌 경우 환산 종가 반환. 현재 `KRW`만 지원 |

주요 응답 필드:

| 필드 | 설명 |
| --- | --- |
| `market` | 거래 페어 심볼 |
| `candle_date_time_utc` | 캔들 기준 시각 UTC |
| `candle_date_time_kst` | 캔들 기준 시각 KST |
| `opening_price` | 시가 |
| `high_price` | 고가 |
| `low_price` | 저가 |
| `trade_price` | 종가 |
| `timestamp` | 캔들 기간 중 마지막 거래 시각. Unix timestamp ms |
| `candle_acc_trade_price` | 누적 거래 금액 |
| `candle_acc_trade_volume` | 누적 거래량 |
| `prev_closing_price` | 전일 종가 |
| `change_price` | 전일 종가 대비 변화 금액 |
| `change_rate` | 전일 종가 대비 변화율 |
| `converted_trade_price` | 환산 종가. `convertingPriceUnit` 요청 시 반환 |

자동매매 사용처:

- 초기 가격 밴드 산정 보조
- 장기 변동성 및 추세 확인
- 운영 중단/재시작 판단 참고

예시:

```http
GET https://api.bithumb.com/v1/candles/days?market=KRW-BTC&count=30
```

## Private 조회 API

### 전체 계좌 조회

보유 중인 자산 정보를 조회한다.

- Method: `GET`
- Endpoint: `/v1/accounts`
- Auth: JWT 필요

Headers:

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `Authorization` | 예 | `Bearer {JWT}` |

Query Params: 없음

주요 응답 필드:

| 필드 | 설명 |
| --- | --- |
| `currency` | 화폐 심볼. 예: `KRW`, `BTC` |
| `balance` | 주문 가능 금액 또는 수량 |
| `locked` | 주문 중 묶여 있는 금액 또는 수량 |
| `avg_buy_price` | 매수 평균가 |
| `avg_buy_price_modified` | 매수 평균가 수정 여부 |
| `unit_currency` | 평단가 기준 화폐 |

자동매매 사용처:

- KRW 주문 가능 금액 확인
- 슬롯별 보유 수량 검증
- 수동 주문 또는 외부 변경 감지
- 시스템 상태 복구 시 실제 계좌와 내부 슬롯 상태 대조

예시:

```http
GET https://api.bithumb.com/v1/accounts
Authorization: Bearer {JWT}
```

### 주문 가능 정보 조회

거래 페어별 주문 가능 정보와 계좌 상태를 조회한다.

- Method: `GET`
- Endpoint: `/v1/orders/chance`
- Auth: JWT 필요

Headers:

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `Authorization` | 예 | `Bearer {JWT}` |

Query Params:

| 이름 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `market` | string | 예 | 거래 페어 심볼 |

주요 응답 필드:

| 필드 | 설명 |
| --- | --- |
| `bid_fee` | 매수 수수료 비율 |
| `ask_fee` | 매도 수수료 비율 |
| `maker_bid_fee` | Maker 매수 수수료 비율 |
| `maker_ask_fee` | Maker 매도 수수료 비율 |
| `market.id` | 거래 페어 심볼 |
| `market.order_types` | 지원 주문 방식 |
| `market.bid_types` | 매수 주문 지원 방식 |
| `market.ask_types` | 매도 주문 지원 방식 |
| `market.bid.price_unit` | 매수 주문 금액 단위 |
| `market.bid.min_total` | 최소 매수 금액 |
| `market.ask.price_unit` | 매도 주문 금액 단위 |
| `market.ask.min_total` | 최소 매도 금액 |
| `market.max_total` | 최대 매수/매도 금액 |
| `market.state` | 거래 페어 운영 상태 |
| `bid_account` | 매수 시 사용하는 화폐 계좌 상태 |
| `ask_account` | 매도 시 사용하는 화폐 계좌 상태 |

자동매매 사용처:

- 주문 전 최소 주문 금액 검증
- 호가 단위 또는 주문 금액 단위 적용
- 수수료 반영 목표가 계산
- 거래 페어 활성 상태 확인

예시:

```http
GET https://api.bithumb.com/v1/orders/chance?market=KRW-BTC
Authorization: Bearer {JWT}
```

### 개별 주문 조회

개별 주문 내역과 체결 내역을 조회한다.

- Method: `GET`
- Endpoint: `/v1/order`
- Auth: JWT 필요

Headers:

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `Authorization` | 예 | `Bearer {JWT}` |

Query Params:

| 이름 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `uuid` | string | 조건부 | 주문 고유 ID |
| `client_order_id` | string | 조건부 | 사용자가 지정한 주문 ID. 영문 대/소문자, 숫자, `-`, `_`, 1-36자 |

입력 규칙:

- `uuid` 또는 `client_order_id` 중 하나 이상은 반드시 전달한다.
- 둘 다 전달하면 `uuid` 기준으로 조회된다.

주요 응답 필드:

| 필드 | 설명 |
| --- | --- |
| `uuid` | 주문 고유 ID |
| `client_order_id` | 사용자가 지정한 주문 ID |
| `side` | `bid` 매수, `ask` 매도 |
| `ord_type` | `limit`, `price`, `market` |
| `price` | 주문 가격 |
| `state` | `wait`, `watch`, `done`, `cancel` |
| `market` | 거래 페어 심볼 |
| `created_at` | 주문 생성 시각 |
| `volume` | 주문 수량 |
| `remaining_volume` | 남은 주문 수량 |
| `reserved_fee` | 예약 수수료 |
| `remaining_fee` | 남은 수수료 |
| `paid_fee` | 사용된 수수료 |
| `locked` | 거래에 사용 중인 금액 또는 수량 |
| `executed_volume` | 체결된 수량 |
| `executed_funds` | 체결된 총 금액 |
| `trades_count` | 체결 건수 |
| `trades[]` | 체결 상세 |
| `stp_type` | 자전거래 방지 처리 유형 |
| `cancel_type` | 취소 유형 |
| `canceling_uuid` | 자전거래 취소 시 반대 주문 ID |

자동매매 사용처:

- 주문 접수 후 체결 상태 확인
- 부분 체결 처리
- 슬롯의 실제 매수가, 체결 수량, 수수료 반영
- 주문 실패 또는 취소 후 슬롯 상태 복구

예시:

```http
GET https://api.bithumb.com/v1/order?uuid={order_uuid}
Authorization: Bearer {JWT}
```

### 주문 리스트 조회

주문 목록을 조회한다.

- Method: `GET`
- Endpoint: `/v1/orders`
- Auth: JWT 필요

Headers:

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `Authorization` | 예 | `Bearer {JWT}` |

Query Params:

| 이름 | 타입 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- | --- |
| `market` | string | 아니오 | 없음 | 거래 페어 심볼 |
| `state` | string | 아니오 | `wait` | `wait`, `watch`, `done`, `cancel` |
| `states` | string[] | 아니오 | 없음 | 주문 상태 목록 |
| `uuids` | string[] | 아니오 | 없음 | 주문 고유 ID 목록. max 30 |
| `client_order_ids` | string[] | 아니오 | 없음 | 사용자 지정 주문 ID 목록. max 30 |
| `page` | int32 | 아니오 | `1` | 페이지 번호 |
| `limit` | int32 | 아니오 | `100` | 조회 개수 |
| `order_by` | string | 아니오 | `desc` | `asc` 또는 `desc` |

입력 규칙:

- `uuids`와 `client_order_ids`를 모두 전달하면 `uuids` 기준으로 조회한다.
- `uuids`와 `client_order_ids`를 모두 전달하지 않으면 최신 주문 내역을 조회한다.
- `state`와 `states`는 동시에 사용할 수 없다.
- 일반주문 상태(`wait`, `done`, `cancel`)와 자동주문 상태(`watch`)는 `states`에서 혼합 조회할 수 없다.
- 배열 파라미터는 JWT `query_hash` 생성 시 `uuids[]=...&uuids[]=...` 형식으로 전개한다.

주요 응답 필드:

| 필드 | 설명 |
| --- | --- |
| `uuid` | 주문 고유 ID |
| `client_order_id` | 사용자가 지정한 주문 ID |
| `side` | `bid` 매수, `ask` 매도 |
| `ord_type` | `limit`, `price`, `market` |
| `price` | 주문 가격 |
| `state` | 주문 상태 |
| `market` | 거래 페어 심볼 |
| `created_at` | 주문 생성 시각 |
| `volume` | 주문 수량 |
| `remaining_volume` | 남은 주문 수량 |
| `reserved_fee` | 예약 수수료 |
| `remaining_fee` | 남은 수수료 |
| `paid_fee` | 사용된 수수료 |
| `locked` | 거래에 사용 중인 금액 또는 수량 |
| `executed_volume` | 체결된 수량 |
| `executed_funds` | 체결된 총 금액 |
| `trades_count` | 체결 건수 |
| `stp_type` | 자전거래 방지 처리 유형 |

자동매매 사용처:

- 미체결 주문 동기화
- 장애 복구 시 최근 주문 재조회
- 슬롯별 주문 상태와 내부 상태 대조

예시:

```http
GET https://api.bithumb.com/v1/orders?market=KRW-BTC&state=wait&page=1&limit=100&order_by=desc
Authorization: Bearer {JWT}
```

## 자동매매 구현 시 우선순위

세븐스플릿 시스템에서는 다음 순서로 연동하는 것이 좋다.

1. `GET /v1/market/all`: 거래 페어 검증
2. `GET /v1/ticker`: 슬롯 매수/매도 판단용 현재가
3. `GET /v1/orderbook`: 주문 전 호가와 스프레드 확인
4. `GET /v1/accounts`: 실제 잔고와 내부 상태 대조
5. `GET /v1/orders/chance`: 주문 가능 금액, 최소 주문 금액, 수수료 확인
6. `GET /v1/order`: 주문 후 체결 상세 확인
7. `GET /v1/orders`: 재시작 또는 장애 복구 시 주문 목록 동기화

## 내부 데이터 매핑

세븐스플릿 슬롯과 빗썸 조회 응답은 다음처럼 매핑한다.

| 내부 필드 | 빗썸 API 필드 |
| --- | --- |
| 현재가 | `/ticker[].trade_price` |
| 현재가 시각 | `/ticker[].timestamp` |
| 매수 1호가 | `/orderbook[].orderbook_units[0].bid_price` |
| 매도 1호가 | `/orderbook[].orderbook_units[0].ask_price` |
| 사용 가능 KRW | `/accounts[currency=KRW].balance` |
| 주문 중 KRW | `/accounts[currency=KRW].locked` |
| 보유 수량 | `/accounts[currency={asset}].balance` |
| 주문 ID | `/order.uuid`, `/orders[].uuid` |
| 클라이언트 주문 ID | `/order.client_order_id`, `/orders[].client_order_id` |
| 주문 상태 | `/order.state`, `/orders[].state` |
| 실제 체결 수량 | `/order.executed_volume` |
| 실제 체결 금액 | `/order.executed_funds` |
| 체결 상세 | `/order.trades[]` |
| 수수료 | `/order.paid_fee` |

## 구현 주의사항

- 금액과 수량 응답은 문자열인 경우가 많으므로 부동소수점 `number` 대신 Decimal 타입으로 처리한다.
- 슬롯 상태 변경은 주문 요청 시점이 아니라 체결 확인 시점에 확정한다.
- `ticker.trade_price`는 판단용 기준가로 사용하되, 실제 주문 전에는 `orderbook`으로 스프레드와 유동성을 확인한다.
- `orders/chance`의 최소 주문 금액과 주문 단위를 통과하지 못하면 주문하지 않는다.
- 재시작 시에는 내부 저장 상태, `/accounts`, `/orders`를 함께 비교해 불일치를 복구한다.
- `sequential_id`는 체결 유일성 식별에 사용할 수 있으나 체결 순서를 보장하지 않는다는 점을 반영한다.
- 2026-05-07 이후 요청된 주문은 공식 문서상 `stp_type` 필드가 필수 출력될 수 있으므로 주문 상태 모델에 포함한다.

## 공식 문서

- [빗썸 Developer Docs](https://apidocs.bithumb.com/docs)
- [API 요청 수 제한 안내](https://apidocs.bithumb.com/docs/api-%EC%9A%94%EC%B2%AD-%EC%88%98-%EC%A0%9C%ED%95%9C-%EC%95%88%EB%82%B4)
- [인증 토큰 생성하기](https://apidocs.bithumb.com/docs/%EC%9D%B8%EC%A6%9D-%ED%86%A0%ED%81%B0-%EC%83%9D%EC%84%B1%ED%95%98%EA%B8%B0)
- [거래 대상 목록 조회](https://apidocs.bithumb.com/reference/%EA%B1%B0%EB%9E%98-%EB%8C%80%EC%83%81-%EB%AA%A9%EB%A1%9D-%EC%A1%B0%ED%9A%8C)
- [현재가 조회](https://apidocs.bithumb.com/reference/%ED%98%84%EC%9E%AC%EA%B0%80-%EC%A1%B0%ED%9A%8C)
- [호가 조회](https://apidocs.bithumb.com/reference/%ED%98%B8%EA%B0%80-%EC%A1%B0%ED%9A%8C)
- [체결 내역 조회](https://apidocs.bithumb.com/reference/%EC%B2%B4%EA%B2%B0-%EB%82%B4%EC%97%AD-%EC%A1%B0%ED%9A%8C)
- [분 캔들 조회](https://apidocs.bithumb.com/reference/%EB%B6%84minute-%EC%BA%94%EB%93%A4-%EC%A1%B0%ED%9A%8C)
- [일 캔들 조회](https://apidocs.bithumb.com/reference/%EC%9D%BCday-%EC%BA%94%EB%93%A4-%EC%A1%B0%ED%9A%8C)
- [전체 계좌 조회](https://apidocs.bithumb.com/reference/%EC%A0%84%EC%B2%B4-%EA%B3%84%EC%A2%8C-%EC%A1%B0%ED%9A%8C)
- [주문 가능 정보 조회](https://apidocs.bithumb.com/reference/%EC%A3%BC%EB%AC%B8-%EA%B0%80%EB%8A%A5-%EC%A0%95%EB%B3%B4)
- [개별 주문 조회](https://apidocs.bithumb.com/reference/%EA%B0%9C%EB%B3%84-%EC%A3%BC%EB%AC%B8-%EC%A1%B0%ED%9A%8C)
- [주문 리스트 조회](https://apidocs.bithumb.com/reference/%EC%A3%BC%EB%AC%B8-%EB%A6%AC%EC%8A%A4%ED%8A%B8-%EC%A1%B0%ED%9A%8C)
