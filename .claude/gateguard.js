#!/usr/bin/env node
/**
 * GateGuard — 편집 전 사실 조사 강제 게이트 (PreToolUse 훅)
 *
 * ── 출처 ────────────────────────────────────────────────────────────────
 * 개념·게이트 문구의 원안: ECC (https://github.com/affaan-m/ECC), MIT License,
 *   Copyright (c) 2026 Affaan Mustafa — `scripts/hooks/gateguard-fact-force.js`.
 *   원본은 zunoworks/gateguard 도 함께 출처로 밝히고 있다.
 * 이 파일은 원본 1,278줄을 그대로 옮긴 것이 아니라, 개념만 가져와 우리 규약에 맞게
 *   다시 쓴 것이다(의존성 0, 약 180줄). 원본 로직·파일은 포함하지 않는다.
 *   가져오지 않은 이유: 규약 5-0 "길어지면 안 읽히고 진짜 규칙이 묻힌다".
 *
 * ── 왜 이게 필요한가 ────────────────────────────────────────────────────
 * 원본의 관찰(그대로 옮길 값어치가 있어 인용한다):
 *   "LLM 자기평가는 작동하지 않는다. '정책을 위반했나?' 라고 물으면 답은 언제나
 *    '아니오' 다. 그러나 '이 모듈을 import 하는 파일을 전부 나열하라' 고 물으면
 *    LLM 은 Grep 과 Read 를 실행할 수밖에 없다. 조사 그 자체가 출력을 바꾼다."
 *
 * 우리 규약 1항("확인 전에 단언하지 않는다")은 내가 지키기로 약속하는 문장이다.
 * 이 훅은 내가 안 지키면 도구가 막는 장치다. 약속과 장치는 다르다.
 *
 * ── 우리가 원본에 더한 것 ───────────────────────────────────────────────
 * 원본은 importer·공개 API·데이터 스키마를 요구한다. 그런데 2026-07-17 에 실제로
 * 사고를 낸 것은 그게 아니라 **있다고 착각한 심볼**이었다. 한 세션에서 3건:
 *   - CSS 클래스 `.bar` `.tbl-wrap` `.tbl`  → 전부 부존재 (실제: `tblwrap`, 그냥 <table>)
 *   - CSS 변수 `--warn` `--down`            → 전부 부존재 (실제: `--stale`, `--fail`)
 *   - D1 테이블 `live`                       → 부존재 (직접 만들어야 했다)
 * 셋 다 문법검사를 통과하고 화면만 조용히 깨진다. 그래서 1번 항목을 신설했다.
 *
 * ── 끄는 법 ─────────────────────────────────────────────────────────────
 *   GATEGUARD=off        전체 해제
 * 게이트는 **파일당 세션당 한 번**만 막는다. 사실을 제시하고 같은 편집을 다시 하면 통과한다.
 * 두 번째 편집부터는 막지 않는다 — 조사는 이미 컨텍스트에 있다.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const OFF = new Set(['off', '0', 'false', 'no']);
const STATE_DIR = path.join(os.tmpdir(), 'claude-gateguard');
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6시간 — 세션 하나가 이보다 길면 다시 물어도 손해가 아니다
const MAX_FILES = 500;                     // 무한 증식 방지

// 게이트를 걸지 않는 것들. 조사할 것이 없거나, 조사 비용이 이득보다 큰 파일.
// scratchpad·로그·잠금파일은 조사해도 나올 사실이 없다.
const SKIP = [
  /[\\/]scratchpad[\\/]/i, /[\\/]node_modules[\\/]/, /[\\/]\.git[\\/]/,
  /[\\/]dist[\\/]/, /[\\/]build[\\/]/, /[\\/]\.venv[\\/]/, /[\\/]__pycache__[\\/]/,
  /package-lock\.json$/, /yarn\.lock$/, /\.log$/, /\.tmp$/, /\.snap\.db/,
  /[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i,
];

function read(stream) {
  return new Promise((res) => {
    let d = '';
    stream.setEncoding('utf8');
    stream.on('data', (c) => { d += c; });
    stream.on('end', () => res(d));
    setTimeout(() => res(d), 3000); // stdin 이 안 닫혀도 훅이 도구를 멈춰 세우면 안 된다
  });
}

function statePath(sessionId) {
  const safe = String(sessionId || 'nosession').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'nosession';
  return path.join(STATE_DIR, `${safe}.json`);
}

function loadState(sessionId) {
  try {
    const p = statePath(sessionId);
    const st = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Date.now() - (st.ts || 0) > SESSION_TTL_MS) return { ts: Date.now(), files: [] };
    return { ts: st.ts || Date.now(), files: Array.isArray(st.files) ? st.files : [] };
  } catch { return { ts: Date.now(), files: [] }; }
}

function saveState(sessionId, st) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (st.files.length > MAX_FILES) st.files = st.files.slice(-MAX_FILES);
    fs.writeFileSync(statePath(sessionId), JSON.stringify(st));
  } catch { /* 상태를 못 써도 도구를 막지 않는다 — 최악이 "한 번 더 묻는다" 여야 한다 */ }
}

