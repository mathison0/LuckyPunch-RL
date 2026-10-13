// RL 환경 코어 — arena 하네스와 같은 엔진·같은 타이밍 규칙을 "에이전트 결정 tick 단위 step"으로 노출한다.
// arena/arena.mjs playSet()의 루프를 그대로 따르되, 에이전트 결정 tick마다 generator가 yield한다.
// IPC는 env_server.mjs, 하네스와의 동일성 검증은 tests/parity.mjs.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { makeRng } from '../arena/arena.mjs';
import { setCustomRng } from '../arena/rand.mjs';
import { PikaPhysics, PikaUserInput } from '../arena/physics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOT_DIR = path.join(HERE, '..', 'src', 'code-here');

// arena.mjs와 동일한 상수 (거기서 export되지 않아 복제; 값이 바뀌면 같이 맞출 것)
const TICK_GROUP = 3;
const NET_X = 216;
const GROUND_WIDTH = 432;
const MAX_TOUCHES_PER_SIDE = 5;
const MAX_RALLY_FRAMES = 4000;
const FROZEN_AFTER_ROUND = 5;
const FROZEN_READY = 30;
const FROZEN_FIRST_ROUND = 71;
const WINNING_SCORE = 10;

// ── 상대 봇 로드 ──
// arena의 loadBot과 같지만, 봇 내부 Math.random을 시드 고정 RNG로 바꾼다.
// (v07·v09·v10·v11은 Math.random을 쓰므로 그대로 두면 같은 시드라도 결과가 달라진다)
const srcCache = new Map();
export function loadBotSeeded(file, rng) {
  const p = path.isAbsolute(file) ? file : path.join(BOT_DIR, file);
  let src = srcCache.get(p);
  if (src === undefined) {
    src = fs.readFileSync(p, 'utf8');
    srcCache.set(p, src);
  }
  const seededMath = Object.create(Math);
  seededMath.random = rng;
  // 봇의 console 출력이 stdout(JSON 프로토콜)에 섞이지 않도록 무음 처리
  const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const ctx = vm.createContext({
    Math: seededMath, JSON, console: quiet, Date, Array, Object, Number, String,
    isNaN, isFinite, parseInt, parseFloat, Map, Set, RegExp,
  });
  vm.runInContext(src, ctx, { filename: p });
  const decide = vm.runInContext('typeof decide === "function" ? decide : null', ctx);
  if (!decide) throw new Error('decide 함수 없음: ' + p);
  return decide;
}

function sanitize(a) {
  if (!a || typeof a !== 'object') return { x: 0, y: 0, hit: 0 };
  const ok = (v, lo, hi) => (typeof v === 'number' && v >= lo && v <= hi && Number.isInteger(v));
  if (!ok(a.x, -1, 1) || !ok(a.y, -1, 1) || !ok(a.hit, 0, 1)) return { x: 0, y: 0, hit: 0 };
  return { x: a.x, y: a.y, hit: a.hit };
}

function buildSnapshot(tick, side, physics, scores, isPlayer2Serve, rallyFrameCount) {
  const isP2 = side === 'RIGHT';
  const self = isP2 ? physics.player2 : physics.player1;
  const opp = isP2 ? physics.player1 : physics.player2;
  const view = (p) => ({
    x: p.x, y: p.y, state: p.state,
    frameNumber: p.frameNumber, divingDirection: p.divingDirection,
  });
  return {
    tick, side,
    self: view(self), opp: view(opp),
    ball: {
      x: physics.ball.x, y: physics.ball.y,
      xVelocity: physics.ball.xVelocity, yVelocity: physics.ball.yVelocity,
      isPowerHit: physics.ball.isPowerHit,
      expectedLandingPointX: physics.ball.expectedLandingPointX,
    },
    meta: {
      score: { self: isP2 ? scores[1] : scores[0], opp: isP2 ? scores[0] : scores[1] },
      isPlayer2Serve, rallyFrameCount,
    },
    config: { tickFrameGroupSize: TICK_GROUP },
  };
}

