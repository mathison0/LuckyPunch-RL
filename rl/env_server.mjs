// RL 환경 서버 — pika_env.mjs의 Game을 stdin/stdout 줄 단위 JSON으로 노출한다.
// 한 프로세스가 N개 게임을 배치로 진행한다 (IPC 1회 = N스텝).
//
// 프로토콜 (요청 1줄 → 응답 1줄):
//   {"cmd":"init","n":N}                                  → {"ok":true,"obsDim":D}
//   {"cmd":"reset","i":k,"seed":s,"opponent":"ai"|"<봇파일>","side":"LEFT"|"RIGHT",
//    "lag":1,"jitter":0}                                   → {"obs":[...]}
//   {"cmd":"step","a":[a0,...,aN-1]}                       → {"obs":[[...]...],"ev":[[scored,conceded,touch]...],
//                                                             "done":[bool...],"info":[...]}
//   {"cmd":"close"}
// step에서 끝난 게임은 자동 리셋하지 않는다 (done 이후엔 Python이 reset을 보낸다).
// a는 0..17 정수: x = (a/6|0)-1, y = ((a/2|0)%3)-1, hit = a%2  — 에이전트 관점(항상 LEFT) 기준.
import readline from 'node:readline';
import { Game, OBS_DIM } from './pika_env.mjs';

// ── 서버 루프 ──
let games = [];
function handle(msg) {
  switch (msg.cmd) {
    case 'init':
      games = new Array(msg.n | 0).fill(null);
      return { ok: true, obsDim: OBS_DIM };
    case 'reset': {
      const g = new Game(msg);
      games[msg.i | 0] = g;
      return { obs: g.obs() };
    }
    case 'step': {
      const n = games.length;
      const obs = new Array(n), ev = new Array(n), done = new Array(n), info = new Array(n);
      for (let i = 0; i < n; i++) {
        const g = games[i];
        ev[i] = g.step(msg.a[i]);
        obs[i] = g.obs(); // 끝난 게임은 마지막 스냅샷 기준 (terminal observation)
        done[i] = g.done;
        info[i] = g.done ? g.info : null;
      }
      return { obs, ev, done, info };
    }
    case 'close':
      process.exit(0);
    default:
      return { error: 'unknown cmd ' + msg.cmd };
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let out;
  try {
    out = handle(JSON.parse(line));
  } catch (e) {
    out = { error: String(e && e.stack || e) };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
});