function rel(p, cwd) {
  try { const r = path.relative(cwd || process.cwd(), p); return r && !r.startsWith('..') ? r : p; }
  catch { return p; }
}

// UI 파일이면 디자인 관문을 얹는다. 훅을 따로 만들지 않는다 — 게이트가 둘이면 둘 다 무시당한다.
// 확장자 + 경로 둘 다 본다(React/Vue 컴포넌트는 .jsx/.tsx 지만 로직 파일도 같은 확장자다 →
// 경로에 ui/components/web/assets 가 있을 때만 UI 로 본다. 오탐보다 미탐이 낫다 — 매번 뜨면 안 읽는다).
const UI_EXT = /\.(css|scss|less|html?|svg|vue)$/i;
const UI_PATH = /[\\/](ui|components?|web|assets|dashboard|styles?|theme|templates?)[\\/]/i;
const UI_JS = /\.(jsx|tsx)$/i;
const isUi = (p) => UI_EXT.test(p) || (UI_JS.test(p) && UI_PATH.test(p)) || (/dashboard\.(js|css)$/i.test(p));

/** 규약 16항을 편집 시점에 강제한다. 디자인실장이 2026-07-14 에 요청한 "관문" 이 이것이다 —
 *  그때는 directives/ 로 들어가 3일간 아무도 안 읽었다. 문서로는 관문이 안 된다. */
function designBlock() {
  return [
    '',
    '[디자인 관문] 규약 16항 — UI 는 디자인실장(design)이 정본이다.',
    '',
    'A. 쓰려는 색·간격·폰트가 `.claude/design-policy.md` 의 어느 토큰인가? grep 결과로 보여라.',
    '   없는 토큰을 만들지 마라. 없으면 "없다" 고 하고 디자인실장에게 물어라.',
    'B. 표를 만든다면 4종이 다 있나 — 검색 · 구분(카테고리)필터 · 컬럼헤더정렬 · 헤더고정(sticky).',
    '   (규약 8항. 개발자님이 반복 지적한 것이고 저장소마다 2~3종으로 빠져 있었다.)',
    'C. 새 UI 패턴이면 admin-ui 키트에 이미 있는지 먼저 찾아라(규약 11항).',
    '   어드민/CMS 는 Overwatch/admin-ui/UI-SPEC.md 가 정본이다.',
    'D. UI 에 이모지 금지 · 본문에 --faint 금지(규약 13항).',
    '',
    '검토가 필요하면 **①자가검사를 먼저 통과시키고** 디자인실장에게 보내라(design/REVIEW.md).',
    '①을 건너뛰고 던지면 반려된다 — 검토가 병목이 되면 안 된다는 게 그쪽 정본의 원칙이다.',
  ].join('\n');
}