// ── 관측 벡터 ──
// 봇이 받는 스냅샷 + 봇이 스스로 기억할 수 있는 것(직전 스냅샷, 직전 행동)만 쓴다 → 룰 봇과 정보 동등.
// RIGHT 진영이면 x축을 미러링해 항상 LEFT 관점으로 만든다.
export const OBS_DIM = 37;
export function encodeObs(s, prev, lastAct) {
  const m = s.side === 'RIGHT';
  const fx = (x) => (m ? GROUND_WIDTH - x : x);
  const fv = (v) => (m ? -v : v);
  const o = new Array(OBS_DIM).fill(0);
  let k = 0;
  const player = (p) => {
    o[k++] = fx(p.x) / GROUND_WIDTH;
    o[k++] = p.y / 252;
    o[k + Math.min(Math.max(p.state, 0), 6)] = 1; k += 7; // state one-hot 0..6
    o[k++] = p.frameNumber / 5;
    o[k++] = fv(p.divingDirection);
  };
  player(s.self);
  player(s.opp);
  const b = s.ball;
  o[k++] = fx(b.x) / GROUND_WIDTH;
  o[k++] = b.y / 252;
  o[k++] = fv(b.xVelocity) / 20;
  o[k++] = b.yVelocity / 30;
  o[k++] = fx(b.expectedLandingPointX) / GROUND_WIDTH;
  o[k++] = b.isPowerHit ? 1 : 0;
  // 직전 스냅샷과의 차이: 상대 속도 / 정지 구간 여부 (CLAUDE.md "정지 구간" 함정)
  const frozen = prev && prev.ball.x === b.x && prev.ball.y === b.y ? 1 : 0;
  o[k++] = prev ? fv(s.opp.x - prev.opp.x) / 18 : 0;
  o[k++] = frozen;
  o[k++] = s.meta.score.self / WINNING_SCORE;
  o[k++] = s.meta.score.opp / WINNING_SCORE;
  o[k++] = (s.meta.isPlayer2Serve === m) ? 1 : 0; // 내 서브인가
  o[k++] = Math.min(s.meta.rallyFrameCount, 1000) / 1000;
  // 직전 행동 (lag 동안 아직 이 행동이 적용 중)
  o[k++] = lastAct.x;
  o[k++] = lastAct.y;
  o[k++] = lastAct.hit;
  if (k !== OBS_DIM) throw new Error("OBS_DIM 불일치: " + k);
  return o;
}

export function decodeAction(a, side) {
  a = a | 0;
  if (a < 0 || a > 17) a = 0;
  const x = ((a / 6) | 0) - 1;
  const y = (((a / 2) | 0) % 3) - 1;
  const hit = a % 2;
  return { x: side === 'RIGHT' ? -x : x, y, hit };
}

class TouchLimit {
  constructor() { this.reset(); this.prevOnLeft = null; }
  reset() { this.count = 0; this.last = null; this.prevFlags = [false, false]; }
  // 반환: {loser, touched:[bool,bool]} — touched는 이번 프레임에 새로 공을 친 쪽
  observe(physics) {
    const onLeft = physics.ball.x < NET_X;
    if (this.prevOnLeft !== null && onLeft !== this.prevOnLeft) this.reset();
    this.prevOnLeft = onLeft;
    const players = [physics.player1, physics.player2];
    let loser = -1;
    const touched = [false, false];
    for (let i = 0; i < 2; i++) {
      const colliding = players[i].isCollisionWithBallHappened;
      if (colliding && !this.prevFlags[i]) {
        touched[i] = true;
        if (this.last !== null && this.last !== i) this.count = 0;
        this.last = i;
        this.count += 1;
        if (this.count >= MAX_TOUCHES_PER_SIDE) { this.reset(); loser = i; }
      }
      this.prevFlags[i] = colliding;
    }
    return { loser, touched };
  }
}

