// ar-game.js — AgentRoom 게이미피케이션 (경험치 · 진화 단계)
//
// 어뷰징 방지 원칙(기획서 반영): 단순 메시지 수가 아니라
//  - 질문에 응답(도움 제공)   +ANSWER_EXP
//  - 새 지식 메모리 학습        +LEARN_EXP  (가장 큰 보상)
//  - 팀원 긍정 피드백(좋아요)   +PRAISE_EXP
// 로 경험치를 산정한다. "안녕", "ㅋㅋ" 도배로는 거의 자라지 않는다.

export const EXP = {
  ANSWER: 10,   // @멘션에 실제 답변
  LEARN: 25,    // 대화에서 새 지식을 학습(메모리 생성)
  PRAISE: 15,   // 사용자가 답변에 👍
};

// 진화 단계 정의. cumExp = 이 레벨에 도달하기 위한 누적 경험치 하한.
export const LEVELS = [
  { level: 1, key: "egg",       name: "알",       cumExp: 0,   blurb: "이제 막 놓인 알. 팀의 대화를 먹으며 깨어날 준비 중." },
  { level: 2, key: "hatchling", name: "부화",     cumExp: 60,  blurb: "알을 깨고 나온 아기 에이전트. 세상이 궁금하다." },
  { level: 3, key: "growth",    name: "성장기",   cumExp: 200, blurb: "쑥쑥 자라는 중. 팀 지식이 몸에 쌓이고 있다." },
  { level: 4, key: "adult",     name: "성숙기",   cumExp: 480, blurb: "완전히 성숙한 에이전트. 팀의 집단지성 그 자체." },
];

export function levelForExp(exp) {
  let cur = LEVELS[0];
  for (const l of LEVELS) if (exp >= l.cumExp) cur = l;
  return cur;
}

export function levelInfo(level) {
  return LEVELS.find((l) => l.level === level) || LEVELS[0];
}

// 다음 레벨까지의 진행도(0~1)와 표시용 수치
export function progress(exp) {
  const cur = levelForExp(exp);
  const next = LEVELS.find((l) => l.level === cur.level + 1);
  if (!next) {
    return { cur, next: null, ratio: 1, into: exp - cur.cumExp, span: 0 };
  }
  const span = next.cumExp - cur.cumExp;
  const into = exp - cur.cumExp;
  return { cur, next, ratio: Math.max(0, Math.min(1, into / span)), into, span };
}
