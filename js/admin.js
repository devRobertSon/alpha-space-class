// admin.js — 선생님 관리 페이지 컨트롤러
// 구조: 마스터 비밀번호 로그인 → 전체 데이터 복호화(인메모리 모델) → 편집 → 발행(재암호화)
import {
  FORMAT_VERSION,
  deriveMasterKey,
  deriveStudentKeys,
  decryptJSON,
  encryptJSON,
  encryptBytes,
  decryptBytes,
  importAesKeyB64,
  exportAesKeyB64,
  generateCode,
  randomHexId,
  randomKeyB64,
  randomSaltB64,
  normalizePassword,
  b64encode,
} from "./crypto.js";
import { fetchJSON, fetchBytes, metaExists, sortWeeks, sortQuizzes, weekLabelOf, isoWeekId, toYMD, homeworkShareText, formatBytes, ATTENDANCE, ATTENDANCE_ORDER, isNoShow } from "./store.js";
import { $, el, clear, toast, confirmModal, copyText, setBusy } from "./ui.js";
import { runWizard, createStudent, emptyStudentBlob, emptyAcademyBlob, printCodeCards } from "./setup.js";
import { buildDirectorReport } from "./report.js";
import { publishToGitHub, guessRepoFromLocation } from "./github.js";
import { buildZip, downloadBlob } from "./zip.js";

const mount = $("#admin");

// ---------- 인메모리 모델 ----------
const S = {
  meta: null,
  roster: null,
  academies: new Map(), // fileId -> blob
  students: new Map(), // fileId -> blob
  masterKey: null,
  dirtyStudents: new Set(),
  dirtyAcademies: new Set(),
  rosterDirty: false,
  pendingUploads: new Map(), // path -> {bytes: Uint8Array, academyFileId}
  pendingDeletes: new Set(), // path
  // UI 상태
  selAcademy: null,
  selWeek: new Map(), // academyFileId -> weekId
  selQuiz: new Map(), // academyFileId -> quizId
  zipDownloaded: false,
  // 이 세션이 불러왔거나 스스로 만든 발행 시각들 — 발행 직전에 사이트의 발행 시각이
  // 여기 없으면 다른 탭/기기의 발행을 덮어쓰는 상황이므로 경고한다
  ownPublishedAts: new Set(),
};

const dirtyCount = () =>
  S.dirtyStudents.size +
  S.dirtyAcademies.size +
  (S.rosterDirty ? 1 : 0) +
  S.pendingUploads.size +
  S.pendingDeletes.size;

function markStudent(fileId) {
  S.dirtyStudents.add(fileId);
  updateBadge();
}
function markAcademy(fileId) {
  S.dirtyAcademies.add(fileId);
  updateBadge();
}
function markRoster() {
  S.rosterDirty = true;
  updateBadge();
}

window.addEventListener("beforeunload", (e) => {
  if (dirtyCount() > 0 && !S.zipDownloaded) {
    e.preventDefault();
    e.returnValue = "";
  }
});

init();

async function init() {
  if (!globalThis.crypto?.subtle) {
    clear(mount).appendChild(
      el("div", { class: "admin-container" }, [
        el("div", { class: "card" }, [
          el("h2", { text: "보안 컨텍스트가 아닙니다" }),
          el("p", {
            text: "암호화 기능은 https 또는 localhost에서만 동작합니다. file:// 로 열지 말고 로컬 서버(python3 -m http.server)나 GitHub Pages에서 열어 주세요.",
          }),
        ]),
      ])
    );
    return;
  }
  const exists = await metaExists();
  if (!exists) {
    renderWizardIntro();
  } else {
    renderLogin();
  }
}

// ---------- 초기 설정 ----------
function renderWizardIntro() {
  const container = el("div", { class: "admin-container" });
  container.appendChild(
    el("div", { class: "card" }, [
      el("h2", { text: "처음 오셨네요! 초기 설정을 시작합니다" }),
      el("p", {
        class: "hint",
        text: "마스터 비밀번호, 학원, 학생 명단을 등록하면 학생별 접속 코드와 암호화된 데이터 파일이 만들어집니다. 마지막에 '발행'하면 사이트가 열립니다.",
      }),
      el("button", { class: "btn btn-primary", text: "초기 설정 시작", onclick: startWizard }),
    ])
  );
  clear(mount).appendChild(container);
}

function startWizard() {
  const container = el("div", { class: "admin-container" });
  clear(mount).appendChild(container);
  runWizard(container, {
    siteURL: location.origin + location.pathname.replace(/admin\.html.*$/, ""),
    onComplete: (model) => {
      S.meta = model.meta;
      S.roster = model.roster;
      S.academies = model.academies;
      S.students = model.students;
      S.masterKey = model.masterKey;
      // 이전 상태(재설정 경로 포함) 정리 후 전부 새 데이터 → 전부 dirty
      clearDirty();
      for (const id of S.students.keys()) S.dirtyStudents.add(id);
      for (const id of S.academies.keys()) S.dirtyAcademies.add(id);
      S.rosterDirty = true;
      renderMain();
      toast("생성 완료! '학생 관리'에서 코드 카드를 인쇄하고, '발행' 탭에서 사이트에 올려 주세요.", "ok");
    },
  });
}

// ---------- 로그인 ----------
function renderLogin(errorMsg) {
  const pw = el("input", { type: "password", autocomplete: "current-password" });
  const err = el("p", { class: "error-text", text: errorMsg || "" });
  const btn = el("button", { class: "btn btn-primary btn-block", text: "잠금 해제" });

  const submit = async () => {
    btn.disabled = true;
    btn.textContent = "확인 중… (몇 초 걸립니다)";
    try {
      await loadAll(pw.value);
      renderMain();
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      btn.textContent = "잠금 해제";
      err.textContent =
        e.name === "OperationError"
          ? "비밀번호가 올바르지 않습니다."
          : "불러오기 실패: " + e.message;
    }
  };
  btn.addEventListener("click", submit);
  pw.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  const container = el("div", { class: "admin-container" }, [
    el("div", { class: "card", style: "max-width:420px;margin:48px auto" }, [
      el("h2", { text: "관리 페이지" }),
      el("p", { class: "hint", text: "마스터 비밀번호를 입력해 주세요." }),
      el("label", { class: "field" }, [pw]),
      err,
      btn,
      el("hr", { style: "border:none;border-top:1px solid var(--hairline);margin:16px 0" }),
      el("button", { class: "btn btn-small", text: "백업 파일로 복원 (비밀번호 분실 시)", onclick: renderRestore }),
      el("div", { style: "height:8px" }),
      el("button", {
        class: "btn btn-small",
        text: "🧹 처음부터 다시 설정 (초기 설정 마법사)",
        onclick: async () => {
          const ok = await confirmModal({
            title: "초기 설정 다시 실행",
            body: "기존 데이터(샘플 포함)를 새 데이터로 교체합니다. 발행하면 기존 학생 코드는 모두 무효가 되고 코드 카드를 다시 배부해야 합니다. 계속할까요?",
            okText: "다시 설정",
            danger: true,
          });
          if (ok) startWizard();
        },
      }),
    ]),
  ]);
  clear(mount).appendChild(container);
  pw.focus();
}

async function loadAll(password) {
  S.meta = await fetchJSON("data/meta.json");
  S.ownPublishedAts = new Set(S.meta.publishedAt ? [S.meta.publishedAt] : []);
  S.masterKey = await deriveMasterKey(password, S.meta.saltMaster, S.meta.kdf.iterMaster);
  const rosterEnv = await fetchJSON("data/roster.json");
  S.roster = await decryptJSON(S.masterKey, rosterEnv); // 실패 시 OperationError = 비밀번호 오류

  S.academies = new Map();
  for (const a of S.roster.academies) {
    const key = await importAesKeyB64(a.key);
    try {
      const env = await fetchJSON(`data/a/${a.fileId}.json`);
      S.academies.set(a.fileId, await decryptJSON(key, env));
    } catch {
      // 아직 발행 전인 학원 → 빈 blob
      S.academies.set(a.fileId, emptyAcademyBlob(a.name));
      S.dirtyAcademies.add(a.fileId);
    }
  }
  S.students = new Map();
  for (const st of S.roster.students) {
    const key = await importAesKeyB64(st.encKey);
    const aEntry = S.roster.academies.find((a) => a.fileId === st.academyFileId);
    try {
      const env = await fetchJSON(`data/s/${st.fileId}.json`);
      S.students.set(st.fileId, await decryptJSON(key, env));
    } catch {
      S.students.set(st.fileId, emptyStudentBlob(st.name, aEntry));
      S.dirtyStudents.add(st.fileId);
    }
  }
}

// ---------- 백업 복원 ----------
function renderRestore() {
  const file = el("input", { type: "file", accept: "application/json" });
  const pw1 = el("input", { type: "password", autocomplete: "new-password" });
  const pw2 = el("input", { type: "password", autocomplete: "new-password" });
  const err = el("p", { class: "error-text" });
  const container = el("div", { class: "admin-container" }, [
    el("div", { class: "card", style: "max-width:480px;margin:48px auto" }, [
      el("h2", { text: "백업에서 복원" }),
      el("p", {
        class: "hint",
        text: "'발행' 탭에서 내려받은 백업 JSON 파일과 새 마스터 비밀번호를 입력하세요. 학생 코드는 그대로 유지됩니다. 복원 후 반드시 '발행'해야 적용됩니다.",
      }),
      el("label", { class: "field" }, [el("span", { text: "백업 파일" }), file]),
      el("label", { class: "field" }, [el("span", { text: "새 마스터 비밀번호 (12자 이상)" }), pw1]),
      el("label", { class: "field" }, [el("span", { text: "비밀번호 확인" }), pw2]),
      err,
      el("button", {
        class: "btn btn-primary btn-block",
        text: "복원하기",
        onclick: async () => {
          try {
            const p = normalizePassword(pw1.value);
            if (p.length < 12) throw new Error("비밀번호는 12자 이상이어야 합니다.");
            if (p !== normalizePassword(pw2.value)) throw new Error("두 비밀번호가 일치하지 않습니다.");
            if (!file.files[0]) throw new Error("백업 파일을 선택해 주세요.");
            const backup = JSON.parse(await file.files[0].text());
            if (!backup.meta || !backup.roster) throw new Error("올바른 백업 파일이 아닙니다.");
            S.meta = backup.meta;
            S.ownPublishedAts = new Set(backup.meta.publishedAt ? [backup.meta.publishedAt] : []);
            S.roster = backup.roster;
            S.academies = new Map(Object.entries(backup.academies || {}));
            S.students = new Map(Object.entries(backup.students || {}));
            // 새 마스터 비밀번호로 교체
            S.meta.saltMaster = randomSaltB64();
            S.masterKey = await deriveMasterKey(p, S.meta.saltMaster, S.meta.kdf.iterMaster);
            for (const id of S.students.keys()) S.dirtyStudents.add(id);
            for (const id of S.academies.keys()) S.dirtyAcademies.add(id);
            S.rosterDirty = true;
            renderMain();
            toast("복원되었습니다. '발행' 탭에서 발행해야 사이트에 반영됩니다.", "ok");
          } catch (e) {
            err.textContent = e.message;
          }
        },
      }),
      el("button", { class: "btn btn-small", text: "← 돌아가기", onclick: () => renderLogin() }),
    ]),
  ]);
  clear(mount).appendChild(container);
}

// ---------- 메인 UI ----------
let badgeEl = null;
let contentEl = null;
let activeTab = "students";

function updateBadge() {
  if (!badgeEl) return;
  const n = dirtyCount();
  badgeEl.textContent = n > 0 ? `발행하지 않은 변경 ${n}건` : "모든 변경 발행됨";
  badgeEl.className = n > 0 ? "dirty-badge" : "dirty-badge clean";
}

function renderMain() {
  if (!S.selAcademy || !S.roster.academies.some((a) => a.fileId === S.selAcademy)) {
    S.selAcademy = S.roster.academies[0]?.fileId || null;
  }
  const container = el("div", { class: "admin-container" });
  badgeEl = el("span", { class: "dirty-badge" });
  container.appendChild(
    el("div", { class: "admin-header" }, [
      el("h1", { text: `🗝️ 관리 페이지` }),
      el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" }, [
        badgeEl,
        el("button", { class: "btn btn-small", text: "잠금", onclick: () => location.reload() }),
      ]),
    ])
  );

  const tabs = [
    ["students", "학생 관리"],
    ["scores", "점수 입력"],
    ["homework", "숙제 체크"],
    ["attendance", "출석"],
    ["reports", "리포트"],
    ["notices", "공지"],
    ["materials", "자료실"],
    ["progress", "진도"],
    ["director", "보고서"],
    ["publish", "발행"],
  ];
  const bar = el("div", { class: "tabbar" });
  const btns = new Map();
  for (const [id, label] of tabs) {
    const b = el("button", { class: "tab", text: label, onclick: () => selectTab(id) });
    btns.set(id, b);
    bar.appendChild(b);
  }
  container.appendChild(bar);
  contentEl = el("div");
  container.appendChild(contentEl);
  clear(mount).appendChild(container);

  function selectTab(id) {
    activeTab = id;
    for (const [tid, b] of btns) b.classList.toggle("active", tid === id);
    renderTab();
  }
  selectTab(activeTab);
  updateBadge();
}

