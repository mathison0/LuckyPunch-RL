"""학습 곡선 그림: 스텝 대비 내장 AI 상대 랠리·세트 승률 (runs/*/learning_curve.csv).

사용법: rl/.venv/Scripts/python rl/scripts/plot_curve.py [run이름 ...] [--out docs/strategy/img/rl_learning_curve.png]
"""
from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

RL = Path(__file__).resolve().parent.parent
RUNS = RL / "runs"
LABELS = {"shaping_off": "shaping OFF (+1/-1 only)", "shaping_on": "shaping ON (+0.05 per touch)"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runs", nargs="*", default=["shaping_off", "shaping_on"])
    ap.add_argument("--out", default=str(RL.parent / "docs" / "strategy" / "img" / "rl_learning_curve.png"))
    args = ap.parse_args()

    fig, axes = plt.subplots(1, 2, figsize=(11, 4), sharex=True)
    for name in args.runs:
        path = RUNS / name / "learning_curve.csv"
        if not path.exists():
            continue
        df = pd.read_csv(path)
        n = int(df["eval_sets"].iloc[-1])
        for ax, col in zip(axes, ["rally_win", "set_win"]):
            ax.plot(df["steps"] / 1e6, df[col] * 100, marker=".", label=f"{LABELS.get(name, name)}")
        axes[0].set_title(f"Rally win rate vs built-in AI (eval n={n} sets/point)")
        axes[1].set_title(f"Set win rate vs built-in AI (n={n} sets/point)")
    for ax in axes:
        ax.set_xlabel("env steps (M) — 1 step = 1 decision tick (3 frames)")
        ax.set_ylabel("%")
        ax.set_ylim(0, 100)
        ax.axhline(50, color="gray", lw=0.8, ls="--")
        ax.grid(alpha=0.3)
    axes[0].axhline(7.3, color="red", lw=0.8, ls=":", label="random agent (7.3%)")
    axes[0].legend(loc="upper left", fontsize=8)
    fig.tight_layout()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.out, dpi=130)
    print("saved", args.out)


if __name__ == "__main__":
    main()
