'use strict';

/*
 * PikaPlanner_v2.js
 * ============================================================================
 * Rebuilt competition bot for the disclosed Pikachu / Leonyi Volleyball engine.
 *
 * v2 design principles
 * --------------------
 * 1. Canonical LEFT-side coordinates everywhere inside the planner.
 * 2. One physics implementation is shared by offense, defense and prediction.
 * 3. Every simulated ball trajectory records WALL / NET_TOP / NET_SIDE events.
 * 4. Shot quality is evaluated against the opponent's FULL trajectory
 *    interceptability, not only final landing X.
 * 5. Opponent reachability is propagated in 3-frame held-action blocks so
 *    jump / dive / committed states are represented explicitly.
 * 6. Opponent pre-contact defense predicts the opponent's future CONTACT first,
 *    then rolls out the shots they can create from that contact state.
 * 7. Planner intent and engine action are separated by a safety executor so
 *    held inputs cannot accidentally turn into a dive / re-jump after landing.
 * 8. Tournament-day skill changes are isolated to the SKILL adapter and a few
 *    clearly marked hooks.
 *
 * The file has no imports and defines the required top-level decide(snapshot).
 */

// ============================================================================
// [A] DISCLOSED ENGINE CONSTANTS -- DO NOT TUNE
// ============================================================================
const C = Object.freeze({
  W: 432,
  NET_X: 216,
  PLAYER_HALF: 32,
  LEFT_MIN: 32,
  LEFT_MAX: 184,
  RIGHT_MIN: 248,
  RIGHT_MAX: 400,
  PLAYER_GROUND_Y: 244,
  BALL_GROUND_Y: 252,
  NET_HALF: 25,
  NET_TOP: 176,
  NET_BOTTOM: 192,
  WALK: 6,
  DIVE: 8,
  JUMP_VY: -16,
  DIVE_VY: -5,
  GRAVITY: 1,
});

// ============================================================================
// [B] TUNABLE PARAMETERS -- SAFE MATCH-DAY / OFFLINE-TUNING AREA
// ============================================================================
const DEFAULT_CFG = Object.freeze({
  // Control / movement
  ACTION_LATENCY: 1,
  MOVE_DEADBAND: 4,
  HOME_X: 108,
  BALL_HORIZON: 96,
  CONTACT_HORIZON: 48,
  THREAT_HORIZON: 18,
  POWER_SEARCH_HOLD: 8,

  // Receive geometry. Positive offset means canonical player stands LEFT of
  // the ball, sending an ordinary bump toward the net/right.
  RECEIVE_OFFSETS: [8, 12, 18, 24, 30],
  SELF_SET_TARGET_X: 170,
  SELF_SET_MAX_TOUCH_EST: 2,
  SELF_SET_DEEP_BALL_X: 142,
  SELF_SET_SCORE: 92,

  // Jump planning
  JUMP_MAX_CONTACT: 27,
  JUMP_MIN_VALUE_GAIN: 8,
  JUMP_POWER_MIN_CONTACT_FRAME: 4,

  // Dive
  DIVE_HORIZON: 13,
  DIVE_MIN_BALL_Y: 166,
  DIVE_EXTRA_MARGIN: 5,

  // Full-trajectory shot evaluation
  SHOT_UNRETURNABLE: 520,
  SHOT_RETURN_BASE: 170,
  SHOT_INTERCEPT_FRAME_WEIGHT: 7.5,
  SHOT_INTERCEPT_OPTIONS_WEIGHT: 1.6,
  SHOT_LANDING_DISTANCE_WEIGHT: 0.22,
  SHOT_EDGE_WEIGHT: 0.10,
  SHOT_TIME_WEIGHT: 0.42,
  SHOT_WALL_EVENT_BONUS: 5,
  SHOT_NET_TOP_EVENT_BONUS: 8,
  SHOT_NET_SIDE_EVENT_BONUS: 10,
  SHOT_LATE_REVERSAL_BONUS: 5,
  SHOT_SELF_SIDE_PENALTY: 20000,

  // Reachability search. This is used for opponent shot-return evaluation.
  REACH_MAX_STATES: 4500,
  REACH_X_QUANT: 1,

  // Defensive pre-positioning
  DEFENSE_X_STEP: 8,
  DEFENSE_MOVE_COST: 0.30,
  DEFENSE_NO_INTERCEPT_PENALTY: 1000,
  DEFENSE_THREAT_LIMIT: 24,
  DEFENSE_CONTACT_WINDOW: 3,

  // Power arm gating
  POWER_NEAR_X: 78,
  POWER_NEAR_Y: 88,
  DOWN_SMASH_MAX_NET_DISTANCE: 100,

  // Input hold safety
  LANDING_SAFETY_FRAMES: 3,

  // Match context
  LEAD_SAFE: 2,
  TRAIL_AGGRO: -2,
  LEAD_RISK_SCALE: 0.92,
  TRAIL_RISK_SCALE: 1.08,

  // Debug
  DEBUG: 0,
  DEBUG_EVERY: 60,
  DEBUG_EXPORT: 0,
});

// Optional runtime override for local simulator tuning.
const RUNTIME_CFG =
  typeof globalThis !== 'undefined' && globalThis.__PIKA_CFG__
    ? globalThis.__PIKA_CFG__
    : null;
const CFG = Object.assign({}, DEFAULT_CFG, RUNTIME_CFG || {});

// ============================================================================
// [C] SKILL ADAPTER -- TOURNAMENT-DAY PRIMARY EDIT AREA
// ============================================================================
const SKILL = {
  read(_snapshot) {
    // Fill only after the real skill fields are released.
    return { enabled: false };
  },

  transformContext(ctx) {
    return ctx;
  },

  // Called once inside the ordinary world-ball frame update. If a released
  // skill modifies gravity / speed / collision, mirror the released frame
  // order here rather than sprinkling skill checks through the planner.
  ballFrameHook(_ball, _skillState, _events) {},

  // Optional player reach modifier (dash, enlarged hitbox, etc.).
  reachActions(_node, _who, _ctx) {
    return [];
  },

  // Optional additional tactical candidate actions.
  extraActions(_ctx) {
    return [];
  },

  evaluate(_ctx, _candidate) {
    return 0;
  },

  emergencyOverride(_ctx, _planned) {
    return null;
  },
};

// ============================================================================
// [D] SMALL UTILITIES / MEMORY
// ============================================================================
const MEM = {
  decisions: 0,
  prev: null,
  lastAction: { x: 0, y: 0, hit: 0 }, // canonical action actually returned
  inferredOppXDir: 0,
  ownTouchEstimate: 0,
  oppTouchEstimate: 0,
  selfSetUsed: false,
  worldFlip: false,
  selfSetPendingTick: null,
  lastScoreSelf: 0,
  lastScoreOpp: 0,
  lastBall: null,
};

function abs(x) { return x < 0 ? -x : x; }
function sign(x) { return x < 0 ? -1 : x > 0 ? 1 : 0; }
function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
function min(a, b) { return a < b ? a : b; }
function max(a, b) { return a > b ? a : b; }
function action(x, y, hit) { return { x: x | 0, y: y | 0, hit: hit ? 1 : 0 }; }
function cloneAction(a) { return action(a.x, a.y, a.hit); }