function renderTab() {
  clear(contentEl);
  const render = {
    students: renderStudentsTab,
    scores: renderScoresTab,
    homework: renderHomeworkTab,
    attendance: renderAttendanceTab,
    reports: renderReportsTab,
    notices: renderNoticesTab,
    materials: renderMaterialsTab,
    progress: renderProgressTab,
    director: renderDirectorTab,
    publish: renderPublishTab,
  }[activeTab];
  render(contentEl);
}

// ---------- 공용: 학원/주차 선택 툴바 ----------
function academyEntry(fileId = S.selAcademy) {
  return S.roster.academies.find((a) => a.fileId === fileId);
}
function academyBlob(fileId = S.selAcademy) {
  return S.academies.get(fileId);
}
function activeStudentsOf(academyFileId) {
  return S.roster.students.filter((s) => s.academyFileId === academyFileId && s.active !== false);
}
function selectedWeek() {
  const blob = academyBlob();
  if (!blob) return null;
  const weeks = sortWeeks(blob.weeks);
  if (!weeks.length) return null;
  const wid = S.selWeek.get(S.selAcademy);
  return weeks.find((w) => w.id === wid) || weeks[weeks.length - 1];
}

function academyQuizzes(fileId = S.selAcademy) {
  const blob = S.academies.get(fileId);
  if (!blob) return [];
  blob.quizzes = blob.quizzes || [];
  return sortQuizzes(blob.quizzes, blob.weeks);
}

function selectedQuiz() {
  const list = academyQuizzes();
  if (!list.length) return null;
  const qid = S.selQuiz.get(S.selAcademy);
  return list.find((q) => q.id === qid) || list[list.length - 1];
}

function quizOptionLabel(q) {
  const wl = weekLabelOf(academyBlob()?.weeks, q.weekId).replace(/\s*\(.*\)\s*/, "");
  return `${q.unit} — ${wl || "주차 미정"}`;
}

// 학원 + 퀴즈(단원) 선택 툴바
function quizToolbar(container) {
  const bar = el("div", { class: "toolbar" });
  const aSel = el("select", { "aria-label": "학원 선택" });
  for (const a of S.roster.academies) {
    aSel.appendChild(el("option", { value: a.fileId, text: a.name, selected: a.fileId === S.selAcademy }));
  }
  aSel.addEventListener("change", () => {
    S.selAcademy = aSel.value;
    renderTab();
  });
  bar.appendChild(aSel);

  const qSel = el("select", { "aria-label": "퀴즈(단원) 선택" });
  const list = academyQuizzes();
  const cur = selectedQuiz();
  for (const q of list) {
    qSel.appendChild(el("option", { value: q.id, text: quizOptionLabel(q), selected: cur && q.id === cur.id }));
  }
  if (!list.length) qSel.appendChild(el("option", { text: "퀴즈 없음", value: "" }));
  qSel.addEventListener("change", () => {
    S.selQuiz.set(S.selAcademy, qSel.value);
    renderTab();
  });
  bar.appendChild(qSel);
  bar.appendChild(el("button", { class: "btn btn-small", text: "+ 새 퀴즈", onclick: () => editQuiz(null) }));
  if (cur) bar.appendChild(el("button", { class: "btn btn-small", text: "퀴즈 관리", onclick: () => editQuiz(cur) }));
  container.appendChild(bar);
}

// 같은 퀴즈(단원명·주차·만점)를 다른 학원들에도 만든다.
// weekId가 null이면 '주차 미정' 상태로 만든다 (주차 생성 불필요).
// 주차가 정해진 경우, 대상 학원에 같은 주차(id)가 없으면 주차도 함께 만든다 (수업일은 비워 둠).
// 같은 단원명이 이미 있으면 건너뛴다 — 전체 평균이 단원명 기준으로 합산되므로 중복 금지.
// 반환: { made: [학원명], weekMade: [학원명] }
function copyQuizToOtherAcademies(unit, weekId, max) {
  const norm = (s) => String(s || "").trim().replace(/\s+/g, " ");
  const srcWeek = weekId ? (academyBlob().weeks || []).find((w) => w.id === weekId) : null;
  const made = [];
  const weekMade = [];
  for (const a of S.roster.academies) {
    if (a.fileId === S.selAcademy) continue;
    const ab = S.academies.get(a.fileId);
    if (!ab) continue;
    if (weekId && srcWeek) {
      ab.weeks = ab.weeks || [];
      if (!ab.weeks.find((x) => x.id === weekId)) {
        ab.weeks.push({ id: srcWeek.id, label: srcWeek.label, sessions: [], homework: [], progress: "" });
        weekMade.push(a.name);
      }
    }
    ab.quizzes = ab.quizzes || [];
    if (ab.quizzes.some((x) => norm(x.unit) === norm(unit))) continue;
    ab.quizzes.push({ id: randomHexId(6), unit, weekId: weekId || null, max, stats: null });
    markAcademy(a.fileId);
    made.push(a.name);
  }
  return { made, weekMade };
}

function copyResultToast(unit, { made, weekMade }) {
  if (!made.length) {
    toast("다른 학원에 이미 같은 단원 퀴즈가 있습니다.", "ok");
    return;
  }
  let msg = `'${unit}' 퀴즈를 ${made.join(", ")}에도 만들었습니다.`;
  if (weekMade.length) msg += ` 주차도 함께 만들었으니 수업일은 '주차 관리'에서 입력하세요 (${weekMade.join(", ")}).`;
  toast(msg + " '발행'해야 반영됩니다.", "ok");
}

// 퀴즈(단원) 생성/편집/삭제 모달
// 응시 주차는 '미정'(weekId=null)으로 둘 수 있다 — 두 학원의 응시 시점이 다르거나
// 아직 날짜를 정하지 않은 퀴즈를 미리 등록하는 용도. 나중에 여기서 주차를 지정한다.
function editQuiz(quiz) {
  const blob = academyBlob();
  const weeks = sortWeeks(blob.weeks);
  const multiAcademy = S.roster.academies.length > 1;
  const unitIn = el("input", { type: "text", value: quiz?.unit || "", placeholder: "단원명 (예: 화학 — 몰 농도)" });
  const weekSel = el("select");
  // 기존 퀴즈는 저장된 주차(없으면 미정), 새 퀴즈는 현재 선택된 주차를 기본값으로
  const defaultWeek = quiz ? quiz.weekId || "" : selectedWeek()?.id || "";
  weekSel.appendChild(el("option", { value: "", text: "주차 미정 (나중에 지정)", selected: defaultWeek === "" }));
  for (const w of weeks) {
    weekSel.appendChild(el("option", { value: w.id, text: w.label, selected: w.id === defaultWeek }));
  }
  const maxIn = el("input", { type: "number", value: String(quiz?.max || 100), min: "1" });
  const allChk = el("input", { type: "checkbox", checked: true });
  const err = el("p", { class: "error-text" });
  const overlay = el("div", { class: "modal-overlay" });
  overlay.appendChild(
    el("div", { class: "modal" }, [
      el("h3", { text: quiz ? "퀴즈 관리" : "새 단원 퀴즈" }),
      el("p", {
        class: "hint",
        text: "같은 단원명의 퀴즈는 전체 평균이 두 학원 학생을 합쳐 계산됩니다.",
      }),
      el("label", { class: "field" }, [el("span", { text: "단원명" }), unitIn]),
      el("label", { class: "field" }, [el("span", { text: "응시 주차" }), weekSel]),
      el("label", { class: "field" }, [el("span", { text: "만점" }), maxIn]),
      !quiz && multiAcademy
        ? el("label", { class: "check" }, [allChk, "다른 학원에도 함께 만들기 (같은 단원·주차·만점)"])
        : null,
      quiz && multiAcademy
        ? el("button", {
            class: "btn btn-small",
            text: "이 퀴즈를 다른 학원으로 복사",
            onclick: () => {
              const unit = unitIn.value.trim();
              if (!unit) return (err.textContent = "단원명을 입력해 주세요.");
              const result = copyQuizToOtherAcademies(unit, weekSel.value || null, parseFloat(maxIn.value) || 100);
              copyResultToast(unit, result);
              overlay.remove();
              renderTab();
            },
          })
        : null,
      err,
      el("div", { class: "modal-actions" }, [
        quiz
          ? el("button", {
              class: "btn btn-danger",
              text: "삭제",
              onclick: async () => {
                overlay.remove();
                const ok = await confirmModal({
                  title: "퀴즈 삭제",
                  body: `'${quiz.unit}' 퀴즈를 삭제할까요? 모든 학생의 이 퀴즈 점수와 단원 리포트(PDF 포함)가 함께 삭제됩니다.`,
                  okText: "삭제",
                  danger: true,
                });
                if (!ok) return;
                deleteQuiz(quiz);
                renderTab();
              },
            })
          : null,
        el("button", { class: "btn", text: "취소", onclick: () => overlay.remove() }),
        el("button", {
          class: "btn btn-primary",
          text: "저장",
          onclick: () => {
            const unit = unitIn.value.trim();
            const max = parseFloat(maxIn.value) || 100;
            const weekId = weekSel.value || null; // "" = 주차 미정
            if (!unit) return (err.textContent = "단원명을 입력해 주세요.");
            if (quiz) {
              if (quiz.unit !== unit || quiz.weekId !== weekId || quiz.max !== max) {
                quiz.unit = unit;
                quiz.weekId = weekId;
                quiz.max = max;
                markAcademy(S.selAcademy);
              }
            } else {
              const q = { id: randomHexId(6), unit, weekId, max, stats: null };
              blob.quizzes = blob.quizzes || [];
              blob.quizzes.push(q);
              S.selQuiz.set(S.selAcademy, q.id);
              markAcademy(S.selAcademy);
              if (multiAcademy && allChk.checked) {
                copyResultToast(unit, copyQuizToOtherAcademies(unit, weekId, max));
              }
            }
            overlay.remove();
            renderTab();
          },
        }),
      ]),
    ])
  );
  document.body.appendChild(overlay);
  unitIn.focus();
}

// 퀴즈 삭제: 정의 + 모든 학생의 점수·단원 리포트(PDF 정리 포함)
function deleteQuiz(quiz) {
  const blob = academyBlob();
  blob.quizzes = (blob.quizzes || []).filter((q) => q.id !== quiz.id);
  markAcademy(S.selAcademy);
  for (const st of S.roster.students) {
    if (st.academyFileId !== S.selAcademy) continue;
    const sBlob = S.students.get(st.fileId);
    let touched = false;
    if (sBlob.quizzes && quiz.id in sBlob.quizzes) {
      delete sBlob.quizzes[quiz.id];
      touched = true;
    }
    const rep = sBlob.quizReports?.[quiz.id];
    if (rep) {
      if (rep.pdf) {
        if (S.pendingUploads.has(rep.pdf.path)) S.pendingUploads.delete(rep.pdf.path);
        else S.pendingDeletes.add(rep.pdf.path);
      }
      delete sBlob.quizReports[quiz.id];
      touched = true;
    }
    if (touched) markStudent(st.fileId);
  }
  recomputeStats();
  toast(`'${quiz.unit}' 퀴즈가 삭제되었습니다. '발행'해야 반영됩니다.`, "ok");
}

function toolbar(container, { withWeek = true } = {}) {
  const bar = el("div", { class: "toolbar" });
  const aSel = el("select", { "aria-label": "학원 선택" });
  for (const a of S.roster.academies) {
    aSel.appendChild(el("option", { value: a.fileId, text: a.name, selected: a.fileId === S.selAcademy }));
  }
  aSel.addEventListener("change", () => {
    S.selAcademy = aSel.value;
    renderTab();
  });
  bar.appendChild(aSel);

  if (withWeek) {
    const wSel = el("select", { "aria-label": "주차 선택" });
    const weeks = sortWeeks(academyBlob()?.weeks || []);
    const cur = selectedWeek();
    for (const w of weeks) {
      wSel.appendChild(el("option", { value: w.id, text: w.label, selected: cur && w.id === cur.id }));
    }
    if (!weeks.length) wSel.appendChild(el("option", { text: "주차 없음", value: "" }));
    wSel.addEventListener("change", () => {
      S.selWeek.set(S.selAcademy, wSel.value);
      renderTab();
    });
    bar.appendChild(wSel);
    bar.appendChild(el("button", { class: "btn btn-small", text: "주차 관리", onclick: manageWeeks }));
  }
  container.appendChild(bar);
}

