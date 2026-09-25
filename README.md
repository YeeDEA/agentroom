# 🥚 AgentRoom

**팀의 집단지성을 먹고 자라는 AI 워크스페이스**
사람은 떠나도, 팀이 배운 것은 남아야 합니다.

> *A Discord-style team workspace where AI agents learn from your conversations, remember your team's decisions, and grow from egg to adult.*

🔗 **라이브 데모**: https://yonsei-yongjun-biz-prototype.web.app
📚 **문서 체계**: [docs/00_INDEX.md](docs/00_INDEX.md) — PRD · 백로그 전수 · 결정로그 · 지표 · 수익화 · 시연 가이드

---

## 무엇을 해결하나

조직은 기억상실증을 앓습니다. 사람이 떠나면 "왜 그때 그렇게 결정했는지"가 함께 사라지고, 사내 위키는 아무도 쓰지 않아 죽습니다. 지식 기여는 *내가 비용을 내고 남이 이득 보는* 공공재 게임이기 때문입니다.

AgentRoom은 이 딜레마를 **소멸시킵니다** — 에이전트가 팀이 원래 하던 대화에서 스스로 배우므로, 기억을 쌓는 일이 일의 부산물이 됩니다.

**화요일 오전 10시**: 신입이 채널에서 질문합니다. 30초 뒤, 석 달 전 떠난 선배의 결정 맥락이 **근거(🧠)와 함께** 돌아옵니다. 아무도 문서를 쓰지 않았습니다.

## 핵심 기능

### 🧠 하이브리드 기억 모델
- **자동 학습** — 에이전트가 대화에서 스스로 지식을 추출·저장
- **메시지 승격** — 중요한 메시지에 🧠 클릭 → 채널의 모든 에이전트가 우선 기억
- **기억 큐레이션** — 자동 학습된 기억을 승격/삭제로 정제
- **근거 각주** — 답변마다 어떤 팀 기억을 근거로 썼는지 표시

### 💬 디스코드형 협업
- 멀티 워크스페이스 · 채널 · 실시간 채팅 · 이미지 첨부
- 6자리 초대코드 + 4자리 방 비밀번호
- @멘션 자동완성, 메시지 복사/삭제(5분), 방별 프로필(이모지 아바타·닉네임)

### 🐣 에이전트 육성 (8-bit)
알(Egg) → 부화 → 성장기 → 성숙기. EXP는 **메시지 수가 아니라** 지식 학습·유용한 답변·팀원 피드백(👍)으로 쌓입니다(어뷰징 방지).

### ⌨️ 슬래시 명령어 15종
| 협업형 (에이전트 발언이 그대로 보임) | 산출물형 |
|---|---|
| `/discuss` 원탁 토론 · `/brainstorm` 아이디어 발산 · `/score` 1~10 채점 | `/plan` `/pitch` `/canvas` `/swot` `/tasks` `/decide` `/name` `/viz`(다이어그램) `/summary` `/decisions` `/export`(md·html·json·csv·txt) |

### 🔌 두뇌 교체 (Gemini ↔ Hermes)
프로바이더 계층으로 LLM을 갈아끼울 수 있습니다. Hermes(오픈모델)는 **BYOK** 방식 — 키는 사용자 브라우저에만 저장되고, 실패 시 Gemini로 자동 폴백합니다.

## 기술 스택

빌드 과정 없는 정적 웹 (ESM + CDN):

```
Frontend   순수 JS 모듈 · Canvas 픽셀 스프라이트 · mermaid(다이어그램)
Auth       Firebase Authentication (이메일/비밀번호)
DB         Cloud Firestore (실시간 구독)
AI         Firebase AI Logic (Gemini) + OpenAI 호환 API (Hermes)
Hosting    Firebase Hosting
```

| 파일 | 역할 |
|---|---|
| `public/ar-app.js` | 메인 컨트롤러 (UI·명령어·이벤트) |
| `public/ar-store.js` | Firestore 데이터 계층 (실시간 구독·기억) |
| `public/ar-ai.js` | 에이전트 두뇌 (프로바이더 계층·셀프러닝) |
| `public/ar-game.js` `ar-sprites.js` | 성장 로직 · 절차적 8-bit 렌더러 |
| `public/ar-export.js` | 내보내기 (5개 포맷) |
| `firestore.rules` | 보안 규칙 |

## 로컬에서 실행

```bash
npx http-server public -p 5173 -c-1
```

Firebase 프로젝트를 직접 쓰려면 `public/firebase-config.js`의 설정을 본인 것으로 교체하고 `firestore.rules`를 배포하세요.

```bash
npx firebase-tools deploy --only firestore:rules,hosting
```

## 문서

| 문서 | 내용 |
|---|---|
| [AgentRoom_비전.md](AgentRoom_비전.md) | 비전 v1.0 — 조직의 망각, 망각률 δ, 시장 전략 |
| [비전_토론_기업가10인.md](비전_토론_기업가10인.md) | 기업가 10인 원탁토론 (승격 모델의 기원) |
| [개선_로드맵_종합.md](개선_로드맵_종합.md) | 타깃 유저·전문가 8인 평의회 개선 로드맵 |
| [개선_평의회_8인_전문.md](개선_평의회_8인_전문.md) | 평의회 전문 |
| [샤크탱크_심사_종합리포트.md](샤크탱크_심사_종합리포트.md) | 샤크탱크 6인 4라운드 심사 |

## 상태

**프로토타입** — 연세 UX 캠프 프로젝트. 실사용 트래픽 전 단계이며, 보안 규칙 강화·기억 회수 알고리즘 개선·카톡 내보내기 백필이 다음 로드맵입니다([개선_로드맵_종합.md](개선_로드맵_종합.md) 참조).

기밀 데이터를 넣기 전에 반드시 `firestore.rules`를 검토·강화하세요.

---

<sub>`public/fraud-shield.html`, `public/detect.*`, `public/evidence/`는 피보팅 전 프로젝트(AI 위변조 판별)의 보존 파일입니다.</sub>