/** 규약 1항을 편집 시점에 강제한다. 1번이 우리가 원본에 더한 항목이다. */
function editMsg(f) {
  return [
    '[GateGuard] 규약 1항 — 확인 전에 단언하지 않는다.',
    '',
    `${f} 을(를) 고치기 전에, 아래 사실을 실제 명령 결과로 제시하라.`,
    '',
    '1. 이 편집이 쓰는 이름이 실재하는가?  ← 가장 자주 틀리는 곳',
    '   함수·클래스·CSS 클래스·CSS 변수·DB 테이블/컬럼·설정 키를 grep 해서',
    '   "있다" 를 결과로 보여라. 없으면 만드는 것이지 쓰는 것이 아니다.',
    '   (2026-07-17: .bar / --warn / live 테이블을 있다고 믿고 써서 3건이 깨졌다.',
    '    문법검사는 통과하고 화면만 조용히 깨진다.)',
    '2. 이 파일을 import/참조하는 파일을 전부 나열하라.',
    '3. 이 변경으로 영향받는 공개 함수·API·화면을 나열하라.',
    '4. 개발자님의 현재 지시를 원문 그대로 인용하라.',
    '',
    '제시한 뒤 같은 편집을 다시 하면 통과한다. 이 파일은 이번 세션에 다시 막지 않는다.',
    '(GATEGUARD=off 로 해제 가능)',
  ].join('\n');
}

/** 규약 6항(.gitignore=이전 위험 목록)·11항(공용 자산 먼저)을 생성 시점에 강제한다. */
function writeMsg(f) {
  return [
    '[GateGuard] 규약 11항 — 새 기능은 기존 공용 자산을 먼저 찾는다.',
    '',
    `${f} 을(를) 만들기 전에, 아래 사실을 실제 명령 결과로 제시하라.`,
    '',
    '1. 같은 목적의 파일이 이미 없는지 찾아라(Glob/Grep). 있으면 그걸 고쳐라.',
    '   admin-ui 키트 · Utils.* · docs/REUSABLE-ASSETS.md 를 먼저 본다.',
    '2. 이 파일을 부를 파일과 줄을 지목하라. 아무도 안 부르면 만들지 마라.',
    '3. 이 파일이 .gitignore 에 걸리는가? 걸린다면 git 아닌 백업이 무엇인지 답하라.',
    '   (규약 6항: .gitignore 는 이전 위험 목록이다. 44바이트도 34GB 만큼 위험하다.)',
    '4. 개발자님의 현재 지시를 원문 그대로 인용하라.',
    '',
    '제시한 뒤 같은 생성을 다시 하면 통과한다.',
  ].join('\n');
}

async function main() {
  if (OFF.has(String(process.env.GATEGUARD || '').toLowerCase())) process.exit(0);

  let inp;
  try { inp = JSON.parse(await read(process.stdin)); } catch { process.exit(0); }

  const tool = inp.tool_name || '';
  if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) process.exit(0);

  const ti = inp.tool_input || {};
  const file = ti.file_path || ti.notebook_path || '';
  if (!file) process.exit(0);
  if (SKIP.some((r) => r.test(file))) process.exit(0);

  const st = loadState(inp.session_id);
  const key = path.resolve(file).toLowerCase();
  if (st.files.includes(key)) process.exit(0);   // 이번 세션에 이미 게이트를 통과한 파일

  // 통과 기록을 먼저 남긴다. 이 편집은 막지만, 사실을 제시하고 재시도하면 통과시켜야 한다.
  st.files.push(key);
  st.ts = Date.now();
  saveState(inp.session_id, st);

  const f = rel(file, inp.cwd);
  // Write 라도 파일이 이미 있으면 "고치는" 것이다 — 존재 여부로 판정한다.
  const creating = tool === 'Write' && !fs.existsSync(file);
  let msg = creating ? writeMsg(f) : editMsg(f);
  if (isUi(file)) msg += "\n" + designBlock();   // UI 면 디자인 관문을 덧붙인다(규약 16항)
  process.stderr.write(msg);
  process.exit(2);   // exit 2 = 도구를 막고 stderr 를 모델에게 되돌린다
}

main().catch(() => process.exit(0));   // 훅이 죽어도 작업을 막지 않는다