// ---------- 주차 관리 ----------
// 전체 주차를 나열하면 학기가 지날수록 모달이 너무 길어지므로,
// 주차를 선택해 그 주차 하나만 편집한다.
function manageWeeks() {
  const blob = academyBlob();
  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div");
  let selId = S.selWeek.get(S.selAcademy) || null;

  const renderEditor = () => {
    clear(body);
    const weeks = sortWeeks(blob.weeks);
    if (!weeks.length) {
      body.appendChild(el("p", { class: "empty", text: "아직 주차가 없습니다. '+ 새 주차'로 추가해 주세요." }));
      return;
    }
    if (!weeks.some((x) => x.id === selId)) selId = weeks[weeks.length - 1].id;

    const weekSel = el("select", { "aria-label": "관리할 주차 선택" });
    for (const x of weeks) {
      weekSel.appendChild(el("option", { value: x.id, text: x.label, selected: x.id === selId }));
    }
    weekSel.addEventListener("change", () => {
      selId = weekSel.value;
      renderEditor();
    });
    body.appendChild(el("div", { class: "item-row" }, [weekSel]));
    body.appendChild(
      el("p", { class: "hint", text: `총 ${weeks.length}개 주차 — 선택한 주차만 아래에서 편집합니다.` })
    );

    const w = weeks.find((x) => x.id === selId);
    const labelIn = el("input", { type: "text", value: w.label });
    const sessIn = el("input", {
      type: "text",
      value: (w.sessions || []).join(", "),
      placeholder: "수업일: 2026-07-07, 2026-07-10",
    });
    const save = () => {
      w.label = labelIn.value.trim() || w.label;
      const dates = sessIn.value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
        .sort();
      w.sessions = dates;
      markAcademy(S.selAcademy);
      toast("저장되었습니다.", "ok");
      renderEditor(); // 라벨 변경을 선택 목록에 반영
    };
    body.appendChild(
      el("div", { class: "card", style: "padding:10px" }, [
        el("div", { class: "hint", text: `ID: ${w.id}` }),
        el("label", { class: "field" }, [el("span", { text: "주차 이름" }), labelIn]),
        el("label", { class: "field" }, [el("span", { text: "수업일 (쉼표로 구분)" }), sessIn]),
        el("div", { class: "item-row" }, [
          el("button", { class: "btn btn-small", text: "저장", onclick: save }),
          el("button", {
            class: "btn btn-small btn-danger",
            text: "이 주차 삭제",
            onclick: async () => {
              const ok = await confirmModal({
                title: "주차 삭제",
                body: `'${w.label}'을(를) 삭제할까요? 이 주차의 숙제·점수 표시가 사라집니다. (학생 데이터 자체는 남아 있습니다)`,
                okText: "삭제",
                danger: true,
              });
              if (!ok) return;
              blob.weeks = blob.weeks.filter((x) => x.id !== w.id);
              selId = null; // 최신 주차로 되돌아감
              markAcademy(S.selAcademy);
              renderEditor();
            },
          }),
        ]),
      ])
    );
  };

  const addWeek = () => {
    const today = new Date();
    let id = isoWeekId(today);
    // 중복 시 뒤로 밀기
    const ids = new Set(blob.weeks.map((w) => w.id));
    let bump = 0;
    while (ids.has(id)) {
      bump += 7;
      const d = new Date(today);
      d.setDate(d.getDate() + bump);
      id = isoWeekId(d);
    }
    const month = today.getMonth() + 1;
    const nth = Math.ceil(today.getDate() / 7);
    blob.weeks.push({
      id,
      label: `${month}월 ${nth}주차`,
      sessions: [],
      homework: [],
      progress: "",
    });
    S.selWeek.set(S.selAcademy, id);
    selId = id; // 새 주차를 바로 편집
    markAcademy(S.selAcademy);
    renderEditor();
  };

  overlay.appendChild(
    el("div", { class: "modal", style: "max-width:560px;max-height:85dvh;overflow-y:auto" }, [
      el("h3", { text: `주차 관리 — ${academyEntry().name}` }),
      body,
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn", text: "+ 새 주차", onclick: addWeek }),
        el("button", {
          class: "btn btn-primary",
          text: "닫기",
          onclick: () => {
            overlay.remove();
            renderTab();
          },
        }),
      ]),
    ])
  );
  renderEditor();
  document.body.appendChild(overlay);
}

// ---------- ① 학생 관리 ----------
function renderStudentsTab(container) {
  const card = el("div", { class: "card" }, [el("h2", { text: "학생 관리" })]);

  for (const a of S.roster.academies) {
    card.appendChild(el("h3", { text: a.name, style: "font-size:15px;margin-top:14px" }));
    const students = S.roster.students.filter((s) => s.academyFileId === a.fileId);
    if (!students.length) card.appendChild(el("p", { class: "empty", text: "학생이 없습니다." }));
    for (const st of students) {
      card.appendChild(
        el("div", { class: `student-row ${st.active === false ? "inactive" : ""}` }, [
          el("span", { class: "s-name", text: st.name }),
          el("span", { class: "code-pill", text: st.code }),
          el("span", { class: "s-actions" }, [
            el("button", {
              class: "btn btn-small",
              text: "카드 인쇄",
              onclick: () => printCodeCards([{ name: st.name, code: st.code, academyName: a.name }], S.meta.site.title, S.roster.siteURL),
            }),
            el("button", { class: "btn btn-small", text: "코드 재발급", onclick: () => reissueCode(st) }),
            el("button", {
              class: "btn btn-small",
              text: st.active === false ? "활성화" : "비활성",
              onclick: () => {
                st.active = st.active === false;
                markRoster();
                renderTab();
              },
            }),
            el("button", { class: "btn btn-small btn-danger", text: "삭제", onclick: () => deleteStudent(st) }),
          ]),
        ])
      );
    }
  }

  // 학생 추가
  const nameIn = el("input", { type: "text", placeholder: "학생 이름" });
  const aSel = el("select");
  for (const a of S.roster.academies) aSel.appendChild(el("option", { value: a.fileId, text: a.name }));
  card.appendChild(el("h3", { text: "학생 추가", style: "font-size:15px;margin-top:18px" }));
  card.appendChild(
    el("div", { class: "toolbar" }, [
      nameIn,
      aSel,
      el("button", {
        class: "btn btn-primary btn-small",
        text: "추가",
        onclick: async () => {
          const name = nameIn.value.trim();
          if (!name) return toast("이름을 입력해 주세요.", "error");
          const aEntry = academyEntry(aSel.value);
          const { rosterEntry, blob } = await createStudent(name, aEntry, S.meta.saltStudent);
          S.roster.students.push(rosterEntry);
          S.students.set(rosterEntry.fileId, blob);
          markStudent(rosterEntry.fileId);
          markRoster();
          toast(`${name} 학생이 추가되었습니다. 코드: ${rosterEntry.code}`, "ok");
          renderTab();
        },
      }),
    ])
  );

  // ---- 선생님 열람 코드 (학원별, 관리 권한 없음 — 출석·공지·점수 분포만 열람) ----
  card.appendChild(el("h3", { text: "선생님 열람 코드", style: "font-size:15px;margin-top:18px" }));
  card.appendChild(
    el("p", {
      class: "hint",
      text: "이 코드로 학생 포털에 로그인하면 해당 학원의 출석 현황, 숙제 체크, 학생별 성적표, 퀴즈 점수 분포, 개별 리포트(전달사항+PDF 첨부 여부), 공지를 볼 수 있습니다. 편집은 불가능합니다.",
    })
  );
  S.roster.teachers = S.roster.teachers || [];
  for (const a of S.roster.academies) {
    const viewers = S.roster.teachers.filter((t) => t.academyFileId === a.fileId);
    for (const t of viewers) {
      card.appendChild(
        el("div", { class: "student-row" }, [
          el("span", { class: "s-name", text: t.name }),
          el("span", { class: "code-pill", text: t.code }),
          el("span", { class: "s-actions" }, [
            el("button", {
              class: "btn btn-small",
              text: "카드 인쇄",
              onclick: () => printCodeCards([{ name: t.name, code: t.code, academyName: a.name }], S.meta.site.title, S.roster.siteURL),
            }),
            el("button", { class: "btn btn-small", text: "코드 재발급", onclick: () => reissueTeacher(t) }),
            el("button", { class: "btn btn-small btn-danger", text: "삭제", onclick: () => deleteTeacher(t) }),
          ]),
        ])
      );
    }
    card.appendChild(
      el("div", { class: "toolbar" }, [
        el("button", {
          class: "btn btn-small",
          text: `+ ${a.name} 선생님 코드 발급`,
          onclick: async () => {
            const code = generateCode();
            const { fileId, aesKey } = await deriveStudentKeys(code, S.meta.saltStudent, S.meta.kdf.iterStudent);
            S.roster.teachers.push({
              code,
              name: `${a.name} 선생님`,
              fileId,
              encKey: await exportAesKeyB64(aesKey),
              academyFileId: a.fileId,
              active: true,
            });
            markRoster();
            toast(`발급되었습니다: ${code} — '발행'해야 사용할 수 있습니다.`, "ok");
            renderTab();
          },
        }),
      ])
    );
  }

  card.appendChild(
    el("div", { class: "toolbar", style: "margin-top:14px" }, [
      el("button", {
        class: "btn",
        text: "🖨️ 전체 코드 카드 인쇄",
        onclick: () => {
          const entries = S.roster.students
            .filter((s) => s.active !== false)
            .map((s) => ({
              name: s.name,
              code: s.code,
              academyName: academyEntry(s.academyFileId)?.name || "",
            }));
          printCodeCards(entries, S.meta.site.title, S.roster.siteURL);
        },
      }),
    ])
  );

  container.appendChild(card);
}

async function reissueCode(st) {
  const ok = await confirmModal({
    title: "코드 재발급",
    body:
      `${st.name} 학생의 접속 코드를 새로 만듭니다. 기존 코드는 더 이상 사용할 수 없습니다. ` +
      `(데이터와 분석 PDF는 새 코드로 다시 암호화되어 유지됩니다)\n\n` +
      `주의: 재발급 후에는 ZIP 수동 업로드가 아닌 'GitHub에 발행(자동 커밋)'을 사용해야 ` +
      `이전 파일이 서버에서 삭제되어 유출된 코드로 접근할 수 없게 됩니다.`,
    okText: "재발급",
  });
  if (!ok) return;
  setBusy(contentEl, "분석 PDF를 새 코드로 다시 암호화하는 중…");
  try {
    const blob = S.students.get(st.fileId);
    const oldFileId = st.fileId;
    const oldKey = await importAesKeyB64(st.encKey);

    // 1) gather: 이 학생의 모든 단원 리포트 PDF 평문을 먼저 확보 —
    //    하나라도 실패하면 아무것도 바꾸지 않는다 (구 키 유실 방지)
    const gathered = [];
    for (const rep of Object.values(blob.quizReports || {})) {
      const pdf = rep.pdf;
      if (!pdf) continue;
      const pending = S.pendingUploads.get(pdf.path);
      const bytes = pending
        ? pending.bytes
        : new Uint8Array(await decryptBytes(oldKey, await fetchBytes(pdf.path)));
      gathered.push({ pdf, wasPending: !!pending, bytes });
    }
    // 구(주차별) 리포트 PDF는 더 이상 표시되지 않으므로 정리 삭제만 예약
    const legacyDeletes = [];
    for (const wd of Object.values(blob.weeks || {})) {
      if (wd.reportPdf) {
        legacyDeletes.push(wd.reportPdf.path);
        delete wd.reportPdf;
      }
    }

    // 2) commit: 새 키 유도 후 일괄 반영
    const code = generateCode();
    const { fileId, aesKey } = await deriveStudentKeys(code, S.meta.saltStudent, S.meta.kdf.iterStudent);
    st.code = code;
    st.fileId = fileId;
    st.encKey = await exportAesKeyB64(aesKey);
    S.students.delete(oldFileId);
    S.students.set(fileId, blob);
    S.dirtyStudents.delete(oldFileId);
    S.pendingDeletes.add(`data/s/${oldFileId}.json`);
    for (const p of legacyDeletes) {
      if (S.pendingUploads.has(p)) S.pendingUploads.delete(p);
      else S.pendingDeletes.add(p);
    }
    for (const g of gathered) {
      if (g.wasPending) S.pendingUploads.delete(g.pdf.path);
      else S.pendingDeletes.add(g.pdf.path);
      g.pdf.path = `data/m/${randomHexId(16)}.bin`;
      S.pendingUploads.set(g.pdf.path, { bytes: g.bytes, studentFileId: fileId });
    }
    markStudent(fileId);
    markRoster();
    toast(`새 코드: ${code} — 카드를 다시 인쇄해 전달하세요.`, "ok");
  } catch (e) {
    console.error(e);
    toast("재발급 실패: " + e.message + " (변경된 것은 없습니다)", "error");
  }
  renderTab();
}

