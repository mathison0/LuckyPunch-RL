// 룰 봇 기준선: 에이전트 슬롯에 룰 봇 decide를 꽂아 RL과 "같은 환경·같은 명세"로 평가한다.
// 명세는 Python(pikarl/evaluate.py protocol_specs)이 만든 JSON을 stdin으로 받는다.
// 출력: 명세 + 결과(scoreSelf, scoreOpp, win, rallies, frames) 배열 JSON.
// 사용법: node rl/scripts/eval_rulebot.mjs LuckyPunch_v16.js < specs.json > results.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game, loadBotSeeded } from '../pika_env.mjs';
import { makeRng } from '../../arena/arena.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D = path.join(HERE, '..', '..', 'src', 'code-here');
const botFile = process.argv[2];
const specs = JSON.parse(fs.readFileSync(0, 'utf8'));

function sanitize(a) {
  if (!a || typeof a !== 'object') return { x: 0, y: 0, hit: 0 };
  const ok = (v, lo, hi) => (typeof v === 'number' && v >= lo && v <= hi && Number.isInteger(v));
  if (!ok(a.x, -1, 1) || !ok(a.y, -1, 1) || !ok(a.hit, 0, 1)) return { x: 0, y: 0, hit: 0 };
  return a;
}

const out = [];
for (const spec of specs) {
  // 상대 봇과 같은 규칙: 세트마다 새 컨텍스트, Math.random은 시드 고정 (상대와 다른 스트림)
  const decide = loadBotSeeded(path.join(D, botFile), makeRng((spec.seed ^ 0x5bd1e995) >>> 0));
  const g = new Game(spec);
  while (!g.done) {
    let a;
    try { a = sanitize(decide(g.snap)); } catch { a = { x: 0, y: 0, hit: 0 }; }
    const x = spec.side === 'RIGHT' ? -a.x : a.x;
    g.step((x + 1) * 6 + (a.y + 1) * 2 + a.hit);
  }
  out.push({ ...spec, ...g.info });
}
process.stdout.write(JSON.stringify(out));
