# ChatGPT 인수인계 가이드 (2026-08-13)

> Claude Code → ChatGPT로 작업을 이어갈 때. **핵심: ChatGPT=두뇌(설계·전략·문서·코드 초안),
> Claude Code=손발(파일·git·배포·E2E 검증).** 지금 국면(기능 동결+검증)은 두뇌 비중이 커서
> 이관 타이밍은 나쁘지 않다.

## 1. 되는 것 / 안 되는 것

**ChatGPT로 충분한 것**: 전략·BM 토론, 패널 심사, GDG 검증 설계(설문·인터뷰·결과 해석),
백로그 우선순위·결정로그 문안, 회수 스코어링 리뷰·goldenset 채점 시뮬(코드 인터프리터),
단일 함수 코드 초안, 카피·온보딩 문구.

**안 되는 것 (Claude Code로 돌아와야 함)**:
- 로컬 파일 직접 수정 (패치 텍스트만 줌 → 사용자가 손으로 반영, 사고 위험)
- git 커밋·푸시 (dragonchoi 단독 규칙은 로컬에서만 지켜짐)
- `npx firebase-tools deploy` (hosting·rules)
- 브라우저 E2E 검증 (로그인 후 화면 동작)
- **firestore.rules 수정 — 배포해야만 검증되므로 ChatGPT에서 만지지 말 것**
- **agentroom.css — V1~V9 레이어 누적이라 부분 수정 위험**
- CLAUDE.md 자동 로드 없음 → Projects 지침이 대신해야 함
- 서브에이전트 병렬 (거장 패널 6인 동시 → 순차 롤플레이로 대체, 품질 저하 감수)

## 2. 준비물 체크리스트

**P0 — 지침에 직접 붙여넣기**: 아래 3절 커스텀 인스트럭션 전문
(회수 공식·과금 금지·git 규칙은 검색에 맡기면 안 됨)

**P1 — Projects에 업로드 (필수)**: `docs/*.md` 전부(13개, 합쳐서 ~600줄이라 부담 없음.
파일명이 라우팅 힌트라 분리 유지가 유리) + `CLAUDE.md`

**P2 — 코드 (선별)**: `firestore.rules`(참조용·수정금지) · `ar-store.js`(회수·계측·플랜) ·
`ar-ai.js` · `index.html`

**올리지 말 것**: `ar-app.js`(2100줄 — 필요한 함수 ±50줄만 그때그때) ·
`agentroom.css`(700줄, 레이어 누적) · `evidence/`·`fraud-shield.html`·`detect.*`
(**폐기물 — 올리면 현행 제품으로 오인함**)

**보안**: 데모 계정 비번·Firebase 키는 지침에 넣지 말 것.
**갱신 규칙**: 코드가 바뀌면 Projects 업로드 파일도 교체(안 하면 실패 모드 1).

## 3. ChatGPT Projects 커스텀 인스트럭션 (복붙용)

→ **[chatgpt-instructions.txt](chatgpt-instructions.txt)** 파일에 전문 저장됨. 그대로 복사해 붙여넣을 것.

## 4. 작업별 도구 배분
| 작업 | 도구 |
|---|---|
| 전략·BM·패널 심사 / GDG 검증 설계·해석 / 백로그·PRD 문안 / 회수 알고리즘 시뮬 | **ChatGPT** |
| 단일 함수 버그 수정 | ChatGPT 초안 → **Claude Code 적용** |
| 다중 파일 변경 / CSS / 문서 대량 재구성 | **Claude Code** |
| firestore.rules / 배포 / git / E2E·시연 리허설 | **Claude Code 전용** |

**권장 루프**: ChatGPT에서 설계·합의 → "Claude Code용 작업 지시문"으로 뽑아달라고 요청 →
로컬에 붙여넣어 구현·배포.

## 5. 실패 모드 3가지
1. **오래된 코드 위에 패치 → 변경분 소실** (가장 위험). 예방: 파일 통째 교체 금지·before/after 스니펫만,
   작업 전 현재 코드 붙여넣기, 반영 전 `git diff` 확인.
2. **기각된 안 부활** (특히 "입력 과금"). 예방: 기각 목록을 지침 본문에 직접 박기(3절에 포함),
   새 기각 생길 때마다 지침에 추가.
3. **기능 동결 원칙 붕괴** — 대화가 길어지면 신규 기능으로 흐름. 예방: 기능 아이디어는 **백로그 항목
   형식으로만** 출력하게 강제. Projects를 `AgentRoom-검증` / `AgentRoom-빌드` 둘로 분리하면 가장 확실.

## 6. 지금 바로 (5분)
1. ChatGPT 프로젝트 생성 → `chatgpt-instructions.txt` 전문 붙여넣기
2. `CLAUDE.md` + `docs/*.md` 전부 + `ar-store.js` + `ar-ai.js` + `firestore.rules` 업로드
3. 첫 테스트: **"백로그에서 GDG 검증을 직접 돕는 항목만 3개 골라줘"**
   → 결정로그·동결 원칙을 지키는지 확인