async function deleteStudent(st) {
  const ok = await confirmModal({
    title: "학생 삭제",
    body:
      `${st.name} 학생을 완전히 삭제합니다. 이 학생의 모든 기록과 분석 PDF가 삭제되고, ` +
      `보안을 위해 소속 학원의 암호화 키가 교체됩니다(공지·자료 재암호화).\n\n` +
      `발행해야 적용되며, ZIP 수동 업로드가 아닌 'GitHub에 발행(자동 커밋)'을 사용해야 ` +
      `이전 파일이 서버에서 삭제됩니다.`,
    okText: "삭제",
    danger: true,
  });
  if (!ok) return;
  setBusy(contentEl, "학원 키를 교체하고 자료를 재암호화하는 중…");
  try {
    const academyFileId = st.academyFileId;
    // 이 학생의 분석 PDF 정리 (blob 제거 전에 경로를 확보해야 함)
    // 단원 리포트 PDF + 구(주차별) 리포트 PDF 모두 정리
    const blob = S.students.get(st.fileId);
    const pdfPaths = [
      ...Object.values(blob?.quizReports || {}).map((r) => r.pdf?.path),
      ...Object.values(blob?.weeks || {}).map((wd) => wd.reportPdf?.path),
    ].filter(Boolean);
    for (const p of pdfPaths) {
      if (S.pendingUploads.has(p)) S.pendingUploads.delete(p);
      else S.pendingDeletes.add(p);
    }
    S.roster.students = S.roster.students.filter((x) => x.fileId !== st.fileId);
    S.students.delete(st.fileId);
    S.dirtyStudents.delete(st.fileId);
    S.pendingDeletes.add(`data/s/${st.fileId}.json`);
    await rotateAcademyKey(academyFileId);
    markRoster();
    toast(`${st.name} 학생이 삭제되었습니다. '발행'해야 사이트에 반영됩니다.`, "ok");
  } catch (e) {
    console.error(e);
    toast("삭제 처리 중 오류: " + e.message, "error");
  }
  renderTab();
}

// 선생님 열람 코드 재발급 (데이터는 발행 때마다 재생성되므로 코드/키만 교체)
async function reissueTeacher(t) {
  const ok = await confirmModal({
    title: "선생님 코드 재발급",
    body: `${t.name}의 열람 코드를 새로 만듭니다. 기존 코드는 더 이상 사용할 수 없습니다.\n\n주의: ZIP 수동 업로드가 아닌 'GitHub에 발행(자동 커밋)'을 사용해야 이전 파일이 서버에서 삭제됩니다.`,
    okText: "재발급",
  });
  if (!ok) return;
  const oldFileId = t.fileId;
  const code = generateCode();
  const { fileId, aesKey } = await deriveStudentKeys(code, S.meta.saltStudent, S.meta.kdf.iterStudent);
  t.code = code;
  t.fileId = fileId;
  t.encKey = await exportAesKeyB64(aesKey);
  S.pendingDeletes.add(`data/t/${oldFileId}.json`);
  markRoster();
  toast(`새 코드: ${code} — '발행'해야 적용됩니다.`, "ok");
  renderTab();
}

// 선생님 열람 코드 삭제: 학원 키를 알고 있으므로 학원 키 교체 포함
async function deleteTeacher(t) {
  const ok = await confirmModal({
    title: "선생님 코드 삭제",
    body: `${t.name}의 열람 코드를 삭제합니다. 이 코드는 소속 학원의 공지·자료 암호화 키를 알고 있으므로, 보안을 위해 학원 키가 교체됩니다(자료 재암호화).\n\n발행해야 적용되며, 'GitHub에 발행(자동 커밋)'을 사용해야 이전 파일이 삭제됩니다.`,
    okText: "삭제",
    danger: true,
  });
  if (!ok) return;
  setBusy(contentEl, "학원 키를 교체하고 자료를 재암호화하는 중…");
  try {
    S.pendingDeletes.add(`data/t/${t.fileId}.json`);
    S.roster.teachers = S.roster.teachers.filter((x) => x.fileId !== t.fileId);
    await rotateAcademyKey(t.academyFileId);
    markRoster();
    toast(`${t.name} 코드가 삭제되었습니다. '발행'해야 반영됩니다.`, "ok");
  } catch (e) {
    console.error(e);
    toast("삭제 처리 중 오류: " + e.message, "error");
  }
  renderTab();
}

// 학원 키 교체: 새 키/파일ID 생성, 자료 재암호화, 소속 학생 blob 갱신
// 주의: 학생 개인 키로 암호화된 분석 PDF(studentFileId 대상)는 절대 건드리지 않는다.
async function rotateAcademyKey(oldFileId) {
  const entry = S.roster.academies.find((a) => a.fileId === oldFileId);
  const blob = S.academies.get(oldFileId);
  const oldKey = await importAesKeyB64(entry.key);
  const newFileId = randomHexId(16);
  const newKey = randomKeyB64();

  // 기존 자료를 평문으로 확보해 새 키 대상으로 재스테이징
  // (미발행 업로드는 이미 평문으로 메모리에 있음)
  for (const m of blob.materials || []) {
    const pending = S.pendingUploads.get(m.path);
    let plain;
    if (pending) {
      plain = pending.bytes;
      S.pendingUploads.delete(m.path);
    } else {
      const encBuf = await fetchBytes(m.path);
      plain = new Uint8Array(await decryptBytes(oldKey, encBuf));
      S.pendingDeletes.add(m.path);
    }
    m.path = `data/m/${randomHexId(16)}.bin`;
    S.pendingUploads.set(m.path, { bytes: plain, academyFileId: newFileId });
  }

  S.pendingDeletes.add(`data/a/${oldFileId}.json`);
  S.academies.delete(oldFileId);
  S.academies.set(newFileId, blob);
  S.dirtyAcademies.delete(oldFileId);
  entry.fileId = newFileId;
  entry.key = newKey;

  // 이 학원 대상으로 대기 중이던 자료실 업로드만 새 키 대상으로 이전
  for (const [, up] of S.pendingUploads) {
    if (up.academyFileId === oldFileId) up.academyFileId = newFileId;
  }
  // 소속 학생 전원 재암호화 대상 (blob.academy는 발행 시 roster 기준으로 동기화)
  for (const st of S.roster.students) {
    if (st.academyFileId === oldFileId) {
      st.academyFileId = newFileId;
      S.dirtyStudents.add(st.fileId);
    }
  }
  // 소속 선생님 열람 코드도 새 학원을 가리키게 갱신 — 선생님 파일은 발행 때마다
  // 새 학원 키를 담아 재생성되므로 코드 자체는 계속 유효하다
  for (const t of S.roster.teachers || []) {
    if (t.academyFileId === oldFileId) t.academyFileId = newFileId;
  }
  if (S.selAcademy === oldFileId) S.selAcademy = newFileId;
  if (S.selWeek.has(oldFileId)) {
    S.selWeek.set(newFileId, S.selWeek.get(oldFileId));
    S.selWeek.delete(oldFileId);
  }
  S.dirtyAcademies.add(newFileId);
  markRoster();
}

// ---------- ② 점수 입력 (단원별 퀴즈) ----------
function renderScoresTab(container) {
  quizToolbar(container);
  const quiz = selectedQuiz();
  const card = el("div", { class: "card" }, [el("h2", { text: "퀴즈 점수 입력" })]);
  if (!quiz) {
    card.appendChild(
      el("p", { class: "empty", text: "'+ 새 퀴즈'로 단원 퀴즈를 먼저 만들어 주세요. (한 주차에 여러 단원 퀴즈를 만들 수 있습니다)" })
    );
    container.appendChild(card);
    return;
  }
  card.appendChild(
    el("p", { class: "hint", text: `단원: ${quiz.unit} · 응시 주차: ${weekLabelOf(academyBlob().weeks, quiz.weekId) || "미정"} · 만점 ${quiz.max}점 (변경은 '퀴즈 관리')` })
  );

  const students = activeStudentsOf(S.selAcademy);

  // TSV 붙여넣기
  const tsv = el("textarea", {
    class: "tsv-area",
    placeholder: "엑셀에서 [이름] [점수] 두 열을 복사해 붙여넣으세요.\n예)\n김철수\t85\n이영희\t92\n박민수\t결   ← '결'을 쓰면 미응시로 표시됩니다",
  });
  const warn = el("p", { class: "error-text" });

  // 점수 입력 표 (빈칸 = 미입력, [미응시] = 결석 등으로 응시 안 함 → 평균 제외)
  const inputs = new Map(); // fileId -> input
  const noShow = new Map(); // fileId -> boolean
  const noShowBtns = new Map(); // fileId -> button
  const avgLine = el("p", { class: "hint" });
  const tbl = el("table", { class: "grid" });
  tbl.appendChild(
    el("tr", {}, [
      el("th", { class: "name-cell", text: "이름" }),
      el("th", { text: "점수" }),
      el("th", { text: "미응시" }),
    ])
  );
  const setNoShow = (fileId, on) => {
    noShow.set(fileId, on);
    const input = inputs.get(fileId);
    input.disabled = on;
    if (on) input.value = "";
    noShowBtns.get(fileId).classList.toggle("on", on);
  };
  for (const st of students) {
    const q = S.students.get(st.fileId)?.quizzes;
    const cur = q?.[quiz.id];
    const ns = isNoShow(q, quiz.id);
    const input = el("input", {
      type: "number",
      class: "cell-input",
      value: cur != null ? String(cur) : "",
      min: "0",
      oninput: updateAvg,
    });
    if (ns) input.disabled = true;
    inputs.set(st.fileId, input);
    noShow.set(st.fileId, ns);
    const btn = el("button", {
      class: `btn btn-small noshow-toggle${ns ? " on" : ""}`,
      text: "미응시",
      "aria-pressed": ns ? "true" : "false",
      onclick: () => {
        setNoShow(st.fileId, !noShow.get(st.fileId));
        updateAvg();
      },
    });
    noShowBtns.set(st.fileId, btn);
    tbl.appendChild(
      el("tr", {}, [
        el("td", { class: "name-cell", text: st.name }),
        el("td", {}, [input]),
        el("td", {}, [btn]),
      ])
    );
  }

  function updateAvg() {
    const vals = students
      .filter((st) => !noShow.get(st.fileId))
      .map((st) => parseFloat(inputs.get(st.fileId).value))
      .filter((v) => !isNaN(v));
    const nsCount = students.filter((st) => noShow.get(st.fileId)).length;
    const nsText = nsCount ? ` · 미응시 ${nsCount}명 (평균 제외)` : "";
    avgLine.textContent = vals.length
      ? `응시 ${vals.length}명 · 평균 ${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)}점${nsText}`
      : `입력된 점수가 없습니다.${nsText}`;
  }
  updateAvg();

  // 이 주차 출석부에 결석·공결이 있는 학생 안내 (자동 처리는 하지 않음 — 보강 응시 가능)
  const absentish = students
    .filter((st) => {
      const att = S.students.get(st.fileId)?.weeks?.[quiz.weekId]?.attendance || {};
      return Object.values(att).some((c) => c === "A" || c === "X");
    })
    .map((st) => st.name);
  if (absentish.length) {
    card.appendChild(
      el("p", {
        class: "hint",
        text: `이 주차 출석부에 결석·공결 기록이 있는 학생: ${absentish.join(", ")} — 퀴즈를 보지 않았다면 [미응시]로 표시하세요.`,
      })
    );
  }

  const NOSHOW_TOKEN = /^(결|결석|미응시|불참|x|X|-|–)$/;
  tsv.addEventListener("input", () => {
    warn.textContent = "";
    const unmatched = [];
    const lines = tsv.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      let [name, score] = line.includes("\t") ? line.split("\t") : line.split(/\s+/);
      name = (name || "").trim();
      score = (score || "").trim();
      const asNoShow = NOSHOW_TOKEN.test(score);
      const num = parseFloat(score);
      if (!name || (!asNoShow && isNaN(num))) continue;
      const matches = students.filter((s) => s.name === name);
      if (matches.length === 1) {
        setNoShow(matches[0].fileId, asNoShow);
        if (!asNoShow) inputs.get(matches[0].fileId).value = String(num);
      } else {
        unmatched.push(name + (matches.length > 1 ? " (동명이인)" : ""));
      }
    }
    if (unmatched.length) {
      warn.textContent = `자동 매칭 안 됨 → 아래 표에서 직접 입력하세요: ${[...new Set(unmatched)].join(", ")}`;
    }
    updateAvg();
  });

  card.appendChild(el("label", { class: "field" }, [el("span", { text: "엑셀에서 붙여넣기 (이름 ⇥ 점수)" }), tsv]));
  card.appendChild(warn);
  card.appendChild(el("div", { class: "toolbar" }, [avgLine]));
  card.appendChild(el("div", { class: "table-wrap" }, [tbl]));
  card.appendChild(
    el("button", {
      class: "btn btn-primary btn-block",
      style: "margin-top:12px",
      text: "이 퀴즈 점수 저장",
      onclick: () => {
        let changed = 0;
        for (const st of students) {
          const raw = inputs.get(st.fileId).value.trim();
          const blob = S.students.get(st.fileId);
          blob.quizzes = blob.quizzes || {};
          const had = quiz.id in blob.quizzes;
          if (noShow.get(st.fileId)) {
            if (!had || blob.quizzes[quiz.id] !== null) {
              blob.quizzes[quiz.id] = null; // 미응시 (평균 제외, 미입력과 구분)
              markStudent(st.fileId);
              changed++;
            }
          } else if (raw === "") {
            if (had) {
              delete blob.quizzes[quiz.id];
              markStudent(st.fileId);
              changed++;
            }
          } else {
            const score = parseFloat(raw);
            if (!had || blob.quizzes[quiz.id] !== score) {
              blob.quizzes[quiz.id] = score;
              markStudent(st.fileId);
              changed++;
            }
          }
        }
        recomputeStats();
        toast(`저장되었습니다 (${changed}명 변경). '발행'해야 사이트에 반영됩니다.`, "ok");
      },
    })
  );
  container.appendChild(card);
}

