// setup.js — 초기 설정 마법사 + 학생 코드 카드 인쇄
import {
  ITER_STUDENT,
  ITER_MASTER,
  FORMAT_VERSION,
  generateCode,
  deriveStudentKeys,
  deriveMasterKey,
  exportAesKeyB64,
  randomSaltB64,
  randomKeyB64,
  randomHexId,
  normalizePassword,
} from "./crypto.js";
import { $, el, clear, toast, setBusy } from "./ui.js";

// 빈 학생 blob
export function emptyStudentBlob(name, academyEntry) {
  return {
    v: FORMAT_VERSION,
    name,
    academy: { fileId: academyEntry.fileId, key: academyEntry.key, name: academyEntry.name },
    weeks: {},
  };
}

// 빈 학원 blob
export function emptyAcademyBlob(name) {
  return { v: FORMAT_VERSION, name, weeks: [], notices: [], materials: [] };
}

// 학생 생성: 코드 발급 + 키 유도 → roster 항목과 blob 반환
export async function createStudent(name, academyEntry, saltStudent) {
  const code = generateCode();
  const { fileId, aesKey } = await deriveStudentKeys(code, saltStudent, ITER_STUDENT);
  const encKey = await exportAesKeyB64(aesKey);
  return {
    rosterEntry: {
      code,
      name,
      fileId,
      encKey,
      academyFileId: academyEntry.fileId,
      active: true,
    },
    blob: emptyStudentBlob(name, academyEntry),
  };
}

// ---------- 마법사 ----------
// onComplete(model): model = {meta, roster, academies:Map, students:Map, masterKey}
export function runWizard(mount, { siteURL, onComplete }) {
  const state = {
    password: "",
    teacherName: "",
    siteTitle: "과학고 대비 학습 포털",
    academyNames: ["", ""],
    studentNames: {}, // academyIndex -> string
  };
  let step = 0;
  const steps = [renderStep1, renderStep2, renderStep3, renderStep4];

  function nav(back, nextLabel, onNext) {
    return el("div", { class: "wizard-nav" }, [
      back
        ? el("button", {
            class: "btn",
            text: "← 이전",
            onclick: () => {
              step--;
              render();
            },
          })
        : el("span"),
      el("button", { class: "btn btn-primary", text: nextLabel, onclick: onNext }),
    ]);
  }

  function render() {
    clear(mount);
    mount.appendChild(
      el("div", { class: "card" }, [
        el("div", { class: "step-indicator", text: `초기 설정 ${step + 1} / ${steps.length}` }),
        steps[step](),
      ])
    );
  }

  // 1) 마스터 비밀번호
  function renderStep1() {
    const pw1 = el("input", { type: "password", autocomplete: "new-password" });
    const pw2 = el("input", { type: "password", autocomplete: "new-password" });
    const err = el("p", { class: "error-text" });
    return el("div", { class: "wizard-step" }, [
      el("h2", { text: "마스터 비밀번호 만들기" }),
      el("p", {
        class: "hint",
        text: "선생님만 아는 비밀번호입니다. 모든 학생 데이터가 이 비밀번호로 보호됩니다. 잊어버리면 복구할 수 없으니 안전한 곳에 적어 두세요. (최소 12자, 문장형 추천)",
      }),
      el("label", { class: "field" }, [el("span", { text: "마스터 비밀번호" }), pw1]),
      el("label", { class: "field" }, [el("span", { text: "비밀번호 확인" }), pw2]),
      err,
      nav(false, "다음 →", () => {
        const p = normalizePassword(pw1.value);
        if (p.length < 12) {
          err.textContent = "비밀번호는 12자 이상이어야 합니다. 기억하기 쉬운 문장을 추천합니다.";
          return;
        }
        if (p !== normalizePassword(pw2.value)) {
          err.textContent = "두 비밀번호가 일치하지 않습니다.";
          return;
        }
        state.password = p;
        step++;
        render();
      }),
    ]);
  }

  // 2) 기본 정보
  function renderStep2() {
    const nameInput = el("input", { type: "text", value: state.teacherName, placeholder: "예) 김과학" });
    const titleInput = el("input", { type: "text", value: state.siteTitle });
    return el("div", { class: "wizard-step" }, [
      el("h2", { text: "기본 정보" }),
      el("label", { class: "field" }, [el("span", { text: "선생님 이름" }), nameInput]),
      el("label", { class: "field" }, [el("span", { text: "사이트 제목" }), titleInput]),
      nav(true, "다음 →", () => {
        state.teacherName = nameInput.value.trim();
        state.siteTitle = titleInput.value.trim() || "과학고 대비 학습 포털";
        step++;
        render();
      }),
    ]);
  }

  // 3) 학원 이름
  function renderStep3() {
    const list = el("div");
    const inputs = [];
    const addRow = (value = "") => {
      const input = el("input", { type: "text", value, placeholder: `학원 이름` });
      inputs.push(input);
      list.appendChild(el("label", { class: "field" }, [el("span", { text: `학원 ${inputs.length}` }), input]));
    };
    state.academyNames.forEach((n) => addRow(n));
    const err = el("p", { class: "error-text" });
    return el("div", { class: "wizard-step" }, [
      el("h2", { text: "학원(반) 등록" }),
      el("p", { class: "hint", text: "학원별로 공지·자료실·반 평균이 완전히 분리됩니다." }),
      list,
      el("button", { class: "btn btn-small", text: "+ 학원 추가", onclick: () => addRow() }),
      err,
      nav(true, "다음 →", () => {
        const names = inputs.map((i) => i.value.trim()).filter(Boolean);
        if (!names.length) {
          err.textContent = "학원을 1개 이상 입력해 주세요.";
          return;
        }
        state.academyNames = names;
        step++;
        render();
      }),
    ]);
  }

  // 4) 학생 명단
  function renderStep4() {
    const areas = state.academyNames.map((name, i) =>
      el("label", { class: "field" }, [
        el("span", { text: `${name} 학생 명단 (한 줄에 한 명)` }),
        el("textarea", {
          rows: "6",
          placeholder: "김철수\n이영희\n…",
          oninput: (e) => (state.studentNames[i] = e.target.value),
        }, [state.studentNames[i] || ""]),
      ])
    );
    const err = el("p", { class: "error-text" });
    const wrap = el("div", { class: "wizard-step" }, [
      el("h2", { text: "학생 명단 입력" }),
      ...areas,
      err,
      nav(true, "생성하기 ✨", async () => {
        const rosters = state.academyNames.map((_, i) =>
          (state.studentNames[i] || "")
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        );
        if (!rosters.some((r) => r.length)) {
          err.textContent = "학생을 1명 이상 입력해 주세요.";
          return;
        }
        setBusy(mount, "코드를 생성하고 암호화 키를 만드는 중… (수십 초 걸릴 수 있습니다)");
        try {
          const model = await buildModel(state, rosters, siteURL);
          onComplete(model);
        } catch (e) {
          console.error(e);
          toast("생성 중 오류가 발생했습니다: " + e.message, "error");
          render();
        }
      }),
    ]);
    return wrap;
  }

  render();
}