function canonicalize(s) {
  const flip = s.side === 'RIGHT';
  const fx = (x) => flip ? C.W - x : x;
  const fvx = (vx) => flip ? -vx : vx;
  return SKILL.transformContext({
    flip,
    tick: s.tick | 0,
    tickGroup: Math.max(1, s.config.tickFrameGroupSize | 0),
    self: {
      x: fx(s.self.x), y: s.self.y,
      state: s.self.state | 0,
      frameNumber: s.self.frameNumber | 0,
      divingDirection: flip ? -(s.self.divingDirection | 0) : (s.self.divingDirection | 0),
    },
    opp: {
      x: fx(s.opp.x), y: s.opp.y,
      state: s.opp.state | 0,
      frameNumber: s.opp.frameNumber | 0,
      divingDirection: flip ? -(s.opp.divingDirection | 0) : (s.opp.divingDirection | 0),
    },
    ball: {
      x: fx(s.ball.x), y: s.ball.y,
      vx: fvx(s.ball.xVelocity), vy: s.ball.yVelocity,
      isPowerHit: !!s.ball.isPowerHit,
      landingX: fx(s.ball.expectedLandingPointX),
    },
    scoreSelf: s.meta.score.self | 0,
    scoreOpp: s.meta.score.opp | 0,
    isPlayer2Serve: !!s.meta.isPlayer2Serve,
    rallyFrameCount: s.meta.rallyFrameCount | 0,
    skill: SKILL.read(s),
  });
}

function uncanonicalize(a, flip) {
  return { x: flip ? -a.x : a.x, y: a.y, hit: a.hit };
}

// ============================================================================
// [E] PLAYER VERTICAL STATE ESTIMATION
// ============================================================================
const JUMP_TABLE = (() => {
  const arr = [{ y: C.PLAYER_GROUND_Y, vy: 0 }];
  let y = C.PLAYER_GROUND_Y;
  let vy = C.JUMP_VY;
  for (let i = 1; i <= 40; i++) {
    y += vy;
    if (y < C.PLAYER_GROUND_Y) vy += 1;
    else if (y > C.PLAYER_GROUND_Y) { y = C.PLAYER_GROUND_Y; vy = 0; }
    arr.push({ y, vy });
    if (i > 1 && y === C.PLAYER_GROUND_Y) break;
  }
  return arr;
})();

const DIVE_TABLE = (() => {
  const arr = [{ y: C.PLAYER_GROUND_Y, vy: C.DIVE_VY }];
  let y = C.PLAYER_GROUND_Y;
  let vy = C.DIVE_VY;
  for (let i = 1; i <= 24; i++) {
    y += vy;
    if (y < C.PLAYER_GROUND_Y) vy += 1;
    else if (y > C.PLAYER_GROUND_Y) { y = C.PLAYER_GROUND_Y; vy = 0; }
    arr.push({ y, vy });
    if (i > 1 && y === C.PLAYER_GROUND_Y) break;
  }
  return arr;
})();

function inferVyFromTable(table, p, prevP, fallback, tickGroup) {
  const trend = prevP ? sign(p.y - prevP.y) : 0;
  let best = null;
  let bestCost = 1e9;
  for (let i = 0; i < table.length; i++) {
    if (table[i].y !== p.y) continue;
    const vy = table[i].vy;
    let cost = 0;
    if (trend < 0 && vy > 0) cost += 100;
    if (trend > 0 && vy <= 0) cost += 100;
    cost += abs(vy - fallback) * 0.05;
    if (cost < bestCost) { bestCost = cost; best = vy; }
  }
  if (best != null) return best;
  if (prevP) return clamp(Math.round((p.y - prevP.y) / tickGroup), -16, 16);
  return fallback;
}

function estimatePlayerVy(p, prevP, tickGroup) {
  if (p.state === 0 || p.state === 4 || p.state >= 5) return 0;
  if (p.state === 3) return inferVyFromTable(DIVE_TABLE, p, prevP, C.DIVE_VY, tickGroup);
  return inferVyFromTable(JUMP_TABLE, p, prevP, -4, tickGroup);
}

function updateMemory(c) {
  const scoreChanged = c.scoreSelf !== MEM.lastScoreSelf || c.scoreOpp !== MEM.lastScoreOpp;
  if (scoreChanged) {
    MEM.ownTouchEstimate = 0;
    MEM.oppTouchEstimate = 0;
    MEM.selfSetUsed = false;
    MEM.selfSetPendingTick = null;
  }

  if (
    MEM.selfSetPendingTick != null &&
    c.tick >= MEM.selfSetPendingTick &&
    c.ball.x < C.NET_X
  ) {
    // We deliberately attempted one controlled local touch. Even if the exact
    // collision occurred between snapshots (or barely missed), do not plan a
    // second intentional self-set in the same possession.
    MEM.selfSetUsed = true;
    MEM.selfSetPendingTick = null;
  }

  if (MEM.prev) {
    const dxOpp = c.opp.x - MEM.prev.opp.x;
    if (c.opp.state < 3 && abs(dxOpp) >= 3) MEM.inferredOppXDir = sign(dxOpp);
    else if (abs(dxOpp) < 3) MEM.inferredOppXDir = 0;

    const crossed = (MEM.prev.ball.x < C.NET_X) !== (c.ball.x < C.NET_X);
    if (crossed) {
      MEM.ownTouchEstimate = 0;
      MEM.oppTouchEstimate = 0;
      MEM.selfSetUsed = false;
      MEM.selfSetPendingTick = null;
    }

    if (MEM.lastBall) {
      const changed = c.ball.vx !== MEM.lastBall.vx || c.ball.vy !== MEM.lastBall.vy;
      if (changed) {
        const nearSelf = abs(c.ball.x - c.self.x) <= 38 && abs(c.ball.y - c.self.y) <= 40;
        const nearOpp = abs(c.ball.x - c.opp.x) <= 38 && abs(c.ball.y - c.opp.y) <= 40;
        if (nearSelf) MEM.ownTouchEstimate++;
        if (nearOpp) MEM.oppTouchEstimate++;
      }
    }
  }

  MEM.lastScoreSelf = c.scoreSelf;
  MEM.lastScoreOpp = c.scoreOpp;
  MEM.lastBall = { x: c.ball.x, y: c.ball.y, vx: c.ball.vx, vy: c.ball.vy };
}

// ============================================================================
// [F] SINGLE SOURCE OF TRUTH: BALL PHYSICS + EVENTS
// ============================================================================
function cloneBall(b) {
  return { x: b.x, y: b.y, vx: b.vx, vy: b.vy, isPowerHit: !!b.isPowerHit };
}

function stepBallWorld(ball, skillState) {
  const events = [];

  const futureX = ball.x + ball.vx;
  if (futureX < 0 || futureX > C.W) {
    events.push({ type: futureX < 0 ? 'WALL_LEFT' : 'WALL_RIGHT', x: ball.x, y: ball.y });
    ball.vx = -ball.vx;
  }

  let futureY = ball.y + ball.vy;
  if (futureY < 0) {
    events.push({ type: 'CEILING', x: ball.x, y: ball.y });
    ball.vy = 1;
  }

  if (abs(ball.x - C.NET_X) < C.NET_HALF && ball.y > C.NET_TOP) {
    if (ball.y <= C.NET_BOTTOM) {
      if (ball.vy > 0) {
        events.push({ type: 'NET_TOP', x: ball.x, y: ball.y });
        ball.vy = -ball.vy;
      }
    } else {
      events.push({
        type: ball.x < C.NET_X ? 'NET_SIDE_LEFT' : 'NET_SIDE_RIGHT',
        x: ball.x,
        y: ball.y,
      });
      if (ball.x < C.NET_X) ball.vx = -abs(ball.vx);
      else if (ball.x > C.NET_X) ball.vx = abs(ball.vx);
      else ball.vx = MEM.worldFlip ? -abs(ball.vx) : abs(ball.vx);
    }
  }

  SKILL.ballFrameHook(ball, skillState, events);

  futureY = ball.y + ball.vy;
  if (futureY > C.BALL_GROUND_Y) {
    events.push({ type: 'GROUND', x: ball.x, y: C.BALL_GROUND_Y });
    ball.vy = -ball.vy;
    ball.y = C.BALL_GROUND_Y;
    return { ground: true, events };
  }

  ball.y = futureY;
  ball.x += ball.vx;
  ball.vy += C.GRAVITY;
  return { ground: false, events };
}