// 퀴즈별 전체 평균/응시 인원 재계산 (quizzes[].stats)
// 단원명이 같은 퀴즈는 **모든 학원의 학생을 합쳐** 전체 평균을 계산한다.
// (학원 blob에는 합산된 평균·인원 숫자만 저장되므로 타 학원 개인 정보는 노출되지 않음)
function recomputeStats() {
  const norm = (s) => String(s || "").trim().replace(/\s+/g, " ");
  // 단원명 → 전 학원 합산 점수 풀
  const pool = new Map();
  for (const a of S.roster.academies) {
    const blob = S.academies.get(a.fileId);
    for (const q of blob?.quizzes || []) {
      const key = norm(q.unit);
      const arr = pool.get(key) || [];
      for (const st of activeStudentsOf(a.fileId)) {
        const v = S.students.get(st.fileId)?.quizzes?.[q.id];
        if (v != null) arr.push(v);
      }
      pool.set(key, arr);
    }
  }
  for (const a of S.roster.academies) {
    const blob = S.academies.get(a.fileId);
    for (const q of blob?.quizzes || []) {
      const scores = pool.get(norm(q.unit)) || [];
      const prev = JSON.stringify(q.stats || null);
      q.stats = scores.length
        ? {
            avg: Math.round((scores.reduce((x, y) => x + y, 0) / scores.length) * 10) / 10,
            count: scores.length,
          }
        : null;
      if (JSON.stringify(q.stats) !== prev) markAcademy(a.fileId);
    }
  }
}

// ---------- ③ 숙제 체크 ----------
function renderHomeworkTab(container) {
  toolbar(container);
  const week = selectedWeek();
  const card = el("div", { class: "card" }, [el("h2", { text: "숙제 체크" })]);
  if (!week) {
    card.appendChild(el("p", { class: "empty", text: "'주차 관리'에서 먼저 주차를 만들어 주세요." }));
    container.appendChild(card);
    return;
  }
  week.homework = week.homework || [];

  // 숙제 항목 편집
  const itemsBox = el("div");
  const renderItems = () => {
    clear(itemsBox);
    for (const item of week.homework) {
      const input = el("input", {
        type: "text",
        value: item.text,
        onchange: (e) => {
          item.text = e.target.value.trim();
          markAcademy(S.selAcademy);
        },
      });
      itemsBox.appendChild(
        el("div", { class: "item-row" }, [
          input,
          el("button", {
            class: "btn btn-small btn-danger",
            text: "✕",
            "aria-label": "항목 삭제",
            onclick: async () => {
              const ok = await confirmModal({
                title: "숙제 항목 삭제",
                body: `'${item.text}' 항목을 삭제할까요? 학생들의 체크 기록도 함께 지워집니다.`,
                okText: "삭제",
                danger: true,
              });
              if (!ok) return;
              week.homework = week.homework.filter((x) => x.id !== item.id);
              for (const st of activeStudentsOf(S.selAcademy)) {
                const wd = S.students.get(st.fileId)?.weeks?.[week.id];
                if (wd?.homework && item.id in wd.homework) {
                  delete wd.homework[item.id];
                  markStudent(st.fileId);
                }
              }
              markAcademy(S.selAcademy);
              renderTab();
            },
          }),
        ])
      );
    }
    itemsBox.appendChild(
      el("button", {
        class: "btn btn-small",
        text: "+ 숙제 항목 추가",
        onclick: () => {
          const n = week.homework.reduce((m, i) => Math.max(m, parseInt(i.id.slice(2)) || 0), 0) + 1;
          week.homework.push({ id: `hw${n}`, text: "" });
          markAcademy(S.selAcademy);
          renderTab();
        },
      })
    );
  };
  renderItems();
  card.appendChild(itemsBox);

  // 체크 그리드
  if (week.homework.length) {
    const students = activeStudentsOf(S.selAcademy);
    const tbl = el("table", { class: "grid", style: "margin-top:12px" });
    const header = el("tr", {}, [el("th", { class: "name-cell", text: "이름" })]);
    week.homework.forEach((item, idx) => {
      const th = el("th", {}, [
        el("div", { text: `${idx + 1}번` }),
        el("button", {
          class: "btn btn-small",
          text: "전체 ✓",
          onclick: () => {
            for (const st of students) {
              const blob = S.students.get(st.fileId);
              blob.weeks[week.id] = blob.weeks[week.id] || {};
              blob.weeks[week.id].homework = blob.weeks[week.id].homework || {};
              const hw = blob.weeks[week.id].homework;
              // 확인 전(◌)은 결석 학생이므로 전체 완료로 덮어쓰지 않는다
              if (hw[item.id] !== true && !isNoShow(hw, item.id)) {
                hw[item.id] = true;
                markStudent(st.fileId);
              }
            }
            renderTab();
          },
        }),
      ]);
      header.appendChild(th);
    });
    tbl.appendChild(header);

    // 칸 상태: 빈칸(미완료) → ✓(완료) → ◌(확인 전 = 결석 보류, 완료율 제외) → 빈칸
    const stateOf = (hw, id) => (hw?.[id] === true ? "done" : isNoShow(hw, id) ? "hold" : "none");
    const applyBtn = (btn, state) => {
      btn.classList.toggle("on", state === "done");
      btn.classList.toggle("hold", state === "hold");
      btn.textContent = state === "done" ? "✓" : state === "hold" ? "◌" : "";
    };
    for (const st of students) {
      const row = el("tr", {}, [el("td", { class: "name-cell", text: st.name })]);
      for (const item of week.homework) {
        const blob = S.students.get(st.fileId);
        const btn = el("button", {
          class: "cell-toggle",
          onclick: () => {
            blob.weeks[week.id] = blob.weeks[week.id] || {};
            blob.weeks[week.id].homework = blob.weeks[week.id].homework || {};
            const hw = blob.weeks[week.id].homework;
            const cur = stateOf(hw, item.id);
            if (cur === "none") hw[item.id] = true;
            else if (cur === "done") hw[item.id] = null; // 확인 전(결석)
            else delete hw[item.id];
            applyBtn(btn, stateOf(hw, item.id));
            markStudent(st.fileId);
          },
        });
        applyBtn(btn, stateOf(blob.weeks?.[week.id]?.homework, item.id));
        row.appendChild(el("td", {}, [btn]));
      }
      tbl.appendChild(row);
    }
    card.appendChild(el("div", { class: "table-wrap" }, [tbl]));
    card.appendChild(
      el("p", {
        class: "hint",
        text: "칸을 누를 때마다 ✓ 완료 → ◌ 확인 전(결석 등, 완료율 제외) → 빈칸(미완료) 순으로 바뀝니다. ◌는 다음 수업에서 확인 후 바꿔 주세요.",
      })
    );
  }

  card.appendChild(
    el("button", {
      class: "btn btn-block",
      style: "margin-top:12px",
      text: "📋 카톡용 숙제 목록 복사",
      onclick: () => copyText(homeworkShareText(academyEntry().name, week)),
    })
  );
  container.appendChild(card);
}

// ---------- ④ 출석 ----------
function renderAttendanceTab(container) {
  toolbar(container);
  const week = selectedWeek();
  const card = el("div", { class: "card" }, [el("h2", { text: "출석 체크" })]);
  if (!week) {
    card.appendChild(el("p", { class: "empty", text: "'주차 관리'에서 먼저 주차를 만들어 주세요." }));
    container.appendChild(card);
    return;
  }
  if (!(week.sessions || []).length) {
    card.appendChild(
      el("p", { class: "empty", text: "'주차 관리'에서 이 주차의 수업일을 먼저 입력해 주세요." })
    );
    container.appendChild(card);
    return;
  }
  card.appendChild(
    el("p", {
      class: "hint",
      text: "원하는 상태 버튼을 바로 누르세요. 선택된 칸을 다시 누르면 변경하거나 지울 수 있습니다.",
    })
  );
  const students = activeStudentsOf(S.selAcademy);
  const tbl = el("table", { class: "grid" });
  tbl.appendChild(
    el("tr", {}, [
      el("th", { class: "name-cell", text: "이름" }),
      ...week.sessions.map((d) => el("th", { text: d.slice(5).replace("-", "/") })),
    ])
  );
  for (const st of students) {
    const blob = S.students.get(st.fileId);
    const row = el("tr", {}, [el("td", { class: "name-cell", text: st.name })]);
    for (const d of week.sessions) {
      const td = el("td");
      let open = false; // 선택된 칸을 다시 눌러 선택기를 연 상태
      const get = () => blob.weeks?.[week.id]?.attendance?.[d] || "";
      const set = (code) => {
        blob.weeks[week.id] = blob.weeks[week.id] || {};
        blob.weeks[week.id].attendance = blob.weeks[week.id].attendance || {};
        if (code) blob.weeks[week.id].attendance[d] = code;
        else delete blob.weeks[week.id].attendance[d];
        markStudent(st.fileId);
      };
      const paint = () => {
        clear(td);
        const code = get();
        const info = ATTENDANCE[code]; // 알 수 없는 코드는 선택기로 처리
        if (code && info && !open) {
          // 선택됨: 큰 칩 하나 (클릭 → 선택기 재오픈)
          td.appendChild(
            el("button", {
              class: `cell-toggle att-cell ${info.cls}`,
              text: info.label,
              title: "누르면 변경할 수 있습니다",
              onclick: () => {
                open = true;
                paint();
              },
            })
          );
        } else {
          // 미선택/변경 중: 모든 상태를 작은 버튼으로 나열
          const chooser = el("div", { class: "att-chooser" });
          for (const c of ATTENDANCE_ORDER) {
            const o = ATTENDANCE[c];
            chooser.appendChild(
              el("button", {
                class: `att-opt att-cell ${o.cls}`,
                text: o.label,
                title: o.label,
                "aria-label": `${st.name} ${d} ${o.label}`,
                onclick: () => {
                  set(c);
                  open = false;
                  paint();
                },
              })
            );
          }
          if (code) {
            chooser.appendChild(
              el("button", {
                class: "att-opt",
                text: "–",
                title: "지우기",
                "aria-label": `${st.name} ${d} 지우기`,
                onclick: () => {
                  set("");
                  open = false;
                  paint();
                },
              })
            );
          }
          td.appendChild(chooser);
        }
      };
      paint();
      row.appendChild(td);
    }
    tbl.appendChild(row);
  }
  card.appendChild(el("div", { class: "table-wrap" }, [tbl]));
  container.appendChild(card);
}

