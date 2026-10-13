"""Phase 3 최종 평가: 에이전트들 × 평가 상대 9종 × lag × 지터{0,8} × 시드 24 × 양 진영.

에이전트 지정:
  <라벨>=<모델.zip>     PPO 체크포인트 (결정론적 정책)
  rule:<봇파일>         룰 봇 기준선 (같은 환경·같은 명세, rl/scripts/eval_rulebot.mjs)
  random                랜덤 정책 기준선

사용법:
  rl/.venv/Scripts/python rl/scripts/evaluate_final.py --tag final --lags 1 \
      ppo_off=rl/runs/shaping_off/final.zip ppo_on=rl/runs/shaping_on/final.zip rule:LuckyPunch_v16.js random
출력: rl/results/eval_<tag>.csv (게임별 원자료), rl/results/eval_<tag>.md (요약표)
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pikarl.env import find_node  # noqa: E402
from pikarl.evaluate import protocol_specs, random_policy, run_games, sb3_policy  # noqa: E402

RL = Path(__file__).resolve().parent.parent
OUT = RL / "results"


def eval_opponents() -> list[str]:
    """평가 상대 목록의 단일 출처: rl/tests/opponents.mjs EVAL_OPPONENTS."""
    src = (RL / "tests" / "opponents.mjs").read_text(encoding="utf-8")
    block = re.search(r"EVAL_OPPONENTS = \[(.*?)\];", src, re.S).group(1)
    return re.findall(r"'([^']+)'", block)


def run_agent_chunk(agent: str, specs: list[dict]) -> list[dict]:
    if agent.startswith("rule:"):
        p = subprocess.run([find_node(), str(RL / "scripts" / "eval_rulebot.mjs"), agent[5:]],
                           input=json.dumps(specs), capture_output=True, text=True, encoding="utf-8", check=True)
        return json.loads(p.stdout)
    if agent == "random":
        return run_games(random_policy(0), specs, n_slots=48)
    label, path = agent.split("=", 1)
    from stable_baselines3 import PPO
    model = PPO.load(path, device="cpu")
    return run_games(sb3_policy(model), specs, n_slots=48)


def agent_label(agent: str) -> str:
    if agent.startswith("rule:"):
        return Path(agent[5:]).stem
    return agent.split("=", 1)[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("agents", nargs="+")
    ap.add_argument("--tag", required=True)
    ap.add_argument("--lags", default="1")
    ap.add_argument("--seeds", type=int, default=24)
    ap.add_argument("--opponents", default=None, help="쉼표 구분. 기본: opponents.mjs EVAL_OPPONENTS")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    torch.set_num_threads(1)

    opponents = args.opponents.split(",") if args.opponents else eval_opponents()
    lags = tuple(int(x) for x in args.lags.split(","))
    jobs = []
    for agent in args.agents:
        for opp in opponents:
            for lag in lags:
                jobs.append((agent, protocol_specs([opp], lags=(lag,), n_seeds=args.seeds)))
    print(f"{len(args.agents)} agents × {len(opponents)} opponents × lag {lags} → "
          f"{sum(len(s) for _, s in jobs)} sets", flush=True)

    t0 = time.time()
    rows = []
    with ThreadPoolExecutor(args.workers) as ex:
        futs = {ex.submit(run_agent_chunk, a, s): a for a, s in jobs}
        for f in futs:
            for r in f.result():
                rows.append({"agent": agent_label(futs[f]), **r})
    print(f"done in {time.time() - t0:.0f}s", flush=True)

    OUT.mkdir(exist_ok=True)
    df = pd.DataFrame(rows)
    df.to_csv(OUT / f"eval_{args.tag}.csv", index=False)

    g = df.groupby(["agent", "lag", "opponent"], sort=False)
    summ = g.agg(sets=("win", "size"), wins=("win", "sum"), pts_self=("scoreSelf", "sum"),
                 pts_opp=("scoreOpp", "sum")).reset_index()
    summ["set_win"] = summ["wins"] / summ["sets"]
    summ["rally_win"] = summ["pts_self"] / (summ["pts_self"] + summ["pts_opp"])

    agents = [agent_label(a) for a in args.agents]
    lines = [f"# 평가 결과: {args.tag}", "",
             f"프로토콜: 지터 {{0,8}} × 시드 {args.seeds} × 양 진영 = 상대당 {args.seeds * 4}세트 (lag별). "
             "칸 = 세트 승률 / 랠리 승률(내 득점÷전체 득점). 랠리 수는 원자료 CSV 참고.", ""]
    for lag in lags:
        lines += [f"## lag {lag}", "", "| 에이전트 | " + " | ".join(Path(o).stem for o in opponents) + " | 평균 |",
                  "|---" * (len(opponents) + 2) + "|"]
        for a in agents:
            cells, sw, rw = [], [], []
            for o in opponents:
                r = summ[(summ.agent == a) & (summ.lag == lag) & (summ.opponent == o)].iloc[0]
                cells.append(f"{r.set_win:.0%} / {r.rally_win:.0%}")
                sw.append(r.set_win)
                rw.append(r.rally_win)
            lines.append(f"| {a} | " + " | ".join(cells) +
                         f" | {sum(sw) / len(sw):.0%} / {sum(rw) / len(rw):.0%} |")
        lines.append("")
    (OUT / f"eval_{args.tag}.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