function simulateTrajectory(ball0, maxFrames, skillState) {
  const b = cloneBall(ball0);
  const frames = [];
  const events = [];
  for (let t = 1; t <= maxFrames; t++) {
    const r = stepBallWorld(b, skillState);
    if (r.events.length) {
      for (let i = 0; i < r.events.length; i++) {
        events.push({ t, type: r.events[i].type, x: r.events[i].x, y: r.events[i].y });
      }
    }
    frames.push({
      t, x: b.x, y: b.y, vx: b.vx, vy: b.vy,
      ground: r.ground,
      events: r.events.length ? r.events.map((e) => e.type) : null,
    });
    if (r.ground) break;
  }
  return { frames, events };
}

function trajectoryLanding(tr) {
  if (!tr || !tr.frames.length) return null;
  const f = tr.frames[tr.frames.length - 1];
  return { x: f.x, frames: f.t };
}

// ============================================================================
// [G] EXACT COLLISION RESPONSE -- USED EVERYWHERE
// ============================================================================
function ordinaryCollisionFrom(ball0, playerX, power, inputX, inputY, hitterIsLeft) {
  const b = cloneBall(ball0);

  if (b.x < playerX) b.vx = -Math.floor(abs(b.x - playerX) / 3);
  else if (b.x > playerX) b.vx = Math.floor(abs(b.x - playerX) / 3);
  else b.vx = 0; // stochastic -1/0/1 in engine; planner avoids exact center.

  const av = abs(b.vy);
  b.vy = -av;
  if (av < 15) b.vy = -15;

  if (power) {
    b.vx = (abs(inputX) + 1) * 10 * (hitterIsLeft ? 1 : -1);
    b.vy = abs(b.vy) * inputY * 2; // => 2 * max(|pre vy|, 15)
    b.isPowerHit = true;
  } else {
    b.isPowerHit = false;
  }
  return b;
}

// ============================================================================
// [H] PLAYER REACHABILITY -- CLOSED-FORM / SMALL ENUMERATION
//
// We deliberately do NOT expand the full game tree. Horizontal movement has no
// inertia, and vertical motion comes from a tiny set of jump/dive trajectories.
// So reachability can be answered directly: "at global frame t, can any legal
// ground/jump/dive trajectory overlap this ball frame?" This is much faster
// than a state-set DP while preserving the important hybrid-state constraints.
// ============================================================================
function playerBounds(side) {
  return side === 'LEFT' ? [C.LEFT_MIN, C.LEFT_MAX] : [C.RIGHT_MIN, C.RIGHT_MAX];
}

function neutralVerticalTimeline(p, vy, horizon) {
  // timeline[t] = state after t engine frames under neutral input.
  const out = [{ y: p.y, vy, state: p.state === 2 ? 1 : p.state }];
  let y = p.y;
  let v = vy;
  let st = p.state === 2 ? 1 : p.state;
  let lying = st === 4 ? -1 : -1; // unknown; conservative fast recovery
  for (let t = 1; t <= horizon; t++) {
    if (st === 4) {
      lying--;
      if (lying < -1) st = 0;
      out.push({ y, vy: v, state: st });
      continue;
    }
    const fy = y + v;
    y = fy;
    if (fy < C.PLAYER_GROUND_Y) v += 1;
    else if (fy > C.PLAYER_GROUND_Y) {
      v = 0;
      y = C.PLAYER_GROUND_Y;
      if (st === 3) { st = 4; lying = 3; }
      else st = 0;
    }
    out.push({ y, vy: v, state: st });
  }
  return out;
}

function firstGroundReadyFrame(p, vy, horizon) {
  if (p.state === 0) return 0;
  if (p.state === 4) return 1; // opponent-favorable uncertainty bound
  const tl = neutralVerticalTimeline(p, vy, horizon);
  for (let t = 1; t < tl.length; t++) {
    if (tl[t].state === 0 && tl[t].y === C.PLAYER_GROUND_Y) return t;
  }
  return horizon + 1;
}

function horizontalInterval(p, vy, side, t) {
  const b = playerBounds(side);
  if (t <= 0) return [p.x, p.x];

  if (p.state === 3) {
    // During an existing dive, horizontal direction is committed. After the
    // dive + lying recovery, ordinary 6px/frame movement resumes.
    const tl = neutralVerticalTimeline(p, vy, t + 8);
    let x = p.x;
    let ready = null;
    for (let k = 1; k <= t; k++) {
      const prevState = tl[k - 1].state;
      if (prevState === 3) x += p.divingDirection * C.DIVE;
      x = clamp(x, b[0], b[1]);
      if (tl[k].state === 0 && ready == null) ready = k;
    }
    if (ready == null || ready >= t) return [x, x];
    const rem = (t - ready) * C.WALK;
    return [clamp(x - rem, b[0], b[1]), clamp(x + rem, b[0], b[1])];
  }

  if (p.state === 4) {
    const rem = max(0, t - 1) * C.WALK;
    return [clamp(p.x - rem, b[0], b[1]), clamp(p.x + rem, b[0], b[1])];
  }

  const r = t * C.WALK;
  return [clamp(p.x - r, b[0], b[1]), clamp(p.x + r, b[0], b[1])];
}

function xIntervalHits(interval, x) {
  return x >= interval[0] - C.PLAYER_HALF && x <= interval[1] + C.PLAYER_HALF;
}

function jumpVerticalOptionsAt(p, vy, t, ballY, horizon) {
  let options = 0;
  const tl = neutralVerticalTimeline(p, vy, max(t, horizon || t));

  // Continuing the current committed vertical trajectory.
  const base = tl[min(t, tl.length - 1)];
  if (abs(ballY - base.y) <= C.PLAYER_HALF) options++;

  // Once grounded/recovered, a new jump may be started. We use every frame
  // rather than only 1/4/7... action-application phases: this is a deliberate
  // opponent-favorable bound and makes shot scoring robust to scheduler jitter.
  const ready = firstGroundReadyFrame(p, vy, t + 2);
  if (ready <= t && abs(ballY - C.PLAYER_GROUND_Y) <= C.PLAYER_HALF) options++;
  for (let start = ready + 1; start <= t; start++) {
    const age = t - start + 1;
    if (age < JUMP_TABLE.length && abs(ballY - JUMP_TABLE[age].y) <= C.PLAYER_HALF) options++;
  }
  return options;
}