// ---------- ⑤ 리포트 (단원별) ----------
function renderReportsTab(container) {
  quizToolbar(container);
  const quiz = selectedQuiz();
  const card = el("div", { class: "card" }, [el("h2", { text: "단원 리포트 작성" })]);
  if (!quiz) {
    card.appendChild(el("p", { class: "empty", text: "'+ 새 퀴즈'로 단원 퀴즈를 먼저 만들어 주세요." }));
    container.appendChild(card);
    return;
  }
  card.appendChild(el("p", { class: "hint", text: `단원: ${quiz.unit} · 응시 주차: ${weekLabelOf(academyBlob().weeks, quiz.weekId) || "미정"}` }));
  const students = activeStudentsOf(S.selAcademy);
  if (!students.length) {
    card.appendChild(el("p", { class: "empty", text: "학생이 없습니다." }));
    container.appendChild(card);
    return;
  }
  let idx = 0;
  const who = el("div", { class: "who" });
  const count = el("div", { class: "char-count" });
  const ta = el("textarea", {
    rows: "6",
    placeholder: "이 단원에 대해 학생/학부모에게 전달할 사항을 적어 주세요. 그대로 보입니다.",
  });

  const ensureRep = (st) => {
    const blob = S.students.get(st.fileId);
    blob.quizReports = blob.quizReports || {};
    blob.quizReports[quiz.id] = blob.quizReports[quiz.id] || {};
    return blob.quizReports[quiz.id];
  };
  const cleanupRep = (st) => {
    const blob = S.students.get(st.fileId);
    const rep = blob.quizReports?.[quiz.id];
    if (rep && !rep.pdf && !rep.note) delete blob.quizReports[quiz.id];
  };

  // ---- 퀴즈 분석 PDF (학생 본인 키로 암호화 — 그 학생 코드로만 열림) ----
  const pdfBox = el("div");

  const removePdf = (st) => {
    const rep = S.students.get(st.fileId).quizReports?.[quiz.id];
    const pdf = rep?.pdf;
    if (!pdf) return;
    if (S.pendingUploads.has(pdf.path)) S.pendingUploads.delete(pdf.path);
    else S.pendingDeletes.add(pdf.path);
    delete rep.pdf;
    cleanupRep(st);
    markStudent(st.fileId);
  };

  const renderPdf = () => {
    clear(pdfBox);
    const st = students[idx];
    const pdf = S.students.get(st.fileId).quizReports?.[quiz.id]?.pdf;
    if (pdf) {
      pdfBox.appendChild(
        el("div", { class: "material" }, [
          el("div", { class: "m-info" }, [
            el("div", {
              class: "m-title",
              text: `📊 ${pdf.origName}${S.pendingUploads.has(pdf.path) ? " (발행 대기)" : ""}`,
            }),
            el("div", { class: "m-meta", text: formatBytes(pdf.size) }),
          ]),
          el("div", { class: "m-actions" }, [
            el("button", {
              class: "btn btn-small btn-danger",
              text: "삭제",
              onclick: async () => {
                const ok = await confirmModal({
                  title: "분석 PDF 삭제",
                  body: `${st.name} 학생의 '${pdf.origName}'을(를) 삭제할까요?`,
                  okText: "삭제",
                  danger: true,
                });
                if (!ok) return;
                removePdf(st);
                renderPdf();
              },
            }),
          ]),
        ])
      );
    }
    const fileIn = el("input", { type: "file", accept: "application/pdf,.pdf" });
    const addBtn = el("button", {
      class: "btn btn-small btn-primary",
      text: pdf ? "PDF 교체" : "PDF 추가",
      onclick: async () => {
        const f = fileIn.files[0];
        if (!f) return toast("파일을 선택해 주세요.", "error");
        if (f.size > 90 * 1024 * 1024)
          return toast("90MB를 넘는 파일은 올릴 수 없습니다 (GitHub 제한).", "error");
        if (f.size > 25 * 1024 * 1024)
          toast("파일이 큽니다 — 업로드와 열람이 느릴 수 있습니다.", "error");
        const bytes = new Uint8Array(await f.arrayBuffer());
        removePdf(st); // 교체 시 기존 것 정리 (대기 중 → 맵 제거 / 발행됨 → 삭제 예약)
        const path = `data/m/${randomHexId(16)}.bin`;
        ensureRep(st).pdf = {
          path,
          origName: f.name,
          size: f.size,
          mime: f.type || "application/pdf",
        };
        S.pendingUploads.set(path, { bytes, studentFileId: st.fileId });
        markStudent(st.fileId);
        toast("추가되었습니다. '발행'해야 학생이 볼 수 있습니다.", "ok");
        renderPdf();
      },
    });
    pdfBox.appendChild(el("div", { class: "toolbar" }, [fileIn, addBtn]));
  };

  const load = () => {
    const st = students[idx];
    who.textContent = `${st.name} (${idx + 1}/${students.length})`;
    ta.value = S.students.get(st.fileId)?.quizReports?.[quiz.id]?.note || "";
    count.textContent = `${ta.value.length}자`;
    renderPdf();
  };
  const save = () => {
    const st = students[idx];
    const cur = S.students.get(st.fileId).quizReports?.[quiz.id]?.note || "";
    const next = ta.value;
    if (cur !== next) {
      if (next) ensureRep(st).note = next;
      else {
        const rep = S.students.get(st.fileId).quizReports?.[quiz.id];
        if (rep) delete rep.note;
        cleanupRep(st);
      }
      markStudent(st.fileId);
    }
  };
  ta.addEventListener("input", () => {
    count.textContent = `${ta.value.length}자`;
    save();
  });

  card.appendChild(
    el("div", { class: "report-nav" }, [
      el("button", {
        class: "btn btn-small",
        text: "← 이전",
        onclick: () => {
          save();
          idx = (idx - 1 + students.length) % students.length;
          load();
        },
      }),
      who,
      el("button", {
        class: "btn btn-small",
        text: "다음 →",
        onclick: () => {
          save();
          idx = (idx + 1) % students.length;
          load();
        },
      }),
    ])
  );
  card.appendChild(el("h3", { text: "퀴즈 분석 PDF", style: "font-size:15px;margin-top:8px" }));
  card.appendChild(
    el("p", { class: "hint", text: "이 학생의 접속 코드로만 열리도록 개별 암호화되어 올라갑니다." })
  );
  card.appendChild(pdfBox);
  card.appendChild(el("h3", { text: "전달 사항", style: "font-size:15px;margin-top:14px" }));
  card.appendChild(ta);
  card.appendChild(count);
  card.appendChild(el("p", { class: "hint", text: "입력하는 즉시 임시 저장됩니다. '발행'해야 사이트에 반영됩니다." }));
  load();
  container.appendChild(card);
}

// ---------- ⑥ 공지 ----------
function renderNoticesTab(container) {
  toolbar(container, { withWeek: false });
  const blob = academyBlob();
  const card = el("div", { class: "card" }, [el("h2", { text: `공지사항 — ${academyEntry().name}` })]);
  blob.notices = blob.notices || [];

  const form = (notice, onDone) => {
    const title = el("input", { type: "text", value: notice?.title || "", placeholder: "제목" });
    const date = el("input", { type: "date", value: notice?.date || toYMD(new Date()) });
    const body = el("textarea", { rows: "4", placeholder: "내용" });
    body.value = notice?.body || "";
    const pinned = el("input", { type: "checkbox", checked: !!notice?.pinned });
    return el("div", { class: "card", style: "padding:12px" }, [
      el("label", { class: "field" }, [el("span", { text: "제목" }), title]),
      el("label", { class: "field" }, [el("span", { text: "날짜" }), date]),
      el("label", { class: "field" }, [el("span", { text: "내용" }), body]),
      el("label", { class: "check" }, [pinned, "상단 고정"]),
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn btn-small", text: "취소", onclick: () => onDone(null) }),
        el("button", {
          class: "btn btn-primary btn-small",
          text: "저장",
          onclick: () => {
            if (!title.value.trim()) return toast("제목을 입력해 주세요.", "error");
            onDone({
              id: notice?.id || randomHexId(6),
              title: title.value.trim(),
              date: date.value,
              body: body.value,
              pinned: pinned.checked,
            });
          },
        }),
      ]),
    ]);
  };

  const list = el("div");
  const renderList = () => {
    clear(list);
    const sorted = [...blob.notices].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.date || "").localeCompare(a.date || "");
    });
    if (!sorted.length) list.appendChild(el("p", { class: "empty", text: "등록된 공지가 없습니다." }));
    for (const n of sorted) {
      const row = el("div", { class: "notice" }, [
        el("div", { class: "notice-head" }, [
          n.pinned ? el("span", { class: "pin", text: "📌" }) : null,
          el("span", { class: "notice-title", text: n.title }),
          el("span", { class: "notice-date", text: n.date || "" }),
        ]),
        el("div", { class: "notice-body", text: n.body || "" }),
        el("div", { class: "toolbar" }, [
          el("button", {
            class: "btn btn-small",
            text: "수정",
            onclick: () => {
              const f = form(n, (result) => {
                if (result) {
                  Object.assign(n, result);
                  markAcademy(S.selAcademy);
                }
                renderList();
              });
              clear(list).appendChild(f);
            },
          }),
          el("button", {
            class: "btn btn-small btn-danger",
            text: "삭제",
            onclick: async () => {
              const ok = await confirmModal({
                title: "공지 삭제",
                body: `'${n.title}' 공지를 삭제할까요?`,
                okText: "삭제",
                danger: true,
              });
              if (!ok) return;
              blob.notices = blob.notices.filter((x) => x.id !== n.id);
              markAcademy(S.selAcademy);
              renderTab();
            },
          }),
        ]),
      ]);
      list.appendChild(row);
    }
  };
  renderList();

  card.appendChild(
    el("button", {
      class: "btn btn-primary btn-small",
      text: "+ 새 공지",
      onclick: () => {
        const f = form(null, (result) => {
          if (result) {
            blob.notices.push(result);
            markAcademy(S.selAcademy);
          }
          renderTab();
        });
        clear(list).appendChild(f);
      },
    })
  );
  card.appendChild(list);
  container.appendChild(card);

  // ---- 질문·문의 폼 (구글 폼) — 주소를 등록하면 학생 포털에 '질문·문의' 탭이 생긴다 ----
  const qnaIn = el("input", {
    type: "url",
    value: blob.qnaUrl || "",
    placeholder: "https://forms.gle/… (비워서 저장하면 탭 숨김)",
  });
  container.appendChild(
    el("div", { class: "card" }, [
      el("h2", { text: "질문·문의 폼 (구글 폼)" }),
      el("p", {
        class: "hint",
        text:
          "구글 폼 주소를 등록하면 이 학원 학생·학부모 포털에 '질문·문의' 탭이 생깁니다. " +
          "접수된 질문은 구글 폼의 응답 화면(또는 연결된 시트)에서 확인하고, " +
          "여러 학생에게 유용한 답변은 위 공지사항으로 올려 주세요. 저장 후 발행해야 반영됩니다.",
      }),
      el("label", { class: "field" }, [el("span", { text: "폼 주소" }), qnaIn]),
      el("button", {
        class: "btn btn-primary btn-small",
        text: "저장",
        onclick: () => {
          const v = qnaIn.value.trim();
          if (v && !/^https:\/\//i.test(v)) return toast("https:// 로 시작하는 주소를 입력해 주세요.", "error");
          if (v) blob.qnaUrl = v;
          else delete blob.qnaUrl;
          markAcademy(S.selAcademy);
          toast(v ? "저장되었습니다. 발행하면 포털에 '질문·문의' 탭이 생깁니다." : "폼 주소를 지웠습니다. 발행하면 탭이 사라집니다.", "ok");
        },
      }),
    ])
  );
}