// 상대 슬롯: 봇 파일이면 arena BotSide와 같은 getInput, 내장 AI면 엔진이 채운다.
class BotRunner {
  constructor(decide, side, lag) {
    this.decide = decide; this.side = side; this.lag = lag;
    this.input = new PikaUserInput();
    this.latest = { x: 0, y: 0, hit: 0 };
    this.pending = null; this.tick = 0; this.rallyFrameCount = 0; this.prevScoreTotal = 0;
    this.errors = 0;
  }
  getInput(frame, physics, scores, isPlayer2Serve) {
    if (this.pending !== null && frame >= this.pending.readyAt) {
      this.latest = this.pending.action; this.pending = null;
    }
    this.input.xDirection = this.latest.x;
    this.input.yDirection = this.latest.y;
    this.input.powerHit = this.latest.hit;
    const total = scores[0] + scores[1];
    if (total !== this.prevScoreTotal) { this.rallyFrameCount = 0; this.prevScoreTotal = total; }
    else this.rallyFrameCount++;
    this.tick++;
    if (this.tick % TICK_GROUP !== 0 || this.pending !== null) return;
    const snap = buildSnapshot(this.tick, this.side, physics, scores, isPlayer2Serve, this.rallyFrameCount);
    let action;
    try { action = sanitize(this.decide(snap)); } catch (e) { this.errors++; action = { x: 0, y: 0, hit: 0 }; }
    this.pending = { action, readyAt: frame + this.lag };
  }
}
class AiRunner {
  constructor() { this.input = new PikaUserInput(); this.errors = 0; }
  getInput() {}
}

// 에이전트 슬롯: BotRunner와 같은 규칙이지만 decide 대신 generator가 yield로 밖에 묻는다.
class AgentRunner {
  constructor(side, lag) {
    this.side = side; this.lag = lag;
    this.input = new PikaUserInput();
    this.latest = { x: 0, y: 0, hit: 0 };
    this.lastChosen = { x: 0, y: 0, hit: 0 }; // 에이전트 관점(미러 전) 직전 행동
    this.pending = null; this.tick = 0; this.rallyFrameCount = 0; this.prevScoreTotal = 0;
  }
  // 결정이 필요하면 스냅샷을, 아니면 null을 반환
  pre(frame, physics, scores, isPlayer2Serve) {
    if (this.pending !== null && frame >= this.pending.readyAt) {
      this.latest = this.pending.action; this.pending = null;
    }
    this.input.xDirection = this.latest.x;
    this.input.yDirection = this.latest.y;
    this.input.powerHit = this.latest.hit;
    const total = scores[0] + scores[1];
    if (total !== this.prevScoreTotal) { this.rallyFrameCount = 0; this.prevScoreTotal = total; }
    else this.rallyFrameCount++;
    this.tick++;
    if (this.tick % TICK_GROUP !== 0 || this.pending !== null) return null;
    return buildSnapshot(this.tick, this.side, physics, scores, isPlayer2Serve, this.rallyFrameCount);
  }
  commit(frame, actionIndex) {
    const act = decodeAction(actionIndex, this.side);
    this.lastChosen = { x: this.side === 'RIGHT' ? -act.x : act.x, y: act.y, hit: act.hit };
    this.pending = { action: act, readyAt: frame + this.lag };
  }
}

// ── 한 세트 = generator. arena.mjs playSet()의 루프를 그대로 따르되, 에이전트 결정 tick마다 yield ──
// yield 값: 스냅샷. resume 값: 행동 인덱스. this.ev에 마지막 yield 이후 이벤트가 쌓인다.
export class Game {
  constructor({ seed = 1, opponent = 'ai', side = 'LEFT', lag = 1, jitter = 0 }) {
    this.seed = seed; this.side = side; this.lag = lag; this.jitter = jitter;
    this.opponent = opponent;
    this.rng = makeRng(seed);
    // 상대 봇 Math.random은 엔진 RNG와 별도 스트림 (상대 종류가 엔진 난수열을 바꾸지 않도록)
    this.botRng = makeRng((seed ^ 0x9e3779b9) >>> 0);
    this.agentIdx = side === 'LEFT' ? 0 : 1;
    this.ev = [0, 0, 0]; // scored, conceded, agentTouch
    this.prevSnap = null;
    this.done = false;
    this.info = null;
    setCustomRng(this.rng);
    this.gen = this.run();
    const r = this.gen.next();
    this.snap = r.value;
  }