function diveCanReachAt(p, side, t, bf) {
  if (p.state !== 0 || t <= 0 || bf.y < 150) return false;
  const b = playerBounds(side);
  for (let start = 1; start <= t; start++) {
    const age = t - start + 1;
    if (age >= DIVE_TABLE.length) continue;
    if (abs(bf.y - DIVE_TABLE[age].y) > C.PLAYER_HALF) continue;
    const pre = (start - 1) * C.WALK;
    const during = age === 1 ? C.WALK : C.WALK + (age - 1) * C.DIVE;
    const reach = pre + during + C.PLAYER_HALF;
    if (abs(bf.x - p.x) <= reach) {
      const lo = b[0] - C.PLAYER_HALF;
      const hi = b[1] + C.PLAYER_HALF;
      if (bf.x >= lo && bf.x <= hi) return true;
    }
  }
  return false;
}

function canPlayerReachBallAt(p, vy, side, globalT, bf) {
  const xi = horizontalInterval(p, vy, side, globalT);
  if (!xIntervalHits(xi, bf.x)) {
    // A fresh dive can outrun ordinary walking horizontally.
    if (!diveCanReachAt(p, side, globalT, bf)) return { can: false, options: 0 };
  }

  const verticalOptions = jumpVerticalOptionsAt(p, vy, globalT, bf.y, globalT + 2);
  const dive = diveCanReachAt(p, side, globalT, bf);
  const options = verticalOptions + (dive ? 1 : 0);
  return { can: options > 0, options };
}

function interceptTrajectory(p, vy, side, tr, preFrames) {
  let earliest = 999;
  let totalOptions = 0;
  let earliestOptions = 0;
  for (let i = 0; i < tr.frames.length; i++) {
    const bf = tr.frames[i];
    const globalT = preFrames + i + 1;
    const r = canPlayerReachBallAt(p, vy, side, globalT, bf);
    if (r.can) {
      totalOptions += r.options;
      if (earliest === 999) {
        earliest = i + 1; // frames after the shot/contact
        earliestOptions = r.options;
      }
    }
    if (bf.ground) break;
  }
  return {
    canIntercept: earliest !== 999,
    earliest,
    earliestCount: earliestOptions,
    totalOpportunities: totalOptions,
  };
}

// ============================================================================
// [I] TRAJECTORY SCORING -- CUSHIONS ARE FIRST-CLASS, NOT SPECIAL CASES
// ============================================================================
function eventComplexityScore(tr, intercept) {
  let score = 0;
  let lastDirectionEventT = -1;
  for (let i = 0; i < tr.events.length; i++) {
    const e = tr.events[i];
    if (e.type === 'WALL_LEFT' || e.type === 'WALL_RIGHT') {
      score += CFG.SHOT_WALL_EVENT_BONUS;
      lastDirectionEventT = max(lastDirectionEventT, e.t);
    } else if (e.type === 'NET_TOP') {
      score += CFG.SHOT_NET_TOP_EVENT_BONUS;
    } else if (e.type === 'NET_SIDE_LEFT' || e.type === 'NET_SIDE_RIGHT') {
      score += CFG.SHOT_NET_SIDE_EVENT_BONUS;
      lastDirectionEventT = max(lastDirectionEventT, e.t);
    }
  }
  if (lastDirectionEventT > 0 && intercept.canIntercept && lastDirectionEventT >= intercept.earliest - 5) {
    score += CFG.SHOT_LATE_REVERSAL_BONUS;
  }
  return score;
}

function matchRiskScale(c) {
  const d = c.scoreSelf - c.scoreOpp;
  if (d >= CFG.LEAD_SAFE) return CFG.LEAD_RISK_SCALE;
  if (d <= CFG.TRAIL_AGGRO) return CFG.TRAIL_RISK_SCALE;
  return 1;
}

function evaluateOutgoingTrajectory(tr, c, oppVy, contactFrame) {
  const land = trajectoryLanding(tr);
  if (!land) return { score: -1e9, intercept: null, landing: null };
  if (land.x <= C.NET_X) {
    return {
      score: -CFG.SHOT_SELF_SIDE_PENALTY - (C.NET_X - land.x) * 20,
      intercept: null,
      landing: land,
    };
  }

  const intercept = interceptTrajectory(c.opp, oppVy, 'RIGHT', tr, contactFrame);
  let score;
  if (!intercept.canIntercept) {
    score = CFG.SHOT_UNRETURNABLE;
  } else {
    score =
      CFG.SHOT_RETURN_BASE +
      intercept.earliest * CFG.SHOT_INTERCEPT_FRAME_WEIGHT -
      Math.log(1 + intercept.totalOpportunities) * CFG.SHOT_INTERCEPT_OPTIONS_WEIGHT * 8;
  }

  score += abs(land.x - c.opp.x) * CFG.SHOT_LANDING_DISTANCE_WEIGHT;
  if (min(abs(land.x - C.NET_X), abs(C.W - land.x)) < 45) score += CFG.SHOT_EDGE_WEIGHT * 45;
  score -= land.frames * CFG.SHOT_TIME_WEIGHT;
  score += eventComplexityScore(tr, intercept);
  score *= matchRiskScale(c);
  score += SKILL.evaluate(c, {
    type: 'OUTGOING_TRAJECTORY', trajectory: tr, landing: land, intercept, contactFrame,
  });

  return { score, intercept, landing: land };
}

// ============================================================================
// [J] POWER ATTACK PLANNER (AIRBORNE SELF)
// ============================================================================
function cloneSelfExact(c, vy) {
  return {
    x: c.self.x, y: c.self.y, vy,
    state: c.self.state,
    frameNumber: c.self.frameNumber,
    divingDirection: c.self.divingDirection,
    // Snapshot omits state-2 delayBeforeNextFrame. Use the conservative
    // shortest remaining delay; if power still works under this assumption,
    // the real engine can only give us an equal-or-longer armed window.
    delay: 0,
    lying: -1,
    side: 'LEFT',
  };
}

function stepSelfExact(p, a) {
  if (p.state === 4) {
    p.lying--;
    if (p.lying < -1) p.state = 0;
    return;
  }
  let vx = 0;
  if (p.state < 5) vx = p.state < 3 ? a.x * C.WALK : p.divingDirection * C.DIVE;
  p.x = clamp(p.x + vx, C.LEFT_MIN, C.LEFT_MAX);

  if (p.state < 3 && a.y === -1 && p.y === C.PLAYER_GROUND_Y) {
    p.vy = C.JUMP_VY;
    p.state = 1;
    p.frameNumber = 0;
  }

  const fy = p.y + p.vy;
  p.y = fy;
  if (fy < C.PLAYER_GROUND_Y) p.vy += 1;
  else if (fy > C.PLAYER_GROUND_Y) {
    p.vy = 0; p.y = C.PLAYER_GROUND_Y; p.frameNumber = 0;
    if (p.state === 3) { p.state = 4; p.lying = 3; }
    else p.state = 0;
  }

  if (a.hit === 1) {
    if (p.state === 1) { p.state = 2; p.delay = 5; p.frameNumber = 0; }
    else if (p.state === 0 && a.x !== 0) {
      p.state = 3; p.divingDirection = a.x; p.vy = C.DIVE_VY; p.frameNumber = 0;
    }
  }

  if (p.state === 1) p.frameNumber = (p.frameNumber + 1) % 3;
  else if (p.state === 2) {
    if (p.delay < 1) {
      p.frameNumber++;
      if (p.frameNumber > 4) { p.frameNumber = 0; p.state = 1; }
    } else p.delay--;
  }
}

