// 패리티 검사: rl 환경(Game)의 에이전트 슬롯에 룰 봇의 decide를 그대로 꽂으면
// arena/arena.mjs playSet()과 프레임·점수가 완전히 같아야 한다.
// 사용법: node rl/tests/parity.mjs [시드수]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playSet, loadBot, makeRng } from '../../arena/arena.mjs';
import { setCustomRng } from '../../arena/rand.mjs';
import { Game } from '../pika_env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D = path.join(HERE, '..', '..', 'src', 'code-here');
const nSeeds = Number(process.argv[2] || 4);

// 비교에 쓰는 봇은 Math.random을 쓰지 않는 것만 (arena 쪽은 호스트 Math.random을 쓰므로)
const AGENT_BOT = 'LuckyPunch_v16.js';
const OPPONENTS = ['ai', 'LuckyPunch_v03.js', 'LuckyPunch_v16.js'];

function toIndex(act, side) {
  // decide 결과(실제 좌표계) → 에이전트 관점 행동 인덱스
  const x = side === 'RIGHT' ? -act.x : act.x;
  return (x + 1) * 6 + (act.y + 1) * 2 + act.hit;
}
function sanitize(a) {
  if (!a || typeof a !== 'object') return { x: 0, y: 0, hit: 0 };
  const ok = (v, lo, hi) => (typeof v === 'number' && v >= lo && v <= hi && Number.isInteger(v));
  if (!ok(a.x, -1, 1) || !ok(a.y, -1, 1) || !ok(a.hit, 0, 1)) return { x: 0, y: 0, hit: 0 };
  return a;
}

let pass = 0, fail = 0;
for (const opp of OPPONENTS) {
  for (const side of ['LEFT', 'RIGHT']) {
    for (const lag of [1, 3]) {
      for (const jitter of [0, 8]) {
        for (let s = 0; s < nSeeds; s++) {
          const seed = 500 + s * 104729;
          // A: arena 하네스
          const rng = makeRng(seed);
          setCustomRng(rng);
          const me = { kind: 'bot', decide: loadBot(path.join(D, AGENT_BOT)) };
          const op = opp === 'ai' ? { kind: 'ai' } : { kind: 'bot', decide: loadBot(path.join(D, opp)) };
          const ref = playSet(side === 'LEFT' ? [me, op] : [op, me], { seed, applyLag: lag, rng, jitter });
          const refSelf = side === 'LEFT' ? ref.scores[0] : ref.scores[1];
          const refOpp = side === 'LEFT' ? ref.scores[1] : ref.scores[0];
          // B: rl 환경
          const decide = loadBot(path.join(D, AGENT_BOT));
          const g = new Game({ seed, opponent: opp, side, lag, jitter });
          let steps = 0;
          while (!g.done) {
            let act;
            try { act = sanitize(decide(g.snap)); } catch { act = { x: 0, y: 0, hit: 0 }; }
            g.step(toIndex(act, side));
            steps++;
          }
          const ok = g.info.scoreSelf === refSelf && g.info.scoreOpp === refOpp && g.info.frames === ref.frames;
          if (ok) pass++;
          else {
            fail++;
            console.log(`MISMATCH opp=${opp} side=${side} lag=${lag} jit=${jitter} seed=${seed}: ` +
              `arena ${refSelf}-${refOpp} ${ref.frames}f / rl ${g.info.scoreSelf}-${g.info.scoreOpp} ${g.info.frames}f`);
          }
        }
      }
    }
  }
}
console.log(`parity: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
