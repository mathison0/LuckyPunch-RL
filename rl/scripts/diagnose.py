"""실패 분석: 랠리가 "어떻게" 끝났는지 집계한다 (rl.md 5절의 근거).

랠리 종료 유형 (에이전트 관점):
  serve_fault  내 서브 랠리에서 내가 공에 한 번도 못 닿고 실점
  failed_recv  상대가 마지막으로 친 공이 내 코트에 떨어짐 (상대 공격을 못 받음)
  own_error    내가 마지막으로 친 공이 내 코트에 떨어짐 (네트·자기 코트)
  touch_limit  내가 5회 연속 접촉으로 실점
득점도 같은 기준으로 opp_* 로 나눈다.

사용법:
  rl/.venv/Scripts/python rl/scripts/diagnose.py --tag lag1 \
      ppo_off=rl/runs/shaping_off/final.zip ppo_on=rl/runs/shaping_on/final.zip rule:LuckyPunch_v16.js
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from evaluate_final import RL, agent_label, run_agent_chunk  # noqa: E402
from pikarl.evaluate import protocol_specs  # noqa: E402

DEFAULT_OPPS = "ai,LuckyPunch_v01.js,LuckyPunch_v05.js,LuckyPunch_v10.js,LuckyPunch_v16.js,PikaPlanner_v4.js"


def classify(r: dict) -> str:
    if r["cause"] == "limit":
        return "touch_limit" if not r["won"] else "opp_touch_limit"
    if r["won"]:
        if r["last"] == "none":
            return "opp_serve_fault"
        return "opp_failed_recv" if r["last"] == "self" else "opp_own_error"
    if r["last"] == "none":
        return "serve_fault"
    return "failed_recv" if r["last"] == "opp" else "own_error"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("agents", nargs="+")
    ap.add_argument("--tag", required=True)
    ap.add_argument("--lag", type=int, default=1)
    ap.add_argument("--seeds", type=int, default=24)
    ap.add_argument("--opponents", default=DEFAULT_OPPS)
    ap.add_argument("--workers", type=int, default=10)
    args = ap.parse_args()
    torch.set_num_threads(1)
    opps = args.opponents.split(",")

    jobs = []
    for a in args.agents:
        for o in opps:
            specs = [{**s, "log": True} for s in protocol_specs([o], lags=(args.lag,), n_seeds=args.seeds)]
            jobs.append((a, o, specs))
    rallies = []
    with ThreadPoolExecutor(args.workers) as ex:
        futs = [(a, o, ex.submit(run_agent_chunk, a, s)) for a, o, s in jobs]
        for a, o, f in futs:
            for game in f.result():
                for r in game["rallyLog"]:
                    rallies.append({"agent": agent_label(a), "opponent": Path(o).stem, **r, "type": classify(r)})
    df = pd.DataFrame(rallies)
    out = RL / "results"
    out.mkdir(exist_ok=True)
    df.to_csv(out / f"diagnose_{args.tag}.csv", index=False)

    lines = [f"# 랠리 진단: {args.tag} (lag {args.lag}, 상대당 {args.seeds * 4}세트)", "",
             "실점 유형 비율은 '실점한 랠리' 중 비율. 서브/리시브 승률은 내가 서브한 랠리 / 상대가 서브한 랠리의 승률.", "",
             "| 에이전트 | 상대 | 랠리 | 서브 랠리 승률 | 리시브 랠리 승률 | 실점: 못 받음 | 실점: 자기 실책 | 실점: 서브 미스 | 실점: 5회 접촉 "
             "| 평균 네트 왕복 | 파워히트 비율 | 못 받은 공까지 거리(중앙값) | 못 받을 때 공중/누움 |",
             "|---" * 13 + "|"]
    for (a, o), d in df.groupby(["agent", "opponent"], sort=False):
        lost = d[d.won == 0]
        c = Counter(lost["type"])
        n_lost = max(1, len(lost))
        sv, rv = d[d.serve == 1], d[d.serve == 0]
        fr = lost[lost.type == "failed_recv"]
        dist = np.median(np.abs(fr.landX - fr.selfX)) if len(fr) else float("nan")
        air = (fr.selfState.isin([1, 2])).mean() if len(fr) else float("nan")
        lying = (fr.selfState.isin([3, 4])).mean() if len(fr) else float("nan")
        ph = d.sph.sum() / max(1, d.st.sum())
        lines.append(
            f"| {a} | {o} | {len(d)} | {sv.won.mean():.0%} (n={len(sv)}) | {rv.won.mean():.0%} (n={len(rv)}) | "
            f"{c['failed_recv'] / n_lost:.0%} | {c['own_error'] / n_lost:.0%} | {c['serve_fault'] / n_lost:.0%} | "
            f"{c['touch_limit'] / n_lost:.0%} | {d.cross.mean():.1f} | {ph:.0%} | {dist:.0f}px | "
            f"{air:.0%} / {lying:.0%} |")
    (out / f"diagnose_{args.tag}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
