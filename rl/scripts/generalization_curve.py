"""일반화 곡선: 체크포인트별로 학습 상대(내장 AI)가 아닌 상대에 대한 랠리 승률을 잰다.

내장 AI 상대 성능이 오르는 동안 다른 상대에 대한 성능이 같이 오르는지(일반화) / 정체·하락하는지(과적합)를 본다.

사용법: rl/.venv/Scripts/python rl/scripts/generalization_curve.py [--seeds 12]
출력: rl/results/generalization.csv, docs/strategy/img/rl_generalization_curve.png
"""
from __future__ import annotations

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402
import torch  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pikarl.evaluate import protocol_specs, run_games, sb3_policy, summarize  # noqa: E402

RL = Path(__file__).resolve().parent.parent
STEPS = [500_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000, 10_000_000, 15_000_000, 20_000_000]
OPPS = ["ai", "LuckyPunch_v01.js", "LuckyPunch_v10.js", "LuckyPunch_v16.js"]


def ckpt(run: str, step: int) -> Path:
    return RL / "runs" / run / "checkpoints" / f"step_{step:09d}.zip"


def job(run: str, step: int, opp: str, seeds: int) -> dict:
    from stable_baselines3 import PPO
    model = PPO.load(ckpt(run, step), device="cpu")
    res = summarize(run_games(sb3_policy(model), protocol_specs([opp], n_seeds=seeds), n_slots=48), keys=())[()]
    return {"run": run, "steps": step, "opponent": opp, **res}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=12, help="시드×지터{0,8}×양 진영 = 4×seeds 세트")
    ap.add_argument("--workers", type=int, default=10)
    args = ap.parse_args()
    torch.set_num_threads(1)
    runs = ["shaping_off", "shaping_on"]
    tasks = [(r, s, o) for r in runs for s in STEPS for o in OPPS if ckpt(r, s).exists()]
    with ThreadPoolExecutor(args.workers) as ex:
        rows = list(ex.map(lambda t: job(*t, args.seeds), tasks))
    df = pd.DataFrame(rows)
    (RL / "results").mkdir(exist_ok=True)
    df.to_csv(RL / "results" / "generalization.csv", index=False)

    fig, axes = plt.subplots(1, 2, figsize=(11, 4), sharey=True)
    for ax, run in zip(axes, runs):
        for opp in OPPS:
            d = df[(df.run == run) & (df.opponent == opp)].sort_values("steps")
            label = "built-in AI (train opponent)" if opp == "ai" else Path(opp).stem.replace("LuckyPunch_", "")
            ax.plot(d.steps / 1e6, d.rally_win * 100, marker="o", label=label, lw=2.2 if opp == "ai" else 1.4)
        ax.set_title(f"{run}: rally win rate by opponent (n={args.seeds * 4} sets/point)")
        ax.set_xlabel("env steps (M)")
        ax.axhline(50, color="gray", lw=0.8, ls="--")
        ax.set_ylim(0, 100)
        ax.grid(alpha=0.3)
    axes[0].set_ylabel("rally win %")
    axes[0].legend(fontsize=8)
    fig.tight_layout()
    out = RL.parent / "docs" / "strategy" / "img" / "rl_generalization_curve.png"
    fig.savefig(out, dpi=130)
    print(df.pivot_table(index=["run", "steps"], columns="opponent", values="rally_win").round(3).to_string())
    print("saved", out)


if __name__ == "__main__":
    main()