async function buildModel(state, rosters, siteURL) {
  const saltStudent = randomSaltB64();
  const saltMaster = randomSaltB64();
  const masterKey = await deriveMasterKey(state.password, saltMaster, ITER_MASTER);

  const academyEntries = state.academyNames.map((name) => ({
    fileId: randomHexId(16),
    key: randomKeyB64(),
    name,
  }));

  const academies = new Map();
  const students = new Map();
  const rosterStudents = [];

  for (let i = 0; i < academyEntries.length; i++) {
    academies.set(academyEntries[i].fileId, emptyAcademyBlob(academyEntries[i].name));
    for (const name of rosters[i]) {
      const { rosterEntry, blob } = await createStudent(name, academyEntries[i], saltStudent);
      rosterStudents.push(rosterEntry);
      students.set(rosterEntry.fileId, blob);
    }
  }

  const meta = {
    v: FORMAT_VERSION,
    site: { title: state.siteTitle },
    kdf: { algo: "PBKDF2-SHA256", iterStudent: ITER_STUDENT, iterMaster: ITER_MASTER },
    saltStudent,
    saltMaster,
    students: rosterStudents.map((s) => s.fileId),
    academies: academyEntries.map((a) => a.fileId),
    teachers: [],
    publishedAt: null,
  };

  const roster = {
    v: FORMAT_VERSION,
    teacher: { name: state.teacherName },
    repo: { owner: "", name: "", branch: "main" },
    siteURL: siteURL || "",
    academies: academyEntries,
    students: rosterStudents,
    teachers: [], // 선생님 열람 코드 (학생 관리 탭에서 발급)
  };

  return { meta, roster, academies, students, masterKey };
}

// ---------- 코드 카드 인쇄 ----------
// entries: [{name, code, academyName}]
export function printCodeCards(entries, siteTitle, siteURL) {
  const root = $("#print-root");
  clear(root);
  root.className = "print-cards"; // 인쇄 루트는 보고서와 공유 — 용도별 클래스 지정
  for (const e of entries) {
    root.appendChild(
      el("div", { class: "code-card" }, [
        el("div", { class: "cc-title", text: siteTitle }),
        el("div", { class: "cc-name", text: `${e.name} (${e.academyName})` }),
        el("div", { class: "cc-code", text: e.code }),
        el("div", { class: "cc-url", text: siteURL }),
        el("div", {
          class: "cc-help",
          text: "① 위 주소로 접속 ② 코드 입력 ③ '자동 로그인' 체크\n코드는 다른 사람에게 알려주지 마세요.",
        }),
      ])
    );
  }
  window.print();
}