function playerBallOverlapRaw(b, p) {
  return abs(b.x - p.x) <= C.PLAYER_HALF && abs(b.y - p.y) <= C.PLAYER_HALF;
}


function simulateImmediatePowerCandidate(c, selfVy, oppVy, candidate) {
  const b = cloneBall(c.ball);
  const p = cloneSelfExact(c, selfVy);
  let collisionFlag = playerBallOverlapRaw(b, p);

  // The current decision cannot affect the same physics frame that produced
  // this snapshot. Advance last held action for the configured latency.
  for (let t = 1; t <= CFG.ACTION_LATENCY; t++) {
    const bw = stepBallWorld(b, c.skill);
    stepSelfExact(p, MEM.lastAction);
    const ov = playerBallOverlapRaw(b, p);
    if (ov && !collisionFlag) return null; // contact already happened under old input
    collisionFlag = ov;
    if (bw.ground) return null;
  }

  const effectiveCandidate = c.self.state === 2
    ? action(candidate.x, candidate.y, 0)
    : candidate;

  for (let t = 1; t <= CFG.POWER_SEARCH_HOLD; t++) {
    const bw = stepBallWorld(b, c.skill);
    stepSelfExact(p, effectiveCandidate);
    const ov = playerBallOverlapRaw(b, p);
    if (ov && !collisionFlag) {
      const power = p.state === 2;
      if (!power) return null;
      const after = ordinaryCollisionFrom(b, p.x, true, effectiveCandidate.x, effectiveCandidate.y, true);
      const contactFrame = CFG.ACTION_LATENCY + t;
      const tr = simulateTrajectory(after, CFG.BALL_HORIZON, c.skill);
      const ev = evaluateOutgoingTrajectory(tr, c, oppVy, contactFrame);
      return {
        contactFrame,
        contactX: b.x,
        contactY: b.y,
        after,
        tr,
        score: ev.score,
        intercept: ev.intercept,
        action: effectiveCandidate,
      };
    }
    collisionFlag = ov;
    if (bw.ground) return null;
  }
  return null;
}

function choosePowerAttack(c, selfVy, oppVy) {
  if (c.self.state !== 1 && c.self.state !== 2) return null;
  if (abs(c.ball.x - c.self.x) > CFG.POWER_NEAR_X || abs(c.ball.y - c.self.y) > CFG.POWER_NEAR_Y) return null;

  let best = null;
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      if (y === 1 && C.NET_X - c.ball.x > CFG.DOWN_SMASH_MAX_NET_DISTANCE) continue;
      const cand = action(x, y, 1);
      const sim = simulateImmediatePowerCandidate(c, selfVy, oppVy, cand);
      if (!sim) continue;
      if (!best || sim.score > best.score) best = sim;
    }
  }
  if (!best) return null;
  return {
    type: 'POWER', x: best.action.x, y: best.action.y, hit: 1,
    score: best.score, contactFrame: best.contactFrame,
    debug: { intercept: best.intercept, events: best.tr.events },
  };
}

// ============================================================================
// [K] BODY RECEIVE + SELF-SET GEOMETRY
// ============================================================================
function predictedSelfXAfterLatency(c) {
  let x = c.self.x;
  if (c.self.state < 3) x += MEM.lastAction.x * C.WALK * CFG.ACTION_LATENCY;
  return clamp(x, C.LEFT_MIN, C.LEFT_MAX);
}

function selfCanReachX(c, targetX, frames) {
  const x0 = predictedSelfXAfterLatency(c);
  const free = max(0, frames - CFG.ACTION_LATENCY);
  return abs(targetX - x0) <= C.WALK * free + C.PLAYER_HALF - 3;
}

function evaluateBodyContact(c, bf, playerX, contactFrame, oppVy) {
  if (abs(bf.x - playerX) < 3) return null; // avoid stochastic center branch
  const after = ordinaryCollisionFrom(bf, playerX, false, 0, 0, true);
  const tr = simulateTrajectory(after, CFG.BALL_HORIZON, c.skill);
  const land = trajectoryLanding(tr);
  if (!land) return null;

  if (land.x > C.NET_X) {
    const ev = evaluateOutgoingTrajectory(tr, c, oppVy, contactFrame);
    return { type: 'CLEAR', score: ev.score + 10, playerX, tr, landing: land };
  }

  const allowSelfSet =
    !MEM.selfSetUsed &&
    bf.x < CFG.SELF_SET_DEEP_BALL_X;
  if (allowSelfSet && land.x < C.NET_X - 8) {
    const score = CFG.SELF_SET_SCORE - abs(land.x - CFG.SELF_SET_TARGET_X) * 1.25 - land.frames * 0.25;
    return { type: 'SELF_SET', score, playerX, tr, landing: land };
  }

  return { type: 'BAD_LOCAL', score: -300 - abs(C.NET_X - land.x), playerX, tr, landing: land };
}

function groundXTimelineToTarget(c, targetX, maxT) {
  const xs = [];
  let x = c.self.x;
  let heldX = MEM.lastAction.x;
  for (let t = 1; t <= maxT; t++) {
    // Current decision starts affecting physics after ACTION_LATENCY frames;
    // subsequent decisions refresh every snapshot-configured tick group. The tactical
    // target remains the same, so only the held direction is resampled.
    if (
      t === CFG.ACTION_LATENCY + 1 ||
      (t > CFG.ACTION_LATENCY + 1 &&
        (t - (CFG.ACTION_LATENCY + 1)) % c.tickGroup === 0)
    ) {
      heldX = moveToward(x, targetX);
    }
    x = clamp(x + heldX * C.WALK, C.LEFT_MIN, C.LEFT_MAX);
    xs.push(x);
  }
  return xs;
}

function firstGroundContactForTarget(c, freeTr, targetX, maxT) {
  const xs = groundXTimelineToTarget(c, targetX, maxT);
  for (let i = 0; i < min(maxT, freeTr.frames.length); i++) {
    const bf = freeTr.frames[i];
    if (bf.ground) return null; // world ground is processed before player collision
    const px = xs[i];
    if (
      abs(bf.x - px) <= C.PLAYER_HALF &&
      abs(bf.y - C.PLAYER_GROUND_Y) <= C.PLAYER_HALF
    ) {
      return { t: i + 1, bf, playerX: px };
    }
  }
  return null;
}

function findBestGroundReceive(c, freeTr, oppVy) {
  let best = null;
  const limit = min(CFG.CONTACT_HORIZON, freeTr.frames.length);

  // Enumerate tactical target centers, but score the FIRST collision that the
  // actual held-action path would produce.  v2 previously scored an arbitrary
  // later ideal contact; in the real engine an earlier overlap can happen and
  // completely change vx / net-side bounce / touch count.
  const targets = new Set();
  for (let i = 0; i < limit; i++) {
    const bf = freeTr.frames[i];
    if (bf.x > C.NET_X + 8) continue;
    if (abs(bf.y - C.PLAYER_GROUND_Y) > C.PLAYER_HALF - 1) continue;
    for (let oi = 0; oi < CFG.RECEIVE_OFFSETS.length; oi++) {
      targets.add(clamp(bf.x - CFG.RECEIVE_OFFSETS[oi], C.LEFT_MIN, C.LEFT_MAX));
    }
  }

  for (const targetX of targets) {
    const hit = firstGroundContactForTarget(c, freeTr, targetX, limit);
    if (!hit) continue;
    // Avoid edge-of-hitbox plans: one scheduling frame of variation should not
    // flip a planned clear into a miss or reverse its outgoing geometry.
    if (abs(hit.bf.x - hit.playerX) > C.PLAYER_HALF - 3) continue;
    const ev = evaluateBodyContact(c, hit.bf, hit.playerX, hit.t, oppVy);
    if (!ev) continue;
    ev.score -= hit.t * 0.20 + abs(targetX - c.self.x) * 0.01;
    ev.contactFrame = hit.t;
    ev.ballFrame = hit.bf;
    ev.playerX = hit.playerX;
    ev.targetX = targetX;
    if (!best || ev.score > best.score) best = ev;
  }
  return best;
}

