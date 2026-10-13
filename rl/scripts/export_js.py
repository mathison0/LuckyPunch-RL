"""학습된 PPO 정책을 대회 규약의 단일 JS 봇 파일(decide 함수 하나)로 내보낸다.

- 관측 인코딩은 rl/pika_env.mjs encodeObs와 한 줄씩 대응한다 (바꾸면 둘 다 바꿀 것).
- 신경망: 37 → 64(tanh) → 64(tanh) → 18 logits, argmax = 결정론적 정책 (평가 때와 같음).
- import/require 없음, 외부 의존 없음 → 브라우저 게임 [봇 설정] 드롭다운에서 바로 선택 가능.

사용법:
  rl/.venv/Scripts/python rl/scripts/export_js.py rl/runs/pool_lagrand/final.zip src/code-here/LuckyPunchRL_v1.js
검증:
  rl/.venv/Scripts/python rl/scripts/evaluate_final.py --tag js_check --seeds 6 \
      pool_lagrand=rl/runs/pool_lagrand/final.zip rule:LuckyPunchRL_v1.js   (두 줄 결과가 같아야 함)
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np
from stable_baselines3 import PPO


def arr(a: np.ndarray) -> str:
    # float32 값을 왕복 가능한 최소 자릿수로 (np.float32 repr)
    return "[" + ",".join(repr(float(np.float32(x))).rstrip("0").rstrip(".") if x != 0 else "0"
                          for x in np.asarray(a, np.float32).ravel()) + "]"


TEMPLATE = r"""'use strict';
/*
 * __NAME__ — PPO 강화학습 정책을 내보낸 봇 (리온이 배구 RL 실험)
 *
 * 원본 모델 : __SRC__  (__STEPS__ 스텝, SB3 PPO MlpPolicy)
 * 내보낸 날 : __DATE__  (rl/scripts/export_js.py)
 * 실험 기록 : docs/strategy/rl.md
 *
 * 관측(37) → Linear 64 + tanh → Linear 64 + tanh → Linear 18 → argmax
 * 관측 인코딩은 rl/pika_env.mjs encodeObs와 같다. 행동 a = (x+1)*6 + (y+1)*2 + hit (항상 LEFT 관점, RIGHT면 x 미러)
 * 매치당 1회 실행되므로 아래 전역(prevSnap, lastAct)이 tick 사이에 유지된다.
 */
var GW = 432, WIN = 10;
var W1 = __W1__; // 64x37 (행 우선)
var B1 = __B1__;
var W2 = __W2__; // 64x64
var B2 = __B2__;
var W3 = __W3__; // 18x64
var B3 = __B3__;

var prevSnap = null;                 // 직전 tick의 필요한 값만 복사해 둔다
var lastAct = { x: 0, y: 0, hit: 0 }; // 직전에 낸 행동 (LEFT 관점)

function encode(s) {
  var m = s.side === 'RIGHT';
  var fx = function (x) { return m ? GW - x : x; };
  var fv = function (v) { return m ? -v : v; };
  var o = new Array(37);
  for (var i = 0; i < 37; i++) o[i] = 0;
  var k = 0;
  function player(p) {
    o[k++] = fx(p.x) / GW;
    o[k++] = p.y / 252;
    o[k + Math.min(Math.max(p.state, 0), 6)] = 1; k += 7;
    o[k++] = p.frameNumber / 5;
    o[k++] = fv(p.divingDirection);
  }
  player(s.self);
  player(s.opp);
  var b = s.ball;
  o[k++] = fx(b.x) / GW;
  o[k++] = b.y / 252;
  o[k++] = fv(b.xVelocity) / 20;
  o[k++] = b.yVelocity / 30;
  o[k++] = fx(b.expectedLandingPointX) / GW;
  o[k++] = b.isPowerHit ? 1 : 0;
  var frozen = prevSnap && prevSnap.bx === b.x && prevSnap.by === b.y ? 1 : 0;
  o[k++] = prevSnap ? fv(s.opp.x - prevSnap.ox) / 18 : 0;
  o[k++] = frozen;
  o[k++] = s.meta.score.self / WIN;
  o[k++] = s.meta.score.opp / WIN;
  o[k++] = (s.meta.isPlayer2Serve === m) ? 1 : 0;
  o[k++] = Math.min(s.meta.rallyFrameCount, 1000) / 1000;
  o[k++] = lastAct.x;
  o[k++] = lastAct.y;
  o[k++] = lastAct.hit;
  return o;
}

function dense(W, B, x, nOut, nIn, act) {
  var y = new Array(nOut);
  for (var i = 0; i < nOut; i++) {
    var acc = B[i], row = i * nIn;
    for (var j = 0; j < nIn; j++) acc += W[row + j] * x[j];
    y[i] = act ? Math.tanh(acc) : acc;
  }
  return y;
}

function decide(s) {
  var obs = encode(s);
  var h1 = dense(W1, B1, obs, 64, 37, true);
  var h2 = dense(W2, B2, h1, 64, 64, true);
  var logits = dense(W3, B3, h2, 18, 64, false);
  var a = 0;
  for (var i = 1; i < 18; i++) if (logits[i] > logits[a]) a = i;
  var x = ((a / 6) | 0) - 1, y = (((a / 2) | 0) % 3) - 1, hit = a % 2;
  lastAct = { x: x, y: y, hit: hit };
  prevSnap = { bx: s.ball.x, by: s.ball.y, ox: s.opp.x };
  return { x: s.side === 'RIGHT' ? -x : x, y: y, hit: hit };
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("out")
    args = ap.parse_args()
    model = PPO.load(args.model, device="cpu")
    sd = {k: v.numpy() for k, v in model.policy.state_dict().items()}
    assert sd["mlp_extractor.policy_net.0.weight"].shape == (64, 37), "관측/네트워크 구조가 예상과 다름"
    steps = int(model.num_timesteps)
    out = Path(args.out)
    js = (TEMPLATE
          .replace("__NAME__", out.stem)
          .replace("__SRC__", Path(args.model).as_posix())
          .replace("__STEPS__", f"{steps:,}")
          .replace("__DATE__", dt.date.today().isoformat())
          .replace("__W1__", arr(sd["mlp_extractor.policy_net.0.weight"]))
          .replace("__B1__", arr(sd["mlp_extractor.policy_net.0.bias"]))
          .replace("__W2__", arr(sd["mlp_extractor.policy_net.2.weight"]))
          .replace("__B2__", arr(sd["mlp_extractor.policy_net.2.bias"]))
          .replace("__W3__", arr(sd["action_net.weight"]))
          .replace("__B3__", arr(sd["action_net.bias"])))
    out.write_text(js, encoding="utf-8", newline="\n")
    print(json.dumps({"out": str(out), "bytes": len(js.encode()), "steps": steps}))


if __name__ == "__main__":
    main()
