// report.js — 원장님용 주간 수업 현황 보고서 생성 + 누락 항목 검사
// 보고서는 브라우저 메모리에서만 만들어지고 인쇄(PDF 저장)로만 나간다.
// 저장소에는 절대 커밋되지 않는다 (실명·점수 포함).
import { el } from "./ui.js";
import { sortWeeks, sortQuizzes, ATTENDANCE, ATTENDANCE_ORDER, toYMD, isNoShow } from "./store.js";

// 입력:
//   academyName, weeks(학원 blob), quizzes(학원 blob의 단원 퀴즈 목록),
//   weekId(보고 대상 주차 W), students: [{name, blob}] (활성 학생),
//   notices(학원 blob), teacherName, dirty(발행 안 된 변경 존재 여부)
// 반환: { checks: [{level:'ok'|'warn'|'info', text}], doc: HTMLElement }
export function buildDirectorReport({
  academyName,
  weeks,
  quizzes,
  weekId,
  students,
  notices,
  teacherName,
  dirty,
}) {
  const sorted = sortWeeks(weeks);
  const wIdx = sorted.findIndex((w) => w.id === weekId);
  const W = sorted[wIdx];
  const P = wIdx > 0 ? sorted[wIdx - 1] : null; // 저번 주차
  const weekOrder = new Map(sorted.map((w, i) => [w.id, i]));
  const allQuizzes = sortQuizzes(quizzes, weeks);

  const checks = [];
  const warn = (text) => checks.push({ level: "warn", text });
  const info = (text) => checks.push({ level: "info", text });

  const doc = el("div", { class: "report-doc" });
  let secNo = 0;
  const section = (title, children) =>
    el("div", { class: "rd-section" }, [
      el("div", { class: "rd-sec-head" }, [
        el("span", { class: "rd-num", text: String(++secNo) }),
        el("h2", { text: title }),
      ]),
      ...children,
    ]);

  // ---------- 헤더 ----------
  const today = toYMD(new Date());
  doc.appendChild(
    el("div", { class: "rd-header" }, [
      el("div", { class: "rd-head-main" }, [
        el("span", { class: "rd-academy-chip", text: academyName }),
        el("h1", { text: "주간 수업 현황 보고서" }),
        el("div", {
          class: "rd-meta",
          text: `작성 ${teacherName || "담당 교사"} · 생성일 ${today}`,
        }),
      ]),
      el("div", { class: "rd-week-box" }, [
        el("div", { class: "rd-week-label", text: "보고 주차" }),
        el("div", { class: "rd-week", text: W.label }),
      ]),
    ])
  );

  // ---------- ① 수업 진도 (W) ----------
  const progress = (W.progress || "").trim();
  if (!progress) warn("이번 주 진도가 입력되지 않았습니다 ('진도' 탭에서 입력).");
  doc.appendChild(
    section("수업 진도", [
      progress
        ? el("p", { class: "rd-text rd-progress", text: progress })
        : el("p", { class: "rd-empty", text: "(입력되지 않음)" }),
    ])
  );

  // ---------- ② 출석 현황 (W) ----------
  const attChildren = [];
  const sessions = W.sessions || [];
  if (!sessions.length) {
    warn("이번 주 수업일이 등록되지 않았습니다 ('주차 관리'에서 입력).");
    attChildren.push(el("p", { class: "rd-empty", text: "(수업일 미등록)" }));
  } else {
    const missing = [];
    const tally = Object.fromEntries(ATTENDANCE_ORDER.map((c) => [c, 0]));
    let blank = 0;
    const tbl = el("table", { class: "rd-table" });
    tbl.appendChild(
      el("tr", {}, [
        el("th", { text: "이름" }),
        ...sessions.map((d) => el("th", { text: d.slice(5).replace("-", "/") })),
      ])
    );
    for (const s of students) {
      const att = s.blob.weeks?.[W.id]?.attendance || {};
      const row = el("tr", {}, [el("td", { class: "rd-name", text: s.name })]);
      for (const d of sessions) {
        const code = att[d];
        const a = ATTENDANCE[code];
        if (a) {
          tally[code]++;
          row.appendChild(
            el("td", {}, [el("span", { class: `rd-chip ${a.cls}`, text: a.label })])
          );
        } else {
          blank++;
          missing.push(`${s.name}(${d.slice(5).replace("-", "/")})`);
          row.appendChild(el("td", {}, [el("span", { class: "rd-dash", text: "–" })]));
        }
      }
      tbl.appendChild(row);
    }
    if (missing.length) warn(`출석 미입력: ${missing.join(", ")}`);
    const parts = ATTENDANCE_ORDER.filter((c) => tally[c] > 0).map(
      (c) => `${ATTENDANCE[c].label} ${tally[c]}`
    );
    if (blank) parts.push(`미입력 ${blank}`);
    attChildren.push(el("div", { class: "rd-table-wrap" }, [tbl]));
    attChildren.push(el("p", { class: "rd-note", text: parts.length ? `집계 · ${parts.join(" · ")}` : "기록 없음" }));
  }
  doc.appendChild(section("출석 현황", attChildren));

  // ---------- ③ 지난 주 숙제 수행 (P) ----------
  if (!P) {
    info("이전 주차가 없어 숙제·퀴즈 섹션은 표시되지 않습니다 (첫 주차).");
  } else {
    const hwChildren = [];
    const items = P.homework || [];
    if (!items.length) {
      warn(`지난 주(${P.label})에 등록된 숙제 항목이 없습니다.`);
      hwChildren.push(el("p", { class: "rd-empty", text: "(숙제 항목 없음)" }));
    } else {
      hwChildren.push(
        el("ol", { class: "rd-list" }, items.map((it) => el("li", { text: it.text })))
      );
      const tbl = el("table", { class: "rd-table" });
      tbl.appendChild(
        el("tr", {}, [
          el("th", { text: "이름" }),
          ...items.map((_, i) => el("th", { text: `${i + 1}번` })),
          el("th", { text: "완료율" }),
        ])
      );
      let doneAll = 0;
      let denomAll = 0;
      let holdAll = 0;
      const holdNames = [];
      for (const s of students) {
        const hw = s.blob.weeks?.[P.id]?.homework || {};
        const done = items.filter((it) => hw[it.id] === true).length;
        const holds = items.filter((it) => isNoShow(hw, it.id)).length;
        if (holds) {
          holdAll += holds;
          holdNames.push(s.name);
        }
        const denom = items.length - holds;
        doneAll += done;
        denomAll += denom;
        const rate = denom ? Math.round((done / denom) * 100) : null;
        tbl.appendChild(
          el("tr", {}, [
            el("td", { class: "rd-name", text: s.name }),
            ...items.map((it) =>
              el("td", {}, [
                hw[it.id] === true
                  ? el("span", { class: "rd-check", text: "✓" })
                  : isNoShow(hw, it.id)
                    ? el("span", { class: "rd-hold", text: "◌" })
                    : el("span", { class: "rd-dash", text: "–" }),
              ])
            ),
            el("td", { class: "rd-rate" }, [
              rate == null
                ? el("span", { class: "rd-hold", text: "확인 전" })
                : el("span", { class: "rd-bar", "aria-hidden": "true" }, [
                    el("span", { class: "rd-bar-fill", style: `width:${rate}%` }),
                  ]),
              rate == null ? null : el("span", { text: `${rate}%` }),
            ]),
          ])
        );
      }
      const totalRate = denomAll ? Math.round((doneAll / denomAll) * 100) : 0;
      hwChildren.push(el("div", { class: "rd-table-wrap" }, [tbl]));
      hwChildren.push(
        el("p", {
          class: "rd-note",
          text:
            `전체 완료율 · ${totalRate}%` +
            (holdAll ? ` (◌ 확인 전 ${holdAll}건은 결석 등으로 제외)` : ""),
        })
      );
      if (holdAll) {
        info(`지난 주 숙제 '확인 전(◌)' — ${holdNames.join(", ")}: 다음 수업에서 확인 후 체크하세요.`);
      }
    }
    doc.appendChild(section(`지난 주 숙제 수행 — ${P.label}`, hwChildren));

    // ---------- ④ 지난 주 단원 퀴즈 결과 + 자동 분석 (P) ----------
    const quizChildren = [];
    const quizzesP = allQuizzes.filter((q) => q.weekId === P.id);

    // 추이 데이터: P 주차까지 응시한 모든 단원 퀴즈의 반 평균
    const trendData = allQuizzes
      .filter((q) => weekOrder.has(q.weekId) && weekOrder.get(q.weekId) <= weekOrder.get(P.id))
      .map((q) => ({ label: q.unit, avg: quizAvg(q, students), isP: q.weekId === P.id }))
      .filter((d) => d.avg != null);

    if (!quizzesP.length) {
      warn(`지난 주(${P.label})에 등록된 단원 퀴즈가 없습니다.`);
      quizChildren.push(el("p", { class: "rd-empty", text: "(지난 주 퀴즈 없음)" }));
    } else {
      // 퀴즈별 통계 (미응시 = null 저장 → 평균 제외·경고 아님 / 키 없음 = 미입력 → 경고)
      const perQuiz = quizzesP.map((q) => {
        const scores = students.map((s) => s.blob.quizzes?.[q.id]).filter((v) => v != null);
        const noshow = students.filter((s) => isNoShow(s.blob.quizzes, q.id)).map((s) => s.name);
        const missing = students
          .filter((s) => s.blob.quizzes?.[q.id] == null && !isNoShow(s.blob.quizzes, q.id))
          .map((s) => s.name);
        return {
          q,
          scores,
          noshow,
          missing,
          avg: scores.length ? round1(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
          hi: scores.length ? Math.max(...scores) : null,
          lo: scores.length ? Math.min(...scores) : null,
        };
      });
      for (const pq of perQuiz) {
        if (!pq.scores.length) warn(`「${pq.q.unit}」 퀴즈 점수가 하나도 입력되지 않았습니다.`);
        else if (pq.missing.length) warn(`「${pq.q.unit}」 점수 미입력: ${pq.missing.join(", ")}`);
        if (pq.noshow.length) info(`「${pq.q.unit}」 미응시(결석 등): ${pq.noshow.join(", ")} — 평균에서 제외됩니다.`);
      }

      // 단일 퀴즈면 통계 타일(학원 vs 전체), 복수면 퀴즈별 요약 줄
      if (perQuiz.length === 1 && perQuiz[0].scores.length) {
        const pq = perQuiz[0];
        const g = pq.q.stats; // 전체 평균 (같은 단원명 퀴즈의 전 학원 합산)
        quizChildren.push(
          el("div", { class: "rd-stats" }, [
            statTile("학원 평균", `${pq.avg}점`, `응시 ${pq.scores.length}명`),
            statTile("전체 평균", g?.avg != null ? `${g.avg}점` : "–", g ? `합산 ${g.count}명` : ""),
            statTile("최고", `${pq.hi}점`),
            statTile("최저", `${pq.lo}점`, `만점 ${pq.q.max || 100}점`),
          ])
        );
        if (pq.noshow.length) {
          quizChildren.push(
            el("p", { class: "rd-note", text: `미응시(결석 등) · ${pq.noshow.join(", ")} — 평균에서 제외` })
          );
        }
      }

      // 통합 점수표: 이름 | 단원1 | 단원2 …
      const tbl = el("table", { class: "rd-table rd-quiz-table" });
      tbl.appendChild(
        el("tr", {}, [
          el("th", { text: "이름" }),
          ...quizzesP.map((q) => el("th", { text: `${q.unit} (${q.max || 100}점)` })),
        ])
      );
      for (const s of students) {
        tbl.appendChild(
          el("tr", {}, [
            el("td", { class: "rd-name", text: s.name }),
            ...quizzesP.map((q) => {
              const v = s.blob.quizzes?.[q.id];
              if (v != null) return el("td", { class: "rd-score", text: String(v) });
              return el("td", { class: "rd-score" }, [
                isNoShow(s.blob.quizzes, q.id)
                  ? el("span", { class: "rd-noshow", text: "미응시" })
                  : el("span", { class: "rd-dash", text: "–" }),
              ]);
            }),
          ])
        );
      }
      quizChildren.push(el("div", { class: "rd-table-wrap" }, [tbl]));

      if (perQuiz.length > 1) {
        for (const pq of perQuiz.filter((x) => x.scores.length)) {
          const g = pq.q.stats;
          quizChildren.push(
            el("p", {
              class: "rd-note",
              text:
                `「${pq.q.unit}」 응시 ${pq.scores.length}명 · 학원 평균 ${pq.avg}점` +
                (g?.avg != null ? ` · 전체 평균 ${g.avg}점(합산 ${g.count}명)` : "") +
                ` · 최고 ${pq.hi}점 · 최저 ${pq.lo}점 (만점 ${pq.q.max || 100}점)` +
                (pq.noshow.length ? ` · 미응시 ${pq.noshow.length}명` : ""),
            })
          );
        }
      }

      // 자동 분석: 퀴즈별 문장 — 전체 평균 대비 + 직전 단원 퀴즈 대비
      const sentences = [];
      for (const pq of perQuiz.filter((x) => x.scores.length)) {
        const g = pq.q.stats;
        let vsAll = "";
        if (g?.avg != null && g.count > pq.scores.length) {
          const d = round1(pq.avg - g.avg);
          vsAll =
            d > 0
              ? ` 두 학원 전체 평균(${g.avg}점)보다 ${d}점 높습니다.`
              : d < 0
                ? ` 두 학원 전체 평균(${g.avg}점)보다 ${Math.abs(d)}점 낮습니다.`
                : ` 두 학원 전체 평균(${g.avg}점)과 같습니다.`;
        }
        const i = trendData.findIndex((d) => d.label === pq.q.unit && d.avg === pq.avg);
        let trend = "";
        if (i > 0) {
          const prev = trendData[i - 1];
          const diff = round1(pq.avg - prev.avg);
          trend =
            diff > 0
              ? ` 직전 퀴즈 「${prev.label}」(학원 평균 ${prev.avg}점)보다 ${diff}점 상승했습니다.`
              : diff < 0
                ? ` 직전 퀴즈 「${prev.label}」(학원 평균 ${prev.avg}점)보다 ${Math.abs(diff)}점 하락했습니다.`
                : ` 직전 퀴즈 「${prev.label}」(학원 평균 ${prev.avg}점)과 동일합니다.`;
        }
        sentences.push(
          `「${pq.q.unit}」 응시 ${pq.scores.length}명 학원 평균 ${pq.avg}점(만점 ${pq.q.max || 100}점), 최고 ${pq.hi}점 · 최저 ${pq.lo}점, 편차 ${pq.hi - pq.lo}점.${vsAll}${trend}`
        );
      }
      if (sentences.length) {
        quizChildren.push(
          el("div", { class: "rd-callout" }, [
            el("strong", { text: "분석 " }),
            el("span", { text: sentences.join(" ") }),
          ])
        );
      }
    }

    if (trendData.length >= 2) {
      quizChildren.push(el("h3", { class: "rd-h3", text: "단원별 학원 평균 추이" }));
      quizChildren.push(renderTrend(trendData, Math.max(100, ...allQuizzes.map((q) => q.max || 0))));
    }
    doc.appendChild(section(`지난 주 단원 퀴즈 결과 — ${P.label}`, quizChildren));
  }

  // ---------- ⑤ 공지사항 (W 기간 + 고정) ----------
  const noticeChildren = [];
  const from = sessions.length ? sessions[0] : null;
  const to = sessions.length ? sessions[sessions.length - 1] : null;
  const included = (notices || []).filter(
    (n) => n.pinned || (from && to && n.date >= from && n.date <= to)
  );
  if (!included.length) {
    info("이 주차 기간에 해당하는 공지가 없습니다.");
    noticeChildren.push(el("p", { class: "rd-empty", text: "(해당 기간 공지 없음)" }));
  } else {
    for (const n of included) {
      noticeChildren.push(
        el("div", { class: "rd-notice" }, [
          el("div", { class: "rd-notice-title" }, [
            n.pinned ? el("span", { class: "rd-pin", text: "고정" }) : null,
            el("span", { text: n.title }),
            el("span", { class: "rd-notice-date", text: n.date || "" }),
          ]),
          n.body ? el("div", { class: "rd-text", text: n.body }) : null,
        ])
      );
    }
  }
  doc.appendChild(section("공지사항", noticeChildren));

  // ---------- 푸터 ----------
  doc.appendChild(
    el("div", { class: "rd-footer", text: `본 보고서는 학습 포털에서 자동 생성되었습니다 · ${today}` })
  );

  // ---------- 검사 결과 정리 ----------
  if (dirty) info("발행하지 않은 변경이 있습니다 — 보고서는 현재 편집 중인 내용 기준으로 생성됩니다.");
  if (!checks.some((c) => c.level === "warn")) {
    checks.unshift({ level: "ok", text: "모든 항목이 준비되었습니다. PDF로 저장해 보내세요." });
  }
  return { checks, doc };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function statTile(label, value, sub) {
  return el("div", { class: "rd-stat" }, [
    el("div", { class: "rd-stat-label", text: label }),
    el("div", { class: "rd-stat-value", text: value }),
    sub ? el("div", { class: "rd-stat-sub", text: sub }) : null,
  ]);
}

// 퀴즈의 "학원 평균" — 이 학원 학생 점수로 직접 계산.
// (quiz.stats는 두 학원 합산 전체 평균이므로 여기서 쓰지 않는다)
function quizAvg(quiz, students) {
  const scores = students.map((s) => s.blob.quizzes?.[quiz.id]).filter((v) => v != null);
  if (!scores.length) return null;
  return round1(scores.reduce((a, b) => a + b, 0) / scores.length);
}

// 단원별 반 평균 추이 미니 차트 (단일 계열 — 제목이 곧 범례, 점 위 직접 라벨)
function renderTrend(data, maxScore) {
  const W = 360;
  const H = 110;
  const M = { top: 22, right: 18, bottom: 20, left: 18 };
  const n = data.length;
  const vals = data.map((d) => d.avg);
  const lo = Math.max(0, Math.min(...vals) - 8);
  const hi = Math.min(maxScore, Math.max(...vals) + 8);
  const x = (i) => M.left + (n === 1 ? (W - M.left - M.right) / 2 : (i / (n - 1)) * (W - M.left - M.right));
  const y = (v) => M.top + (H - M.top - M.bottom) * (1 - (v - lo) / Math.max(1, hi - lo));

  // 라벨: 6개 이하면 전부, 많으면 처음/끝/최고/최저만
  const labelIdx = new Set();
  if (n <= 6) for (let i = 0; i < n; i++) labelIdx.add(i);
  else {
    labelIdx.add(0);
    labelIdx.add(n - 1);
    labelIdx.add(vals.indexOf(Math.max(...vals)));
    labelIdx.add(vals.indexOf(Math.min(...vals)));
  }

  let s = `<line x1="${M.left - 6}" y1="${H - M.bottom}" x2="${W - M.right + 6}" y2="${H - M.bottom}" stroke="#c3c2b7" stroke-width="1"/>`;
  s += `<polyline points="${data.map((d, i) => `${x(i)},${y(d.avg)}`).join(" ")}" fill="none" stroke="#2a78d6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  data.forEach((d, i) => {
    s += `<circle cx="${x(i)}" cy="${y(d.avg)}" r="${d.isP ? 4.5 : 3.5}" fill="#2a78d6" stroke="#ffffff" stroke-width="2"/>`;
    if (labelIdx.has(i)) {
      s += `<text x="${x(i)}" y="${y(d.avg) - 8}" text-anchor="middle" font-size="9.5" font-weight="${d.isP ? 700 : 400}" fill="#0b0b0b">${d.avg}</text>`;
    }
    const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    const every = Math.max(1, Math.ceil(n / 4));
    // 마지막 라벨과 겹치는 직전 라벨은 건너뛴다 (chart.js와 동일 규칙)
    if (i === n - 1 || (i % every === 0 && n - 1 - i >= every)) {
      s += `<text x="${x(i)}" y="${H - M.bottom + 13}" text-anchor="${anchor}" font-size="9" fill="#898781">${escapeXML(shorten(d.label))}</text>`;
    }
  });

  const box = el("div", { class: "rd-chart" });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="단원별 반 평균 추이" style="width:100%;height:auto;display:block">${s}</svg>`;
  return box;
}

function shorten(label) {
  const t = String(label);
  return t.length > 7 ? t.slice(0, 6) + "…" : t;
}

function escapeXML(t) {
  return String(t).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