// ============================================================================
// [L] JUMP-TAKEOFF PLANNER
// ============================================================================
function jumpYAtAge(age) {
  if (age < 0 || age >= JUMP_TABLE.length) return C.PLAYER_GROUND_Y;
  return JUMP_TABLE[age].y;
}

function bestPowerValueFromContactBall(c, bf, contactFrame, oppVy) {
  let best = -1e9;
  for (const fast of [false, true]) {
    for (let y = -1; y <= 1; y++) {
      if (y === 1 && C.NET_X - bf.x > CFG.DOWN_SMASH_MAX_NET_DISTANCE) continue;
      const xIn = fast ? 1 : 0;
      // Use the same exact collision function as actual attack execution.
      const after = ordinaryCollisionFrom(bf, bf.x - 8, true, xIn, y, true);
      const tr = simulateTrajectory(after, CFG.BALL_HORIZON, c.skill);
      const ev = evaluateOutgoingTrajectory(tr, c, oppVy, contactFrame);
      if (ev.score > best) best = ev.score;
    }
  }
  return best;
}

function chooseHeldXForContact(xAfterLatency, bfX, moveFrames, tickGroup) {
  let bestX = 0;
  let bestSlack = -1e9;
  for (let x = -1; x <= 1; x++) {
    const held = min(tickGroup, moveFrames);
    const x1 = clamp(xAfterLatency + x * C.WALK * held, C.LEFT_MIN, C.LEFT_MAX);
    const rem = max(0, moveFrames - held);
    const slack = rem * C.WALK + C.PLAYER_HALF - abs(bfX - x1);
    if (slack > bestSlack) { bestSlack = slack; bestX = x; }
  }
  return { x: bestX, slack: bestSlack };
}

function findJumpTakeoff(c, freeTr, oppVy) {
  if (c.self.state !== 0) return null;
  let best = null;

  const xAfterLatency = predictedSelfXAfterLatency(c);
  for (let i = CFG.ACTION_LATENCY; i < min(CFG.JUMP_MAX_CONTACT, freeTr.frames.length); i++) {
    const bf = freeTr.frames[i];
    const t = i + 1;
    if (bf.x > C.NET_X + 6) continue;
    const age = t - CFG.ACTION_LATENCY;
    const py = jumpYAtAge(age);
    if (abs(bf.y - py) > C.PLAYER_HALF - 2) continue;

    const moveFrames = max(0, t - CFG.ACTION_LATENCY);
    const heldChoice = chooseHeldXForContact(xAfterLatency, bf.x, moveFrames, c.tickGroup);
    if (heldChoice.slack < 0) continue;

    let value;
    if (t >= CFG.JUMP_POWER_MIN_CONTACT_FRAME) {
      value = bestPowerValueFromContactBall(c, bf, t, oppVy);
    } else {
      const px = clamp(bf.x - 10, C.LEFT_MIN, C.LEFT_MAX);
      const body = evaluateBodyContact(c, bf, px, t, oppVy);
      value = body ? body.score : -100;
    }

    value += max(0, 190 - bf.y) * 0.08;
    value -= t * 0.18;
    value += min(20, heldChoice.slack) * 0.25;
    if (!best || value > best.value) {
      best = {
        value, t,
        targetX: clamp(bf.x, C.LEFT_MIN, C.LEFT_MAX),
        moveX: heldChoice.x,
        ballFrame: bf,
      };
    }
  }
  return best;
}

function findAirborneIntercept(c, freeTr, selfVy) {
  if (c.self.state !== 1 && c.self.state !== 2) return null;
  const pseudo = { ...c.self, state: c.self.state === 2 ? 1 : c.self.state };
  const tl = neutralVerticalTimeline(pseudo, selfVy, min(24, freeTr.frames.length) + 2);
  let best = null;
  const limit = min(24, freeTr.frames.length);
  for (let i = 0; i < limit; i++) {
    const t = i + 1;
    const bf = freeTr.frames[i];
    if (bf.x > C.NET_X + 8 || bf.ground) continue;
    const py = tl[min(t, tl.length - 1)].y;
    if (abs(bf.y - py) > C.PLAYER_HALF - 2) continue;
    const heldChoice = chooseHeldXForContact(c.self.x, bf.x, t, c.tickGroup);
    if (heldChoice.slack < 0) continue;
    const score = 120 - t * 2 + min(20, heldChoice.slack) + max(0, 180 - bf.y) * 0.05;
    if (!best || score > best.score) {
      best = { t, targetX: clamp(bf.x, C.LEFT_MIN, C.LEFT_MAX), moveX: heldChoice.x, score };
    }
  }
  return best;
}

// ============================================================================
// [M] EMERGENCY DIVE
// ============================================================================
function chooseDive(c, freeTr) {
  if (c.self.state !== 0) return null;
  const limit = min(CFG.DIVE_HORIZON, freeTr.frames.length);
  for (let i = 0; i < limit; i++) {
    const bf = freeTr.frames[i];
    const t = i + 1;
    if (bf.x >= C.NET_X || bf.y < CFG.DIVE_MIN_BALL_Y) continue;
    const dist = abs(bf.x - c.self.x) - C.PLAYER_HALF;
    const walk = C.WALK * max(0, t - CFG.ACTION_LATENCY);
    const dive = C.WALK * CFG.ACTION_LATENCY + C.DIVE * max(0, t - CFG.ACTION_LATENCY);
    if (dist > walk + CFG.DIVE_EXTRA_MARGIN && dist <= dive + CFG.DIVE_EXTRA_MARGIN) {
      return { type: 'DIVE', x: sign(bf.x - c.self.x) || 1, y: 0, hit: 1, contactFrame: t };
    }
  }
  return null;
}

// ============================================================================
// [N] OPPONENT CONTACT-FIRST THREAT GENERATION
// ============================================================================
function bodyThreatsFromOpponentContact(c, bf, contactFrame, contactStates) {
  const out = [];
  const offsets = [-30, -20, -10, 10, 20, 30];
  for (let i = 0; i < offsets.length; i++) {
    const px = clamp(bf.x + offsets[i], C.RIGHT_MIN, C.RIGHT_MAX);
    if (abs(bf.x - px) > C.PLAYER_HALF || abs(bf.x - px) < 3) continue;
    const after = ordinaryCollisionFrom(bf, px, false, 0, 0, false);
    const tr = simulateTrajectory(after, CFG.BALL_HORIZON, c.skill);
    const land = trajectoryLanding(tr);
    if (land && land.x < C.NET_X) out.push({ type: 'OPP_BODY', contactFrame, tr, landing: land });
  }
  return out;
}

