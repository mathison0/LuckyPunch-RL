"""학습 곡선 그림 (runs/*/learning_curve.csv).

- 기본(1차 실험): 셰이핑 OFF/ON의 내장 AI 상대 랠리·세트 승률을 한 그림에 겹쳐 그린다.
- --per-opponent (2차 실험): run마다 서브플롯 하나, 평가 상대별 랠리 승률 곡선.

사용법:
  rl/.venv/Scripts/python rl/scripts/plot_curve.py
  rl/.venv/Scripts/python rl/scripts/plot_curve.py pool_lag1 pool_lagrand --per-opponent \
      --out docs/strategy/img/rl_pool_curve.png
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

RL = Path(__file__).resolve().parent.parent
RUNS = RL / "runs"
LABELS = {"shaping_off": "shaping OFF (+1/-1 only)", "shaping_on": "shaping ON (+0.05 per touch)"}
HOLDOUT = {"LuckyPunch_v16.js", "PikaPlanner_v4.js"}  # config.json이 없을 때만 쓰는 기본값


def load(name: str) -> pd.DataFrame | None:
    path = RUNS / name / "learning_curve.csv"
    if not path.exists():
        return None
    df = pd.read_csv(path)
    if "opponent" not in df.columns:  # 1차 실험 CSV는 내장 AI 단일 상대
        df["opponent"] = "ai"
    return df


def plot_overlay(runs: list[str], out: str):
    fig, axes = plt.subplots(1, 2, figsize=(11, 4), sharex=True)
    for name in runs:
        df = load(name)
        if df is None:
            continue
        df = df[df.opponent == "ai"]
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
    fig.savefig(out, dpi=130)


def plot_per_opponent(runs: list[str], out: str):
    fig, axes = plt.subplots(1, len(runs), figsize=(5.5 * len(runs), 4), sharey=True, squeeze=False)
    for ax, name in zip(axes[0], runs):
        df = load(name)
        if df is None:
            continue
        n = int(df["eval_sets"].iloc[-1])
        cfg = RUNS / name / "config.json"
        train_list = set(json.loads(cfg.read_text()).get("opponent_list", [])) if cfg.exists() else None
        for opp, d in df.groupby("opponent", sort=False):
            label = "built-in AI" if opp == "ai" else Path(opp).stem.replace("LuckyPunch_", "")
            held = (opp not in train_list) if train_list else opp in HOLDOUT
            ax.plot(d.steps / 1e6, d.rally_win * 100, marker="o", ms=3,
                    ls="--" if held else "-", label=label + (" (held-out)" if held else " (train pool)"))
        ax.set_title(f"{name}: rally win % (n={n} sets/point)")
        ax.set_xlabel("env steps (M)")
        ax.set_ylim(0, 100)
        ax.axhline(50, color="gray", lw=0.8, ls=":")
        ax.grid(alpha=0.3)
    axes[0][0].set_ylabel("rally win %")
    axes[0][0].legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(out, dpi=130)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runs", nargs="*", default=["shaping_off", "shaping_on"])
    ap.add_argument("--per-opponent", action="store_true")
    ap.add_argument("--out", default=str(RL.parent / "docs" / "strategy" / "img" / "rl_learning_curve.png"))
    args = ap.parse_args()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    (plot_per_opponent if args.per_opponent else plot_overlay)(args.runs, args.out)
    print("saved", args.out)


if __name__ == "__main__":
    main()
