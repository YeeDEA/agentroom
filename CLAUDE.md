# AgentRoom — 세션 부트스트랩 (어느 채팅에서든 이 파일부터)

팀 대화에서 스스로 배우는 AI 팀원이 있는 워크스페이스. 질문하면 팀 지식을 근거(각주)와 함께 답하고,
카톡 백필로 과거를 상속한다. **라이브**: https://yonsei-yongjun-biz-prototype.web.app

## 지금 어디까지 왔나 → 문서가 진실이다
1. **[docs/00_INDEX.md](docs/00_INDEX.md)** — 문서 지도. 여기서 시작.
2. **[docs/03_백로그_전수.md](docs/03_백로그_전수.md)** — 유일한 작업 큐. 새 작업은 여기서 꺼내고, 끝나면 상태를 갱신하라.
3. **[docs/04_결정로그.md](docs/04_결정로그.md)** — 확정·기각·DO NOT BUILD. **여기 있는 결정을 모르고 뒤집지 마라.**
4. 현재 전략 상태: **GDG 25명 4주 검증 중 — 검증을 돕지 않는 신규 기능은 동결** (BM 진단 합의).

## 스택 / 구조 (빌드 없음)
- 정적 웹(ESM+CDN) + Firebase: Auth(이메일)·Firestore(실시간)·AI Logic(**gemini-flash-latest** — 2.5-flash는 404)
- `public/` 파일 지도:
  - `index.html` 단일 페이지 · `agentroom.css` (라이트 기본 + `:root[data-theme="dark"]`)
  - `ar-app.js` 컨트롤러(렌더·핸들러·명령어 13종·온보딩·게이팅 UI)
  - `ar-store.js` Firestore 계층(회수 엔진 fetchTopMemories·계측 logAnswerMetric/logAhaOnce·플랜 isPro)
  - `ar-ai.js` LLM(callLLM **전역 직렬 큐 1.2초** — 제거 금지·429 방어) · `ar-sprites.js` 픽셀 펫 · `ar-export.js` · `ar-game.js`
  - `evidence/`·`fraud-shield.html`·`detect.*` = **폐기된 이전 제품 보존물, 건드리지 말 것**
- `firestore.rules` v2+ — workspaces 읽기는 멤버만, 초대는 문서ID=CODE-PIN(get만), 메시지 update는
  reactions/promotedToMemory만. **규칙 바꾸면 `npx firebase-tools deploy --only firestore:rules` 필수**

## 핵심 설계 (모르면 망가뜨리는 것들)
- **회수**: 한글 음절 bigram+IDF, score=0.65rel+0.20rec+0.15promoted, 게이트 0.12(1위는 /2 구제),
  trust≤-2 제외, 무료 플랜은 90일 이전 지식 동면(`opts.pro:false`). 튜닝은 `docs/goldenset.md`로만.
- **계측**: `workspaces/{ws}/metrics` — agent_answer / upgrade_intent / aha(3종). `/metrics` 카드가 소비자.
- **과금**: 게이트=자산 회수 한도(백필 1회/500·동면). **입력(질문·승격)에 과금 금지** — 결정로그 참조.
- **플랜**: `isPro(ws)` = plan=='pro' || proUntil>now. 체험은 proUntil로 자동 만료.

## 작업 규칙 (위반 이력 있음 — 엄수)
1. git 작성자 = **dragonchoi만, Claude Co-Authored-By 금지**
2. 대화·사용자 데이터는 Firestore에만 — **저장소에 절대 커밋 금지** (AGENT24_*.md도 gitignore)
3. 배포: `npx firebase-tools deploy --only hosting`(코드) / `--only firestore:rules`(규칙). no-cache 헤더 설정돼 있음
4. 로컬 확인: `.claude/launch.json`의 static-server(5173) + 데모 계정(아래). LLM 검증은 쿼터 주의 —
   **시연 전날 대량 시딩 금지**(08-12 쿼터 소진 사고)
5. 데모 정리 시 시스템 카드는 삭제 불가 → 채널 재생성이 유일한 방법
6. 검증 후 데모 데이터 원복(trust 리셋 등) — 시연 오염 금지

## 계정 / 시연
demo@agentroom.app / demo1234 (멘토 공유됨) · tester@agentroom.app / test1234
방·시연 순서·주의사항: [docs/07_시연_가이드.md](docs/07_시연_가이드.md)

## 진행 중인 검증 (2026-08 · 코드보다 우선)
- GDG 4주: 대표가 카톡 붓고 관찰. 성공 지표는 [docs/05_지표와_검증.md](docs/05_지표와_검증.md)
- BM 진단 설계문서: `~/.gstack/projects/YonseiUXCamp/user1-master-design-20260812-agentroom-bm.md`
- 세션 히스토리(왜 이렇게 됐나): Claude 메모리 `agent-room-project.md` 배치1~14