function powerThreatsFromOpponentContact(c, bf, contactFrame) {
  const out = [];
  for (const fast of [false, true]) {
    for (let y = -1; y <= 1; y++) {
      const xIn = fast ? 1 : 0;
      const after = ordinaryCollisionFrom(bf, bf.x + 8, true, xIn, y, false);
      const tr = simulateTrajectory(after, CFG.BALL_HORIZON, c.skill);
      const land = trajectoryLanding(tr);
      if (land && land.x < C.NET_X) out.push({ type: 'OPP_POWER', contactFrame, tr, landing: land });
    }
  }
  return out;
}

function predictOpponentThreats(c, oppVy) {
  const freeTr = simulateTrajectory(c.ball, CFG.THREAT_HORIZON, c.skill);
  const contacts = [];
  let earliest = null;

  for (let i = 0; i < freeTr.frames.length; i++) {
    const bf = freeTr.frames[i];
    if (bf.x < C.NET_X - 5) break;
    const t = i + 1;
    const r = canPlayerReachBallAt(c.opp, oppVy, 'RIGHT', t, bf);
    if (r.can) {
      if (earliest == null) earliest = t;
      if (t <= earliest + CFG.DEFENSE_CONTACT_WINDOW) {
        // If the opponent can jump into this contact by t, treat a power hit
        // as possible. This intentionally over-approximates strong opponents.
        const airborne = jumpVerticalOptionsAt(c.opp, oppVy, t, bf.y, t + 2) > 0;
        contacts.push({ t, bf, airborne });
      }
    }
    if (earliest != null && t > earliest + CFG.DEFENSE_CONTACT_WINDOW) break;
  }

  const threats = [];
  for (let i = 0; i < contacts.length; i++) {
    const cc = contacts[i];
    const body = bodyThreatsFromOpponentContact(c, cc.bf, cc.t, null);
    for (let j = 0; j < body.length; j++) threats.push(body[j]);
    if (cc.airborne) {
      const power = powerThreatsFromOpponentContact(c, cc.bf, cc.t);
      for (let j = 0; j < power.length; j++) threats.push(power[j]);
    }
    if (threats.length >= CFG.DEFENSE_THREAT_LIMIT) break;
  }

  // Deduplicate by coarse signature; keep event-rich variants distinct.
  const map = new Map();
  for (let i = 0; i < threats.length; i++) {
    const th = threats[i];
    const first = th.tr.frames[0] || { vx: 0, vy: 0 };
    const sig = [Math.round(th.landing.x / 4), Math.round(first.vx), Math.round(first.vy), th.tr.events.map((e) => e.type).join(':')].join('|');
    if (!map.has(sig)) map.set(sig, th);
  }
  return Array.from(map.values()).slice(0, CFG.DEFENSE_THREAT_LIMIT);
}

// Fast analytic defender model used only to choose a standby X. The real
// incoming-ball planner later uses the exact current trajectory and contact
// geometry, so this function intentionally favors robustness over precision.
function reactionLockAfterOpponentContact(contactFrame, tickGroup) {
  // Snapshot cadence follows config.tickFrameGroupSize relative to the snapshot that called
  // us. If the opponent contact happens on a snapshot frame, that snapshot
  // was taken BEFORE physics/collision, so the first informed action arrives
  // one action-latency window after the next snapshot.
  const r = contactFrame % tickGroup;
  return r === 0
    ? tickGroup + CFG.ACTION_LATENCY
    : tickGroup + CFG.ACTION_LATENCY - r;
}

function groundStartInterceptScore(x0, tr, lockFrames) {
  let best = 999;
  for (let i = 0; i < tr.frames.length; i++) {
    const bf = tr.frames[i];
    const t = i + 1;
    // Before a fresh post-hit snapshot can produce a new action, the defender
    // is effectively committed to the position/motion chosen in advance. For
    // standby scoring we conservatively assume no helpful post-shot movement
    // during that locked window. This is what makes fast short shots and late
    // cushion reversals matter strategically rather than only geometrically.
    const xReach = C.WALK * max(0, t - lockFrames) + C.PLAYER_HALF;
    if (abs(bf.x - x0) > xReach) continue;

    if (abs(bf.y - C.PLAYER_GROUND_Y) <= C.PLAYER_HALF) {
      best = min(best, t);
      continue;
    }

    // A reactive jump also cannot start before the lock expires.
    for (let start = lockFrames + 1; start <= t; start++) {
      const age = t - start + 1;
      if (age < JUMP_TABLE.length && abs(bf.y - JUMP_TABLE[age].y) <= C.PLAYER_HALF) {
        best = min(best, t);
        break;
      }
    }
  }
  if (best === 999) return -CFG.DEFENSE_NO_INTERCEPT_PENALTY;
  return 100 - best * 4;
}

function chooseDefensiveStandby(c, oppVy, precomputedThreats) {
  const threats = precomputedThreats || predictOpponentThreats(c, oppVy);
  if (!threats.length) {
    // Mildly bias opposite the opponent's current position. This creates room
    // against both short and deep direct returns without committing to a wall.
    const bias = clamp((c.opp.x - 324) * -0.10, -14, 14);
    return clamp(CFG.HOME_X + bias, 72, 148);
  }

  let bestX = CFG.HOME_X;
  let bestWorst = -1e9;
  for (let x = C.LEFT_MIN; x <= C.LEFT_MAX; x += CFG.DEFENSE_X_STEP) {
    let worst = 1e9;
    for (let i = 0; i < threats.length; i++) {
      const th = threats[i];
      const lock = reactionLockAfterOpponentContact(th.contactFrame, c.tickGroup);
      const s = groundStartInterceptScore(x, th.tr, lock);
      if (s < worst) worst = s;
    }
    const moveCost = abs(x - c.self.x) * CFG.DEFENSE_MOVE_COST;
    const total = worst - moveCost;
    if (total > bestWorst) { bestWorst = total; bestX = x; }
  }
  return bestX;
}

// ============================================================================
// [O] TACTICAL PLANNER
// ============================================================================
function moveToward(x, target) {
  const d = target - x;
  if (abs(d) <= CFG.MOVE_DEADBAND) return 0;
  return d > 0 ? 1 : -1;
}

