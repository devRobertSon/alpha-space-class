// github.js — 브라우저에서 GitHub Git Data API로 원자적 1커밋 발행
// Contents API 대신 Git Data API 사용: 여러 파일 = 커밋 1개 = Pages 빌드 1회, 삭제 지원.
//
// files:   [{path, base64}]  (JSON은 UTF-8 → base64, 바이너리는 그대로 base64)
// deletes: [path]
// onProgress(step, detail)

const API = "https://api.github.com";

async function gh(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).message || "";
    } catch {
      /* ignore */
    }
    const err = new Error(friendlyError(res.status, detail));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function friendlyError(status, detail) {
  switch (status) {
    case 401:
      return "토큰이 유효하지 않거나 만료되었습니다. PAT를 다시 확인해 주세요.";
    case 403:
      return `권한이 없습니다. PAT에 이 저장소의 Contents(Read and write) 권한이 있는지 확인해 주세요. (${detail})`;
    case 404:
      return "저장소 또는 브랜치를 찾을 수 없습니다. 소유자/저장소/브랜치 이름과 PAT의 저장소 접근 범위를 확인해 주세요.";
    case 409:
    case 422:
      return `발행 중 충돌이 발생했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요. (${detail})`;
    default:
      return `GitHub API 오류 (HTTP ${status}) ${detail}`;
  }
}

export async function publishToGitHub({
  owner,
  repo,
  branch,
  token,
  files,
  deletes = [],
  message,
  onProgress = () => {},
}) {
  const base = `/repos/${owner}/${repo}`;

  onProgress("ref", "브랜치 정보 확인 중…");
  const ref = await gh(token, "GET", `${base}/git/ref/heads/${encodeURIComponent(branch)}`);
  const headSha = ref.object.sha;

  const headCommit = await gh(token, "GET", `${base}/git/commits/${headSha}`);
  const baseTree = headCommit.tree.sha;

  const tree = [];
  let done = 0;
  for (const f of files) {
    onProgress("blob", `파일 업로드 중… (${++done}/${files.length}) ${f.path}`);
    const blob = await gh(token, "POST", `${base}/git/blobs`, {
      content: f.base64,
      encoding: "base64",
    });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (const path of deletes) {
    tree.push({ path, mode: "100644", type: "blob", sha: null });
  }

  onProgress("tree", "파일 목록 구성 중…");
  const newTree = await gh(token, "POST", `${base}/git/trees`, {
    base_tree: baseTree,
    tree,
  });

  onProgress("commit", "커밋 생성 중…");
  const commit = await gh(token, "POST", `${base}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [headSha],
  });

  onProgress("push", "브랜치 갱신 중…");
  // force:false → 그 사이 다른 push가 있었으면 422로 안전하게 실패
  await gh(token, "PATCH", `${base}/git/refs/heads/${encodeURIComponent(branch)}`, {
    sha: commit.sha,
    force: false,
  });

  return { commitSha: commit.sha };
}

// 현재 Pages 주소에서 owner/repo 추정 (user.github.io/repo 형태)
export function guessRepoFromLocation() {
  const host = location.hostname; // ex) devrobertson.github.io
  const m = host.match(/^([^.]+)\.github\.io$/i);
  if (!m) return null;
  const seg = location.pathname.split("/").filter(Boolean);
  return { owner: m[1], repo: seg.length ? seg[0] : `${m[1]}.github.io`, branch: "main" };
}