// ---------- ⑦ 자료실 ----------
function renderMaterialsTab(container) {
  toolbar(container, { withWeek: false });
  const blob = academyBlob();
  blob.materials = blob.materials || [];
  const card = el("div", { class: "card" }, [el("h2", { text: `자료실 — ${academyEntry().name}` })]);

  // 업로드 폼
  const fileIn = el("input", { type: "file", accept: "application/pdf,.pdf" });
  const titleIn = el("input", { type: "text", placeholder: "자료 제목 (예: 화학 프린트 3)" });
  const weekSel = el("select");
  weekSel.appendChild(el("option", { value: "", text: "주차 미지정" }));
  for (const w of sortWeeks(blob.weeks)) weekSel.appendChild(el("option", { value: w.id, text: w.label }));

  card.appendChild(el("label", { class: "field" }, [el("span", { text: "PDF 파일" }), fileIn]));
  card.appendChild(el("label", { class: "field" }, [el("span", { text: "제목" }), titleIn]));
  card.appendChild(el("label", { class: "field" }, [el("span", { text: "주차" }), weekSel]));
  card.appendChild(
    el("button", {
      class: "btn btn-primary btn-small",
      text: "+ 추가",
      onclick: async () => {
        const f = fileIn.files[0];
        if (!f) return toast("파일을 선택해 주세요.", "error");
        if (f.size > 90 * 1024 * 1024) return toast("90MB를 넘는 파일은 올릴 수 없습니다 (GitHub 제한).", "error");
        if (f.size > 25 * 1024 * 1024) toast("파일이 큽니다 — 업로드와 열람이 느릴 수 있습니다.", "error");
        const bytes = new Uint8Array(await f.arrayBuffer());
        const id = randomHexId(16);
        const path = `data/m/${id}.bin`;
        blob.materials.push({
          id,
          weekId: weekSel.value || null,
          title: titleIn.value.trim() || f.name,
          path,
          origName: f.name,
          mime: f.type || "application/pdf",
          size: f.size,
        });
        S.pendingUploads.set(path, { bytes, academyFileId: S.selAcademy });
        markAcademy(S.selAcademy);
        toast("추가되었습니다. '발행'해야 학생들이 볼 수 있습니다.", "ok");
        renderTab();
      },
    })
  );

  // 목록
  const weekLabel = (id) => sortWeeks(blob.weeks).find((w) => w.id === id)?.label || "";
  if (!blob.materials.length) {
    card.appendChild(el("p", { class: "empty", text: "등록된 자료가 없습니다." }));
  }
  for (const m of blob.materials) {
    card.appendChild(
      el("div", { class: "material" }, [
        el("div", { class: "m-info" }, [
          el("div", { class: "m-title", text: m.title + (S.pendingUploads.has(m.path) ? " (발행 대기)" : "") }),
          el("div", { class: "m-meta", text: [weekLabel(m.weekId), formatBytes(m.size)].filter(Boolean).join(" · ") }),
        ]),
        el("div", { class: "m-actions" }, [
          el("button", {
            class: "btn btn-small btn-danger",
            text: "삭제",
            onclick: async () => {
              const ok = await confirmModal({
                title: "자료 삭제",
                body: `'${m.title}' 자료를 삭제할까요?`,
                okText: "삭제",
                danger: true,
              });
              if (!ok) return;
              blob.materials = blob.materials.filter((x) => x.id !== m.id);
              if (S.pendingUploads.has(m.path)) S.pendingUploads.delete(m.path);
              else S.pendingDeletes.add(m.path);
              markAcademy(S.selAcademy);
              renderTab();
            },
          }),
        ]),
      ])
    );
  }
  container.appendChild(card);
}

// ---------- ⑧ 진도 ----------
function renderProgressTab(container) {
  toolbar(container);
  const week = selectedWeek();
  const card = el("div", { class: "card" }, [el("h2", { text: "수업 진도" })]);
  if (!week) {
    card.appendChild(el("p", { class: "empty", text: "'주차 관리'에서 먼저 주차를 만들어 주세요." }));
    container.appendChild(card);
    return;
  }
  const ta = el("textarea", { rows: "4", placeholder: "예) 화학: 몰 개념 ~ 몰 농도 / 물리: 등가속도 운동" });
  ta.value = week.progress || "";
  ta.addEventListener("input", () => {
    week.progress = ta.value;
    markAcademy(S.selAcademy);
  });
  card.appendChild(ta);
  card.appendChild(el("p", { class: "hint", text: "학생 포털의 '출석·진도' 탭에 표시됩니다." }));
  container.appendChild(card);
}

// ---------- ⑨ 원장님 보고서 ----------
function renderDirectorTab(container) {
  toolbar(container);
  const week = selectedWeek();
  const card = el("div", { class: "card" }, [el("h2", { text: "원장님 주간 수업 현황 보고서" })]);
  if (!week) {
    card.appendChild(el("p", { class: "empty", text: "'주차 관리'에서 먼저 주차를 만들어 주세요." }));
    container.appendChild(card);
    return;
  }
  card.appendChild(
    el("p", {
      class: "hint",
      text: "이 보고서는 저장소에 올라가지 않고 이 브라우저에서만 만들어집니다. PDF로 저장한 뒤 카톡·메일로 직접 보내세요.",
    })
  );

  const { checks, doc } = buildDirectorReport({
    academyName: academyEntry().name,
    weeks: academyBlob().weeks,
    quizzes: academyBlob().quizzes || [],
    weekId: week.id,
    students: activeStudentsOf(S.selAcademy).map((st) => ({
      name: st.name,
      blob: S.students.get(st.fileId),
    })),
    notices: academyBlob().notices,
    teacherName: S.roster.teacher?.name,
    dirty: dirtyCount() > 0,
  });

  // 누락 항목 검사 결과
  const panel = el("div", { class: "check-panel" });
  for (const c of checks) {
    const icon = c.level === "ok" ? "✅" : c.level === "warn" ? "⚠️" : "ℹ️";
    panel.appendChild(el("div", { class: `check-item ${c.level}`, text: `${icon} ${c.text}` }));
  }
  card.appendChild(panel);

  card.appendChild(
    el("button", {
      class: "btn btn-primary btn-block",
      text: "🖨️ PDF로 저장 (인쇄 창에서 '대상: PDF로 저장' 선택)",
      onclick: () => {
        const root = $("#print-root");
        clear(root);
        root.className = "print-report";
        root.appendChild(doc.cloneNode(true));
        window.print();
      },
    })
  );
  card.appendChild(el("div", { class: "table-wrap report-preview" }, [doc]));
  container.appendChild(card);
}

// ---------- ⑩ 발행 ----------
// 발행 직전 안전장치: 이 화면을 연 뒤 다른 탭/기기에서 발행된 적이 있으면
// 지금 발행이 그 내용을 이전 상태로 되돌릴 수 있으므로 경고한다.
// 토큰이 있으면 저장소에서 직접(Pages 반영 지연과 무관), 없으면 사이트의 meta.json으로 확인.
async function confirmNotStale(token, repo) {
  if (!S.ownPublishedAts.size) return true; // 첫 발행·마법사 직후 등 비교 기준 없음
  let siteAt = null;
  try {
    if (token && repo?.owner && repo?.name) {
      const res = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/data/meta.json?ref=${encodeURIComponent(repo.branch || "main")}`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw+json" },
          cache: "no-store",
        }
      );
      if (res.ok) siteAt = (await res.json()).publishedAt || null;
    }
    if (siteAt == null) {
      const res = await fetch("data/meta.json?t=" + Date.now(), { cache: "no-store" });
      if (res.ok) siteAt = (await res.json()).publishedAt || null;
    }
  } catch {
    /* 확인 실패(오프라인 등) → 발행을 막지 않는다 */
  }
  if (siteAt == null || S.ownPublishedAts.has(siteAt)) return true;
  const fmt = (iso) => new Date(iso).toLocaleString("ko-KR");
  const mine = [...S.ownPublishedAts].pop(); // 이 세션의 가장 최근 기준 시각
  return confirmModal({
    title: "⚠️ 다른 곳에서 발행된 뒤입니다",
    body:
      `이 관리 화면을 연 이후에 다른 탭이나 기기에서 발행이 있었습니다.\n\n` +
      `· 이 화면이 아는 발행: ${fmt(mine)}\n` +
      `· 사이트의 최신 발행: ${fmt(siteAt)}\n\n` +
      `지금 발행하면 그 사이에 올라간 공지·점수 등의 변경이 이전 상태로 덮어써질 수 있습니다.\n` +
      `안전하게 하려면 취소한 뒤 페이지를 새로고침해 다시 로그인하고 작업해 주세요.`,
    okText: "위험을 알고 발행",
    danger: true,
  });
}

function renderPublishTab(container) {
  const card = el("div", { class: "card" }, [el("h2", { text: "발행" })]);
  card.appendChild(
    el("p", {
      class: "hint",
      text: "지금까지의 변경 사항을 암호화해서 GitHub 저장소에 올립니다. 올린 뒤 1~2분이면 사이트에 반영됩니다.",
    })
  );

  // 저장소 설정
  const guess = guessRepoFromLocation();
  const repo = S.roster.repo || (S.roster.repo = { owner: "", name: "", branch: "main" });
  if (!repo.owner && guess) Object.assign(repo, { owner: guess.owner, name: guess.repo });
  const ownerIn = el("input", { type: "text", value: repo.owner, placeholder: "GitHub 사용자명" });
  const nameIn = el("input", { type: "text", value: repo.name, placeholder: "저장소 이름" });
  const branchIn = el("input", { type: "text", value: repo.branch || "main" });
  const saveRepo = () => {
    if (repo.owner !== ownerIn.value.trim() || repo.name !== nameIn.value.trim() || repo.branch !== branchIn.value.trim()) {
      repo.owner = ownerIn.value.trim();
      repo.name = nameIn.value.trim();
      repo.branch = branchIn.value.trim() || "main";
      markRoster();
    }
  };

  // PAT
  const savedPAT = localStorage.getItem("shs.pat") || sessionStorage.getItem("shs.pat") || "";
  const patIn = el("input", { type: "password", value: savedPAT, placeholder: "github_pat_… (Contents 권한)" });
  const patPersist = el("input", { type: "checkbox", checked: !!localStorage.getItem("shs.pat") });

  const log = el("div", { class: "publish-log", text: "" });
  const logLine = (s) => {
    log.textContent += s + "\n";
    log.scrollTop = log.scrollHeight;
  };

  const publishBtn = el("button", { class: "btn btn-primary btn-block", text: "🚀 GitHub에 발행 (자동 커밋)" });
  publishBtn.addEventListener("click", async () => {
    saveRepo();
    const token = patIn.value.trim();
    if (!repo.owner || !repo.name) return toast("저장소 정보를 입력해 주세요.", "error");
    if (!token) return toast("PAT(개인 접근 토큰)를 입력해 주세요.", "error");
    if (patPersist.checked) {
      localStorage.setItem("shs.pat", token);
      sessionStorage.removeItem("shs.pat");
    } else {
      sessionStorage.setItem("shs.pat", token);
      localStorage.removeItem("shs.pat");
    }
    publishBtn.disabled = true;
    log.textContent = "";
    try {
      logLine("사이트 최신 발행 확인 중…");
      if (!(await confirmNotStale(token, repo))) {
        logLine("발행을 취소했습니다. 새로고침 후 다시 로그인하면 최신 상태에서 작업할 수 있습니다.");
        publishBtn.disabled = false;
        return;
      }
      logLine("데이터 암호화 중…");
      const { files, deletes } = await buildPublishFiles("api");
      const stamp = toYMD(new Date());
      const { commitSha } = await publishToGitHub({
        owner: repo.owner,
        repo: repo.name,
        branch: repo.branch || "main",
        token,
        files,
        deletes,
        message: `발행: ${stamp}`,
        onProgress: (_step, detail) => logLine(detail),
      });
      clearDirty();
      logLine(`완료! 커밋 ${commitSha.slice(0, 7)} — 1~2분 뒤 사이트에 반영됩니다.`);
      toast("발행 완료!", "ok");
    } catch (e) {
      console.error(e);
      logLine("오류: " + e.message);
      toast(e.message, "error");
    }
    publishBtn.disabled = false;
    updateBadge();
  });

  const zipBtn = el("button", { class: "btn btn-block", text: "📦 ZIP 다운로드 (수동 업로드용)" });
  zipBtn.addEventListener("click", async () => {
    saveRepo();
    zipBtn.disabled = true;
    try {
      if (!(await confirmNotStale(patIn.value.trim() || null, repo))) {
        zipBtn.disabled = false;
        return;
      }
      const { files } = await buildPublishFiles("zip");
      const zipFiles = files.map((f) => ({ path: f.path, bytes: f.bytes }));
      const stamp = toYMD(new Date()).replaceAll("-", "");
      downloadBlob(buildZip(zipFiles), `발행_${stamp}.zip`);
      S.zipDownloaded = true;
      logLine("ZIP이 저장되었습니다. 압축을 푼 뒤 GitHub 저장소 페이지에서 'Add file → Upload files'로 data 폴더를 끌어다 놓고 커밋하세요. (자세한 방법은 README 참고)");
    } catch (e) {
      console.error(e);
      toast(e.message, "error");
    }
    zipBtn.disabled = false;
  });

  const zipDoneBtn = el("button", { class: "btn btn-small", text: "수동 업로드를 완료했습니다 (변경 표시 지우기)" });
  zipDoneBtn.addEventListener("click", () => {
    clearDirty();
    updateBadge();
    toast("확인했습니다.", "ok");
  });

  card.appendChild(el("h3", { text: "저장소 정보", style: "font-size:15px" }));
  card.appendChild(el("label", { class: "field" }, [el("span", { text: "GitHub 사용자명(소유자)" }), ownerIn]));
  card.appendChild(el("label", { class: "field" }, [el("span", { text: "저장소 이름" }), nameIn]));
  card.appendChild(el("label", { class: "field" }, [el("span", { text: "브랜치" }), branchIn]));
  card.appendChild(el("h3", { text: "개인 접근 토큰 (PAT)", style: "font-size:15px;margin-top:14px" }));
  card.appendChild(
    el("p", {
      class: "hint",
      text: "GitHub → Settings → Developer settings → Fine-grained tokens에서 이 저장소만, Contents(Read and write) 권한으로 만든 토큰을 사용하세요. 토큰은 이 브라우저에만 저장되며 저장소에는 절대 올라가지 않습니다.",
    })
  );
  card.appendChild(el("label", { class: "field" }, [patIn]));
  card.appendChild(el("label", { class: "check" }, [patPersist, "이 브라우저에 토큰 저장 (개인 기기에서만 체크)"]));
  card.appendChild(publishBtn);
  card.appendChild(el("div", { style: "height:8px" }));
  card.appendChild(zipBtn);
  card.appendChild(el("div", { style: "height:8px" }));
  card.appendChild(zipDoneBtn);
  card.appendChild(log);
  container.appendChild(card);

  // ---------- 접속 통계 (릴리스 다운로드 카운터 — README '접속 통계' 참고) ----------
  // 포털이 로그인 성공 시 릴리스(visit-counter)의 작은 파일을 받아가고,
  // 여기서는 GitHub 공개 API로 그 다운로드 횟수를 읽어 보여준다.
  const statsCard = el("div", { class: "card" }, [el("h2", { text: "접속 통계" })]);
  statsCard.appendChild(
    el("p", {
      class: "hint",
      text: "학생·학부모/선생님 로그인 횟수입니다 (탭 기준 1회, 고유 인원 아님). GitHub 릴리스 다운로드 카운트로 집계하므로 외부 서비스가 없고, 학생·선생님 화면에는 표시되지 않습니다.",
    })
  );
  const statsBox = el("div", { class: "visit-stats", text: "불러오는 중…" });
  statsCard.appendChild(statsBox);
  const statsBtn = el("button", { class: "btn btn-small", text: "↻ 새로고침" });
  statsBtn.addEventListener("click", () => loadVisitStats());
  statsCard.appendChild(statsBtn);
  async function loadVisitStats() {
    const owner = ownerIn.value.trim();
    const name = nameIn.value.trim();
    if (!owner || !name) {
      statsBox.textContent = "위 '저장소 정보'(사용자명·저장소 이름)를 입력하면 접속 통계를 불러옵니다.";
      return;
    }
    statsBox.textContent = "불러오는 중…";
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${name}/releases/tags/visit-counter`,
        { cache: "no-store" }
      );
      if (res.status === 404) {
        statsBox.textContent =
          "아직 'visit-counter' 릴리스가 없습니다. README의 '접속 통계 켜기' 안내대로 릴리스를 한 번 만들면 다음 로그인부터 집계됩니다.";
        return;
      }
      if (!res.ok) throw new Error(`GitHub API 오류 (${res.status})`);
      const rel = await res.json();
      const cnt = (n) => rel.assets?.find((a) => a.name === n)?.download_count;
      const s = cnt("visit-student.bin");
      const t = cnt("visit-teacher.bin");
      let prev = null;
      try {
        prev = JSON.parse(localStorage.getItem("shs.visitstats"));
      } catch {
        /* 무시 */
      }
      const line = (cur, key) =>
        cur == null
          ? "릴리스에 파일이 없습니다"
          : `누적 ${cur}회` +
            (prev && prev[key] != null ? ` (지난 확인 이후 +${Math.max(0, cur - prev[key])})` : "");
      statsBox.textContent =
        `학생·학부모 · ${line(s, "student")}\n선생님 · ${line(t, "teacher")}` +
        (prev?.at ? `\n지난 확인 · ${prev.at}` : "");
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      localStorage.setItem(
        "shs.visitstats",
        JSON.stringify({ student: s, teacher: t, at: `${toYMD(now)} ${hhmm}` })
      );
    } catch (e) {
      statsBox.textContent = "통계를 불러오지 못했습니다: " + e.message;
    }
  }
  loadVisitStats();
  container.appendChild(statsCard);

  // 백업/비밀번호
  const card2 = el("div", { class: "card" }, [el("h2", { text: "백업 · 비밀번호" })]);
  card2.appendChild(
    el("button", {
      class: "btn btn-block",
      text: "💾 백업 다운로드 (평문 JSON — 안전한 곳에 보관)",
      onclick: async () => {
        if (dirtyCount() > 0) {
          const ok = await confirmModal({
            title: "발행 전 백업",
            body: "발행하지 않은 변경과 업로드 대기 파일(PDF 등)은 백업에 포함되지 않습니다. 먼저 '발행'한 뒤 백업하는 것을 권장합니다. 그래도 지금 백업할까요?",
            okText: "지금 백업",
          });
          if (!ok) return;
        }
        const backup = {
          v: S.meta.v,
          savedAt: new Date().toISOString(),
          meta: S.meta,
          roster: S.roster,
          academies: Object.fromEntries(S.academies),
          students: Object.fromEntries(S.students),
        };
        const stamp = toYMD(new Date()).replaceAll("-", "");
        downloadBlob(
          new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }),
          `학원포털백업_${stamp}.json`
        );
        toast("백업은 암호화되지 않은 파일입니다. 개인 컴퓨터에만 보관하세요.", "ok");
      },
    })
  );
  card2.appendChild(el("div", { style: "height:8px" }));
  card2.appendChild(
    el("button", {
      class: "btn btn-block",
      text: "🔑 마스터 비밀번호 변경",
      onclick: changeMasterPassword,
    })
  );
  container.appendChild(card2);
}

