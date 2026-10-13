"""PPO 학습 (Stable-Baselines3, 기본 하이퍼파라미터).

주기마다 결정론적 정책으로 평가 상대별 평가 → learning_curve.csv (상대별 한 줄씩) + 체크포인트 저장.

사용법:
  # 1차 실험: 내장 AI 단일 상대
  rl/.venv/Scripts/python rl/scripts/train.py --name shaping_off --total-steps 20000000 --eval-every 500000
  rl/.venv/Scripts/python rl/scripts/train.py --name shaping_on --shaping --total-steps 20000000 --eval-every 500000
  # 2차 실험: 상대 풀 7종, v16·PikaPlanner_v4 홀드아웃 (lag 고정 / 무작위)
  rl/.venv/Scripts/python rl/scripts/train.py --name pool_lag1 --shaping --opponents pool7 --shards 4 \
      --eval-opponents ai,LuckyPunch_v14.js,LuckyPunch_v16.js,PikaPlanner_v4.js --eval-every 1000000 --eval-seeds 6
  (pool_lagrand는 위에 --lags 1,2,3 추가)
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import torch
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.logger import configure
from stable_baselines3.common.vec_env import VecMonitor

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pikarl import PikaVecEnv  # noqa: E402
from pikarl.evaluate import protocol_specs, run_games, sb3_policy, summarize  # noqa: E402

RUNS = Path(__file__).resolve().parent.parent / "runs"
# 2차 실험 학습 상대 풀: 평가 상대 9종에서 홀드아웃(v16, PikaPlanner_v4)을 뺀 7종
POOLS = {
    "pool7": ["ai", "LuckyPunch_v01.js", "LuckyPunch_v05.js", "LuckyPunch_v07.js", "LuckyPunch_v10.js",
              "LuckyPunch_v12.js", "LuckyPunch_v14.js"],
}
# 3차 실험: pool7 + 수비형 PikaPlanner 2종. PikaPlanner_v4·v2_1과 v16은 홀드아웃
POOLS["pool9"] = POOLS["pool7"] + ["PikaPlanner_v2.js", "PikaPlanner_v3_netfront_stable.js"]


class EvalCallback(BaseCallback):
    """eval_every 스텝마다 평가 상대별 평가(상대끼리 병렬) + 체크포인트."""

    def __init__(self, out: Path, eval_every: int, specs_by_opp: dict[str, list[dict]]):
        super().__init__()
        self.out, self.eval_every, self.specs_by_opp = out, eval_every, specs_by_opp
        self.next_eval = 0
        self.t0 = time.time()
        self.csv_path = out / "learning_curve.csv"
        with open(self.csv_path, "w", newline="") as f:
            csv.writer(f).writerow(["steps", "wall_sec", "opponent", "eval_sets", "set_win", "rally_win",
                                    "pts_self", "pts_opp"])

    def _evaluate(self):
        policy = sb3_policy(self.model)
        with ThreadPoolExecutor(len(self.specs_by_opp)) as ex:
            futs = {o: ex.submit(run_games, policy, s) for o, s in self.specs_by_opp.items()}
            res = {o: summarize(f.result(), keys=())[()] for o, f in futs.items()}
        wall = round(time.time() - self.t0, 1)
        with open(self.csv_path, "a", newline="") as f:
            w = csv.writer(f)
            for o, r in res.items():
                w.writerow([self.num_timesteps, wall, o, r["sets"], round(r["set_win"], 4), round(r["rally_win"], 4),
                            r["pts_self"], r["pts_opp"]])
        self.model.save(self.out / "checkpoints" / f"step_{self.num_timesteps:09d}")
        msg = " ".join(f"{Path(o).stem.replace('LuckyPunch_', '')}={r['set_win']:.0%}/{r['rally_win']:.0%}"
                       for o, r in res.items())
        print(f"[eval] steps={self.num_timesteps:,} set/rally: {msg} wall={wall}s", flush=True)

    def _on_step(self) -> bool:
        if self.num_timesteps >= self.next_eval:
            self._evaluate()
            self.next_eval += self.eval_every
        return True

    def _on_training_end(self):
        self._evaluate()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--shaping", action="store_true", help="내 공 접촉마다 +touch_bonus")
    ap.add_argument("--touch-bonus", type=float, default=0.05)
    ap.add_argument("--total-steps", type=int, default=20_000_000)
    ap.add_argument("--n-envs", type=int, default=16)
    ap.add_argument("--shards", type=int, default=1, help="게임을 나눠 돌릴 Node 프로세스 수")
    ap.add_argument("--opponents", default="ai", help="쉼표 구분 봇 목록 또는 풀 이름(pool7)")
    ap.add_argument("--lags", default="1", help="쉼표 구분. 여러 개면 에피소드마다 무작위")
    ap.add_argument("--jitter", type=int, default=8)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--eval-every", type=int, default=500_000)
    ap.add_argument("--eval-opponents", default="ai")
    ap.add_argument("--eval-lag", type=int, default=1)
    ap.add_argument("--eval-seeds", type=int, default=12, help="주기 평가: 시드×지터{0,8}×양 진영")
    ap.add_argument("--threads", type=int, default=2)
    args = ap.parse_args()

    torch.set_num_threads(args.threads)
    out = RUNS / args.name
    (out / "checkpoints").mkdir(parents=True, exist_ok=True)
    opponents = POOLS.get(args.opponents, args.opponents.split(","))
    lags = [int(x) for x in args.lags.split(",")]
    (out / "config.json").write_text(json.dumps({**vars(args), "opponent_list": opponents, "lag_list": lags},
                                                indent=2))

    env = VecMonitor(PikaVecEnv(args.n_envs, opponent=opponents, lag=lags, jitter=args.jitter,
                                shaping=args.shaping, touch_bonus=args.touch_bonus, seed=args.seed * 1_000_000,
                                shards=args.shards))
    model = PPO("MlpPolicy", env, seed=args.seed, device="cpu", verbose=0)  # 하이퍼파라미터는 SB3 기본값
    model.set_logger(configure(str(out / "sb3_log"), ["csv"]))
    specs = {o: protocol_specs([o], lags=(args.eval_lag,), jitters=(0, 8), n_seeds=args.eval_seeds)
             for o in args.eval_opponents.split(",")}
    cb = EvalCallback(out, args.eval_every, specs)
    t0 = time.time()
    model.learn(total_timesteps=args.total_steps, callback=cb)
    model.save(out / "final")
    print(f"done: {args.total_steps:,} steps in {time.time() - t0:.0f}s", flush=True)
    env.close()


if __name__ == "__main__":
    main()
