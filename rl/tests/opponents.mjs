// 상대 슬롯 스모크 테스트: 평가 대상 상대 전부가 rl 환경에서 로드·진행·재현되는지 확인.
// 각 상대에 대해 (1) 랜덤 행동 에이전트로 같은 시드 2회 → 결과 일치, (2) decide 예외 수, (3) 세트당 시간,
// (4) 참고용으로 에이전트 슬롯에 v16을 꽂았을 때의 결과.
// 사용법: node rl/tests/opponents.mjs [상대파일,...]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBot, makeRng } from '../../arena/arena.mjs';
import { Game } from '../pika_env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D = path.join(HERE, '..', '..', 'src', 'code-here');

// Phase 3 평가 상대 (사용자 지정). ai는 학습 상대·기준선으로 포함.
// submit_v1은 기본 엔진(스킬 없음)에서 PikaPlanner_v4와 동작이 같다.
export const EVAL_OPPONENTS = [
  'ai',
  'LuckyPunch_v01.js', 'LuckyPunch_v05.js', 'LuckyPunch_v07.js', 'LuckyPunch_v10.js',
  'LuckyPunch_v12.js', 'LuckyPunch_v14.js', 'LuckyPunch_v16.js',
  'PikaPlanner_v4.js', 'submit_v1.js',
];

function runRandom(opp, seed, side) {
  const act = makeRng(seed * 31 + 7);
  const g = new Game({ seed, opponent: opp, side, lag: 1, jitter: 8 });
  const trace = [];
  while (!g.done) {
    const a = Math.floor(act() * 18);
    g.step(a);
    trace.push(a);
  }
  return g.info;
}

function runV16(opp, seed, side) {
  const decide = loadBot(path.join(D, 'LuckyPunch_v16.js'));
  const g = new Game({ seed, opponent: opp, side, lag: 1, jitter: 8 });
  while (!g.done) {
    let a;
    try { a = decide(g.snap) || {}; } catch { a = {}; }
    const x = (a.x | 0) * (side === 'RIGHT' ? -1 : 1);
    g.step((x + 1) * 6 + ((a.y | 0) + 1) * 2 + (a.hit ? 1 : 0));
  }
  return g.info;
}

const list = process.argv[2] ? process.argv[2].split(',') : EVAL_OPPONENTS;
let bad = 0;
console.log('상대'.padEnd(38) + '재현  예외  ms/세트(랜덤)  랜덤 L/R 점수   v16 L/R 점수');
for (const opp of list) {
  const t0 = performance.now();
  const r1 = [runRandom(opp, 11, 'LEFT'), runRandom(opp, 12, 'RIGHT')];
  const ms = (performance.now() - t0) / 2;
  const r2 = [runRandom(opp, 11, 'LEFT'), runRandom(opp, 12, 'RIGHT')];
  const same = JSON.stringify(r1) === JSON.stringify(r2);
  const errs = r1[0].oppErrors + r1[1].oppErrors;
  const v = [runV16(opp, 11, 'LEFT'), runV16(opp, 12, 'RIGHT')];
  if (!same || errs > 0) bad++;
  const sc = (r) => `${r.scoreSelf}-${r.scoreOpp}`;
  console.log(
    opp.padEnd(38) + (same ? 'OK  ' : 'FAIL') + '  ' + String(errs).padStart(4) + '  ' +
    ms.toFixed(0).padStart(12) + '  ' + `${sc(r1[0])} / ${sc(r1[1])}`.padEnd(14) + '  ' + `${sc(v[0])} / ${sc(v[1])}`
  );
}
process.exit(bad ? 1 : 0);