async function changeMasterPassword() {
  const pw1 = el("input", { type: "password" });
  const pw2 = el("input", { type: "password" });
  const err = el("p", { class: "error-text" });
  const overlay = el("div", { class: "modal-overlay" });
  overlay.appendChild(
    el("div", { class: "modal" }, [
      el("h3", { text: "마스터 비밀번호 변경" }),
      el("label", { class: "field" }, [el("span", { text: "새 비밀번호 (12자 이상)" }), pw1]),
      el("label", { class: "field" }, [el("span", { text: "확인" }), pw2]),
      err,
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn", text: "취소", onclick: () => overlay.remove() }),
        el("button", {
          class: "btn btn-primary",
          text: "변경",
          onclick: async () => {
            const p = normalizePassword(pw1.value);
            if (p.length < 12) return (err.textContent = "12자 이상이어야 합니다.");
            if (p !== normalizePassword(pw2.value)) return (err.textContent = "일치하지 않습니다.");
            S.meta.saltMaster = randomSaltB64();
            S.masterKey = await deriveMasterKey(p, S.meta.saltMaster, S.meta.kdf.iterMaster);
            markRoster();
            overlay.remove();
            toast("변경되었습니다. '발행'해야 적용됩니다.", "ok");
          },
        }),
      ]),
    ])
  );
  document.body.appendChild(overlay);
}

// ---------- 발행 파이프라인 ----------
function clearDirty() {
  S.dirtyStudents.clear();
  S.dirtyAcademies.clear();
  S.rosterDirty = false;
  S.pendingUploads.clear();
  S.pendingDeletes.clear();
  S.zipDownloaded = false;
}

// 선생님 열람용 집계 스냅샷: 출석표 + 학생별 성적표 (둘 다 이 학원 학생 이름 포함)
function buildTeacherSnapshot(academyFileId) {
  const aBlob = S.academies.get(academyFileId);
  const students = activeStudentsOf(academyFileId);
  const attendance = {};
  for (const w of aBlob.weeks || []) {
    attendance[w.id] = students.map((st) => ({
      name: st.name,
      byDate: { ...(S.students.get(st.fileId)?.weeks?.[w.id]?.attendance || {}) },
    }));
  }
  // 학생별 성적: 성적표(이름×단원)와 분포 히스토그램이 같은 데이터를 사용
  const scores = students.map((st) => ({
    name: st.name,
    byQuiz: { ...(S.students.get(st.fileId)?.quizzes || {}) },
  }));
  // 숙제 체크 상태 (주차별 학생×항목)
  const homework = {};
  for (const w of aBlob.weeks || []) {
    homework[w.id] = students.map((st) => ({
      name: st.name,
      byItem: { ...(S.students.get(st.fileId)?.weeks?.[w.id]?.homework || {}) },
    }));
  }
  // 개별 리포트: 전달사항 텍스트 + 분석 PDF 유무(파일명만 — 파일 자체는 학생 키 암호화라 포함하지 않음)
  const reports = {};
  for (const q of aBlob.quizzes || []) {
    const rows = [];
    for (const st of students) {
      const rep = S.students.get(st.fileId)?.quizReports?.[q.id];
      if (!rep || (!rep.note && !rep.pdf)) continue;
      rows.push({
        name: st.name,
        ...(rep.note ? { note: rep.note } : {}),
        ...(rep.pdf ? { pdfName: rep.pdf.origName } : {}),
      });
    }
    if (rows.length) reports[q.id] = rows;
  }
  return { attendance, scores, homework, reports };
}

// mode: "api" → 변경분만(base64) + 삭제 목록 / "zip" → 전체 파일(bytes)
async function buildPublishFiles(mode) {
  const enc = new TextEncoder();
  const all = mode === "zip";

  // 1) 학생 blob의 academy 정보를 roster 기준으로 동기화 (키 교체 반영)
  for (const st of S.roster.students) {
    const aEntry = S.roster.academies.find((a) => a.fileId === st.academyFileId);
    const blob = S.students.get(st.fileId);
    if (!blob || !aEntry) continue;
    const cur = blob.academy || {};
    if (cur.fileId !== aEntry.fileId || cur.key !== aEntry.key || cur.name !== aEntry.name) {
      blob.academy = { fileId: aEntry.fileId, key: aEntry.key, name: aEntry.name };
      S.dirtyStudents.add(st.fileId);
    }
    blob.name = st.name;
  }
  // 2) 전체 평균 재계산 (단원명이 같은 퀴즈는 전 학원 학생 합산)
  recomputeStats();

  // 3) meta 갱신
  S.meta.students = S.roster.students.map((s) => s.fileId);
  S.meta.academies = S.roster.academies.map((a) => a.fileId);
  S.meta.teachers = (S.roster.teachers || []).map((t) => t.fileId);
  S.meta.publishedAt = new Date().toISOString();
  S.ownPublishedAts.add(S.meta.publishedAt); // 이 세션의 발행(ZIP 포함)은 충돌 경고 대상이 아님

  const files = [];
  const push = (path, bytes) => {
    files.push({ path, bytes, base64: b64encode(bytes) });
  };
  const pushJSON = (path, obj) => push(path, enc.encode(JSON.stringify(obj, null, 1)));

  pushJSON("data/meta.json", S.meta);

  // roster (항상 포함: 작은 파일이고 일관성 보장)
  pushJSON("data/roster.json", await encryptJSON(S.masterKey, S.roster));

  for (const a of S.roster.academies) {
    if (!all && !S.dirtyAcademies.has(a.fileId)) continue;
    const key = await importAesKeyB64(a.key);
    pushJSON(`data/a/${a.fileId}.json`, await encryptJSON(key, S.academies.get(a.fileId)));
  }
  for (const st of S.roster.students) {
    if (!all && !S.dirtyStudents.has(st.fileId)) continue;
    const key = await importAesKeyB64(st.encKey);
    pushJSON(`data/s/${st.fileId}.json`, await encryptJSON(key, S.students.get(st.fileId)));
  }
  // 선생님 열람 파일: 출석·점수 분포 스냅샷이 매 발행마다 최신으로 재생성되므로 항상 포함
  for (const t of S.roster.teachers || []) {
    const aEntry = S.roster.academies.find((a) => a.fileId === t.academyFileId);
    if (!aEntry) continue;
    const key = await importAesKeyB64(t.encKey);
    const blob = {
      v: FORMAT_VERSION,
      type: "teacher",
      name: t.name,
      academy: { fileId: aEntry.fileId, key: aEntry.key, name: aEntry.name },
      snapshot: buildTeacherSnapshot(t.academyFileId),
    };
    pushJSON(`data/t/${t.fileId}.json`, await encryptJSON(key, blob));
  }

  for (const [path, up] of S.pendingUploads) {
    // 학생 대상(개인 분석 PDF) 또는 학원 대상(자료실) — 소유자를 못 찾으면
    // 조용히 건너뛰지 않고 발행을 중단한다 (무음 데이터 손실 방지)
    const encKeyB64 = up.studentFileId
      ? S.roster.students.find((s) => s.fileId === up.studentFileId)?.encKey
      : S.roster.academies.find((a) => a.fileId === up.academyFileId)?.key;
    if (!encKeyB64) {
      throw new Error(`업로드 파일의 소유자를 찾을 수 없습니다 (${path}). 발행이 중단되었습니다.`);
    }
    const key = await importAesKeyB64(encKeyB64);
    push(path, new Uint8Array(await encryptBytes(key, up.bytes)));
  }

  return { files, deletes: [...S.pendingDeletes] };
}
