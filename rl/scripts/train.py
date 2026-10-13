"""PPO 학습 (Stable-Baselines3, 기본 하이퍼파라미터). 상대는 내장 AI.

주기마다 결정론적 정책으로 내장 AI 상대 평가 → learning_curve.csv 한 줄 + 체크포인트 저장.

사용법:
  rl/.venv/Scripts/python rl/scripts/train.py --name shaping_off --total-steps 10000000
  rl/.venv/Scripts/python rl/scripts/train.py --name shaping_on --shaping --total-steps 10000000
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
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


class EvalCallback(BaseCallback):
    """eval_every 스텝마다 내장 AI 상대 평가 + 체크포인트."""

    def __init__(self, out: Path, eval_every: int, specs: list[dict]):
        super().__init__()
        self.out, self.eval_every, self.specs = out, eval_every, specs
        self.next_eval = 0
        self.t0 = time.time()
        self.csv_path = out / "learning_curve.csv"
        with open(self.csv_path, "w", newline="") as f:
            csv.writer(f).writerow(["steps", "wall_sec", "eval_sets", "set_win", "rally_win", "pts_self", "pts_opp"])

    def _evaluate(self):
        res = summarize(run_games(sb3_policy(self.model), self.specs), keys=())[()]
        row = [self.num_timesteps, round(time.time() - self.t0, 1), res["sets"], round(res["set_win"], 4),
               round(res["rally_win"], 4), res["pts_self"], res["pts_opp"]]
        with open(self.csv_path, "a", newline="") as f:
            csv.writer(f).writerow(row)
        self.model.save(self.out / "checkpoints" / f"step_{self.num_timesteps:09d}")
        print(f"[eval] steps={self.num_timesteps:,} set_win={res['set_win']:.1%} rally_win={res['rally_win']:.1%} "
              f"({res['pts_self']}-{res['pts_opp']}, n={res['sets']} sets) wall={row[1]}s", flush=True)

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
    ap.add_argument("--total-steps", type=int, default=10_000_000)
    ap.add_argument("--n-envs", type=int, default=16)
    ap.add_argument("--lag", type=int, default=1)
    ap.add_argument("--jitter", type=int, default=8)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--eval-every", type=int, default=250_000)
    ap.add_argument("--eval-seeds", type=int, default=12, help="주기 평가: 시드×지터{0,8}×양 진영")
    ap.add_argument("--threads", type=int, default=2)
    args = ap.parse_args()

    torch.set_num_threads(args.threads)
    out = RUNS / args.name
    (out / "checkpoints").mkdir(parents=True, exist_ok=True)
    (out / "config.json").write_text(json.dumps(vars(args), indent=2))

    env = VecMonitor(PikaVecEnv(args.n_envs, opponent="ai", lag=args.lag, jitter=args.jitter,
                                shaping=args.shaping, touch_bonus=args.touch_bonus, seed=args.seed * 1_000_000))
    model = PPO("MlpPolicy", env, seed=args.seed, device="cpu", verbose=0)  # 하이퍼파라미터는 SB3 기본값
    model.set_logger(configure(str(out / "sb3_log"), ["csv"]))
    specs = protocol_specs(["ai"], lags=(args.lag,), jitters=(0, 8), n_seeds=args.eval_seeds)
    cb = EvalCallback(out, args.eval_every, specs)
    t0 = time.time()
    model.learn(total_timesteps=args.total_steps, callback=cb)
    model.save(out / "final")
    print(f"done: {args.total_steps:,} steps in {time.time() - t0:.0f}s", flush=True)
    env.close()


if __name__ == "__main__":
    main()