function planCore(c, selfVy, oppVy) {
  // 1) Airborne attack gets first refusal.
  const power = choosePowerAttack(c, selfVy, oppVy);
  if (power) return power;

  // Committed states: neutral is important because stale held hit/up inputs can
  // otherwise become a dive / re-jump immediately after recovery.
  if (c.self.state === 3 || c.self.state === 4 || c.self.state >= 5) {
    return { type: 'COMMITTED', x: 0, y: 0, hit: 0 };
  }

  const freeTr = simulateTrajectory(c.ball, CFG.BALL_HORIZON, c.skill);
  const land = trajectoryLanding(freeTr);
  if (!land) return { type: 'IDLE', x: 0, y: 0, hit: 0 };

  // Before committing to the current free trajectory, ask whether the opponent
  // can still touch the ball on their half. If yes, that trajectory is about
  // to become stale; jumping now is exactly the kind of irreversible mistake
  // a one-tick sampled controller must avoid.
  let imminentThreats = null;
  if (c.ball.x > C.NET_X + 2) {
    imminentThreats = predictOpponentThreats(c, oppVy);
    if (imminentThreats.length) {
      const standby = chooseDefensiveStandby(c, oppVy, imminentThreats);
      return { type: 'ANTICIPATE', x: moveToward(c.self.x, standby), y: 0, hit: 0, targetX: standby };
    }
  }

  // 2) If the free ball will remain / land on our side, solve the actual
  // incoming trajectory (including wall/net cushions) for contact.
  if (land.x < C.NET_X) {
    // Once airborne, never hand control back to the ground-receive planner.
    // Re-solve the current free trajectory against our actual jump arc. This
    // is crucial after a wall/net cushion changes the ball path mid-jump.
    if (c.self.state === 1 || c.self.state === 2) {
      const air = findAirborneIntercept(c, freeTr, selfVy);
      if (air) {
        return { type: 'AIR_INTERCEPT', x: air.moveX, y: 0, hit: 0, targetX: air.targetX, contactFrame: air.t, value: air.score };
      }
      return { type: 'AIR_RECOVER', x: moveToward(c.self.x, clamp(land.x, C.LEFT_MIN, C.LEFT_MAX)), y: 0, hit: 0 };
    }

    const ground = findBestGroundReceive(c, freeTr, oppVy);
    const jump = findJumpTakeoff(c, freeTr, oppVy);

    if (jump && (!ground || jump.value > ground.score + CFG.JUMP_MIN_VALUE_GAIN)) {
      return {
        type: 'JUMP_INTERCEPT',
        x: jump.moveX,
        y: -1,
        hit: 0,
        targetX: jump.targetX,
        contactFrame: jump.t,
        value: jump.value,
      };
    }

    if (!ground) {
      const dive = chooseDive(c, freeTr);
      if (dive) return dive;
    }

    if (ground) {
      return {
        type: ground.type,
        x: moveToward(c.self.x, ground.targetX == null ? ground.playerX : ground.targetX),
        y: 0,
        hit: 0,
        targetX: ground.targetX == null ? ground.playerX : ground.targetX,
        contactFrame: ground.contactFrame,
        value: ground.score,
      };
    }

    // Fallback tracks the actual incoming trajectory's landing, not a cached
    // landing value. Offset keeps ordinary body collision deterministic/netward.
    const fallbackX = clamp(land.x - 20, C.LEFT_MIN, C.LEFT_MAX);
    return { type: 'RECEIVE_FALLBACK', x: moveToward(c.self.x, fallbackX), y: 0, hit: 0, targetX: fallbackX };
  }

  // 3) Ball projects to opponent side. Predict opponent's contact first, roll
  // out their direct + cushion-capable replies, and choose a minimax standby.
  const standby = chooseDefensiveStandby(c, oppVy);
  return { type: 'DEFEND', x: moveToward(c.self.x, standby), y: 0, hit: 0, targetX: standby };
}

// ============================================================================
// [P] ACTION SAFETY EXECUTOR
// ============================================================================
function framesUntilLanding(p, vy) {
  if (p.state !== 1 && p.state !== 2 && p.state !== 3) return 999;
  let y = p.y;
  let v = vy;
  for (let t = 1; t <= 20; t++) {
    y += v;
    if (y < C.PLAYER_GROUND_Y) v += 1;
    else if (y > C.PLAYER_GROUND_Y) return t;
  }
  return 999;
}

function executeSafely(c, planned, selfVy) {
  let a = action(planned.x, planned.y, planned.hit);
  const override = SKILL.emergencyOverride(c, planned);
  if (override) a = action(override.x, override.y, override.hit);

  if (c.self.state === 3 || c.self.state === 4 || c.self.state >= 5) return action(0, 0, 0);

  if (c.self.state === 0) {
    if (planned.type !== 'DIVE') a.hit = 0;
    if (planned.type !== 'JUMP_INTERCEPT' && a.y === -1) a.y = 0;
  } else if (c.self.state === 1 || c.self.state === 2) {
    if (planned.type !== 'POWER') {
      a.hit = 0;
      if (a.y === -1) a.y = 0;
    } else {
      if (framesUntilLanding(c.self, selfVy) <= CFG.LANDING_SAFETY_FRAMES) {
        a.hit = 0;
        if (a.y === -1) a.y = 0;
      }
      // state2 is already armed. y/x still matter at collision, hit does not.
      if (c.self.state === 2) a.hit = 0;
    }
  }

  a.x = a.x < 0 ? -1 : a.x > 0 ? 1 : 0;
  a.y = a.y < 0 ? -1 : a.y > 0 ? 1 : 0;
  a.hit = a.hit ? 1 : 0;
  return a;
}

function debugLog(c, planned, a) {
  if (!CFG.DEBUG || MEM.decisions % CFG.DEBUG_EVERY !== 0) return;
  console.log('[PikaPlanner_v2]', {
    tick: c.tick,
    mode: planned.type,
    self: [c.self.x, c.self.y, c.self.state],
    opp: [c.opp.x, c.opp.y, c.opp.state],
    ball: [c.ball.x, c.ball.y, c.ball.vx, c.ball.vy],
    action: a,
    targetX: planned.targetX,
    value: planned.value || planned.score,
  });
}

// ============================================================================
// REQUIRED ENTRY POINT
// ============================================================================
function decide(snapshot) {
  const c = canonicalize(snapshot);
  MEM.decisions++;
  MEM.worldFlip = !!c.flip;
  updateMemory(c);

  const prevSelf = MEM.prev ? MEM.prev.self : null;
  const prevOpp = MEM.prev ? MEM.prev.opp : null;
  const selfVy = estimatePlayerVy(c.self, prevSelf, c.tickGroup);
  const oppVy = estimatePlayerVy(c.opp, prevOpp, c.tickGroup);

  let planned;
  try {
    planned = planCore(c, selfVy, oppVy);

    const extras = SKILL.extraActions(c) || [];
    if (extras.length) {
      let best = null;
      for (let i = 0; i < extras.length; i++) {
        const e = extras[i];
        const v = (typeof e.score === 'number' ? e.score : 0) + SKILL.evaluate(c, e);
        if (!best || v > best.v) best = { v, e };
      }
      if (best && best.v > 0) planned = best.e;
    }
  } catch (err) {
    if (CFG.DEBUG) console.warn('[PikaPlanner_v2] fallback', String(err));
    const target = c.ball.landingX < C.NET_X
      ? clamp(c.ball.landingX - 20, C.LEFT_MIN, C.LEFT_MAX)
      : C.HOME_X;
    planned = { type: 'FALLBACK', x: moveToward(c.self.x, target), y: 0, hit: 0, targetX: target };
  }

  if (planned && planned.type === 'SELF_SET' && planned.contactFrame != null) {
    const eta = c.tick + planned.contactFrame;
    if (MEM.selfSetPendingTick == null || eta < MEM.selfSetPendingTick) {
      MEM.selfSetPendingTick = eta;
    }
  }

  const canon = executeSafely(c, planned, selfVy);
  debugLog(c, planned, canon);
  if (CFG.DEBUG_EXPORT && typeof globalThis !== 'undefined') {
    globalThis.__PIKA_DEBUG_STATE__ = {
      tick: c.tick,
      mode: planned.type,
      targetX: planned.targetX == null ? null : planned.targetX,
      value: planned.value == null ? (planned.score == null ? null : planned.score) : planned.value,
      contactFrame: planned.contactFrame == null ? null : planned.contactFrame,
      action: cloneAction(canon),
      detail: planned.debug || null,
    };
  }
  MEM.lastAction = cloneAction(canon);
  MEM.prev = c;
  return uncanonicalize(canon, c.flip);
}