  *run() {
    const random = this.rng;
    const ai = this.opponent === 'ai';
    const oppIdx = 1 - this.agentIdx;
    const physics = new PikaPhysics(ai && oppIdx === 0, ai && oppIdx === 1);
    const agent = new AgentRunner(this.side, this.lag);
    const opp = ai ? new AiRunner()
      : new BotRunner(loadBotSeeded(this.opponent, this.botRng), oppIdx === 0 ? 'LEFT' : 'RIGHT', this.lag);
    const runners = this.agentIdx === 0 ? [agent, opp] : [opp, agent];
    const inputs = runners.map((r) => r.input);
    const scores = [0, 0];
    const touch = new TouchLimit();
    let isPlayer2Serve = random() < 0.5;
    let frame = 0, rallies = 0, firstRound = true;
    this.agent = agent; this.oppRunner = opp;

    const self = this;
    // 한 프레임의 입력 수집. 에이전트 결정 tick이면 yield.
    function* inputsForFrame() {
      for (let i = 0; i < 2; i++) {
        if (i === self.agentIdx) {
          const snap = agent.pre(frame, physics, scores, isPlayer2Serve);
          if (snap) {
            const a = yield snap;
            agent.commit(frame, a);
          }
        } else {
          runners[i].getInput(frame, physics, scores, isPlayer2Serve);
        }
      }
    }

    while (scores[0] < WINNING_SCORE && scores[1] < WINNING_SCORE) {
      if (!firstRound) {
        for (let i = 0; i < FROZEN_AFTER_ROUND; i++) { yield* inputsForFrame(); frame++; }
      }
      physics.player1.initializeForNewRound();
      physics.player2.initializeForNewRound();
      physics.ball.initializeForNewRound(isPlayer2Serve);
      if (this.jitter > 0) {
        const j = () => Math.round((random() * 2 - 1) * this.jitter);
        physics.ball.x += j();
        physics.player1.x = Math.max(32, Math.min(184, physics.player1.x + j()));
        physics.player2.x = Math.max(248, Math.min(400, physics.player2.x + j()));
      }
      touch.reset();
      touch.prevOnLeft = null;
      rallies++;
      const frozen = firstRound ? FROZEN_FIRST_ROUND : FROZEN_READY;
      firstRound = false;
      for (let i = 0; i < frozen; i++) { yield* inputsForFrame(); frame++; }

      let rallyFrames = 0;
      while (true) {
        yield* inputsForFrame();
        const grounded = physics.runEngineForNextFrame(inputs);
        frame++;
        rallyFrames++;
        const t = touch.observe(physics);
        if (t.touched[this.agentIdx]) this.ev[2] += 1;
        let winner = -1;
        if (t.loser >= 0) winner = t.loser === 0 ? 1 : 0;
        else if (grounded) winner = physics.ball.punchEffectX < NET_X ? 1 : 0;
        if (winner >= 0) {
          scores[winner] += 1;
          if (winner === this.agentIdx) this.ev[0] += 1; else this.ev[1] += 1;
          isPlayer2Serve = random() < 0.5;
          break;
        }
        if (rallyFrames > MAX_RALLY_FRAMES) break; // 무승부 랠리 — 점수 없음 (arena와 동일)
      }
    }
    const a = this.agentIdx;
    return {
      scoreSelf: scores[a], scoreOpp: scores[1 - a], win: scores[a] > scores[1 - a],
      frames: frame, rallies, oppErrors: opp.errors,
    };
  }

  obs() { return encodeObs(this.snap, this.prevSnap, this.agent.lastChosen); }

  step(action) {
    this.ev = [0, 0, 0];
    setCustomRng(this.rng); // 엔진 RNG는 전역 1개 → 이 게임 차례에 이 게임의 스트림으로 바꿔 끼운다
    this.prevSnap = this.snap;
    const r = this.gen.next(action);
    if (r.done) {
      this.done = true;
      this.info = r.value;
    } else {
      this.snap = r.value;
    }
    return this.ev;
  }
}
