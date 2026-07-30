// motion.js — 스크롤 리빌 + 진입 애니메이션 (경량, 라이브러리 없음)
// 진행성 향상: JS가 있을 때만 초기 숨김 클래스를 붙이므로 JS/모션이 없으면 그냥 보입니다.
// prefers-reduced-motion을 존중합니다.

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const targets = Array.from(
  document.querySelectorAll(
    ".section-head, .cards, .compare-grid, .evidence-row, #bench-btn, .bench-result, .waitlist-form"
  )
);

if (!reduce && "IntersectionObserver" in window) {
  targets.forEach((el, i) => {
    el.classList.add("reveal-init");
    // evidence-row는 순차 등장 느낌을 위해 약간의 지연
    if (el.classList.contains("evidence-row")) {
      el.style.transitionDelay = (i % 5) * 70 + "ms";
    }
  });
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("revealed");
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
  );
  targets.forEach((el) => io.observe(el));
}
