"""ACTION_LATENCY 절제 실험: PikaPlanner의 가정 지연(ACTION_LATENCY)과 실제 lag의 일치 여부가 수비 견고함을 좌우하는가.

상대 = PikaPlanner 3종의 사본(bots/<봇>_AL{1,2,3}.js, ACTION_LATENCY 한 줄만 다름; AL1은 원본과 바이트 동일).
칸마다 기존 프로토콜(지터 {0,8} × 시드 24 × 양 진영 = 96세트, 결정론적 정책) 그대로 돌린다.
기존 스크립트는 고치지 않고 evaluate_final.run_agent_chunk / diagnose.classify를 그대로 가져다 쓴다.

사용법:
  # 1) 동치성 점검: 원본 vs AL1 사본, lag 1·2·3, 랠리 로그까지 비교 + 기존 eval_pool9*.csv와 대조
  rl/.venv/Scripts/python rl/experiments/latency_ablation/run.py check --cache <캐시 폴더> \
      pool9_lagrand=rl/runs/pool9_lagrand/final.zip
  # 2) 매트릭스: 에이전트 × 상대 3종 × AL{1,2,3} × lag{1,2,3}
  rl/.venv/Scripts/python rl/experiments/latency_ablation/run.py matrix --cache <캐시 폴더> \
      pool9_lagrand=rl/runs/pool9_lagrand/final.zip pool_lagrand=rl/runs/pool_lagrand/final.zip rule:LuckyPunch_v16.js
  # 3) 집계: rl/results/latency_ablation.{csv,md}
  rl/.venv/Scripts/python rl/experiments/latency_ablation/run.py report --cache <캐시 폴더> \
      pool9_lagrand=... pool_lagrand=... rule:LuckyPunch_v16.js
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd
import torch

HERE = Path(__file__).resolve().parent
RL = HERE.parent.parent
sys.path.insert(0, str(RL))
sys.path.insert(0, str(RL / "scripts"))
from diagnose import classify  # noqa: E402
from evaluate_final import agent_label, run_agent_chunk  # noqa: E402
from pikarl.evaluate import protocol_specs  # noqa: E402

BOTS = HERE / "bots"
OPPONENTS = ["PikaPlanner_v3_netfront_stable", "PikaPlanner_v2_1_stable_candidate", "PikaPlanner_v4"]
SHORT = {"PikaPlanner_v3_netfront_stable": "v3", "PikaPlanner_v2_1_stable_candidate": "v2_1", "PikaPlanner_v4": "v4"}
ALS = (1, 2, 3)
LAGS = (1, 2, 3)
# 기존 3차 평가 원자료 (대조용)
BASELINE_CSV = {"PikaPlanner_v4": "eval_pool9.csv",
                "PikaPlanner_v3_netfront_stable": "eval_pool9_extended.csv",
                "PikaPlanner_v2_1_stable_candidate": "eval_pool9_extended.csv"}
GAME_KEYS = ("side", "lag", "jitter", "seed")


def opp_file(base: str, al: int | None) -> str:
    """al=None이면 원본(src/code-here 상대 경로, 기존 평가와 같은 지정 방식), 아니면 사본 절대 경로."""
    return f"{base}.js" if al is None else str(BOTS / f"{base}_AL{al}.js")


def job_key(agent: str, base: str, al: int | None, lag: int) -> str:
    return f"{agent_label(agent)}__{base}_{'orig' if al is None else f'AL{al}'}__lag{lag}"


def run_job(agent: str, base: str, al: int | None, lag: int, cache: Path) -> list[dict]:
    path = cache / f"{job_key(agent, base, al, lag)}.json.gz"
    if path.exists():
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    specs = [{**s, "log": True} for s in protocol_specs([opp_file(base, al)], lags=(lag,))]
    res = run_agent_chunk(agent, specs)
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(res, f)
    tmp.replace(path)
    return res


def run_all(jobs: list[tuple], cache: Path, workers: int) -> dict:
    out = {}
    t0 = time.time()
    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(run_job, *j, cache): j for j in jobs}
        for i, f in enumerate(as_completed(futs), 1):
            j = futs[f]
            out[j] = f.result()
            print(f"[{i}/{len(jobs)}] {job_key(*j)}  ({time.time() - t0:.0f}s)", flush=True)
    return out


def game_row(r: dict) -> dict:
    """게임 1개 → 세트 결과 + 공격/수비 계수 (diagnose.py와 같은 분류)."""
    log = r["rallyLog"]
    types = [classify(x) for x in log]
    return {
        "side": r["side"], "lag": r["lag"], "jitter": r["jitter"], "seed": r["seed"],
        "scoreSelf": r["scoreSelf"], "scoreOpp": r["scoreOpp"], "win": bool(r["win"]),
        "frames": r["frames"], "rallies": r["rallies"], "oppErrors": r["oppErrors"],
        "self_touches": sum(x["st"] for x in log), "opp_touches": sum(x["ot"] for x in log),
        "attack_success": types.count("opp_failed_recv"),  # 내가 마지막으로 친 공을 상대가 못 받음
        "failed_recv": types.count("failed_recv"), "own_error": types.count("own_error"),
    }


# ── check ──
def cmd_check(agent: str, cache: Path, workers: int) -> bool:
    jobs = [(agent, b, al, lag) for b in OPPONENTS for al in (None, 1) for lag in LAGS]
    res = run_all(jobs, cache, workers)
    ok = True
    print("\n== 동치성 점검: 원본 vs ACTION_LATENCY=1 사본 (게임 결과 + 랠리 로그 전체) ==")
    for b in OPPONENTS:
        for lag in LAGS:
            a, c = res[(agent, b, None, lag)], res[(agent, b, 1, lag)]
            strip = lambda r: {k: v for k, v in r.items() if k != "opponent"}  # noqa: E731
            same = len(a) == len(c) and all(strip(x) == strip(y) for x, y in zip(a, c))
            n_r = sum(len(x["rallyLog"]) for x in a)
            print(f"  {SHORT[b]:5s} lag {lag}: {'동일' if same else '불일치'} ({len(a)}세트, 랠리 {n_r})")
            ok &= same
    print("\n== 대조: AL1 사본 vs 기존 결과 CSV (게임별 scoreSelf/scoreOpp/win/frames/rallies) ==")
    label = agent_label(agent)
    for b in OPPONENTS:
        base = pd.read_csv(RL / "results" / BASELINE_CSV[b])
        base = base[(base.agent == label) & (base.opponent == f"{b}.js")]
        for lag in LAGS:
            mine = pd.DataFrame([game_row(r) for r in res[(agent, b, 1, lag)]])
            ref = base[base.lag == lag]
            m = mine.merge(ref, on=list(GAME_KEYS), suffixes=("", "_ref"))
            cols = ["scoreSelf", "scoreOpp", "win", "frames", "rallies"]
            diff = sum(int((m[c] != m[c + "_ref"]).sum()) for c in cols)
            same = len(m) == len(mine) == len(ref) == 96 and diff == 0
            print(f"  {SHORT[b]:5s} lag {lag}: {'일치' if same else '불일치'} "
                  f"(매칭 {len(m)}/96, 승률 {mine.win.mean():.0%} vs 기존 {ref.win.mean():.0%})")
            ok &= same
    print("\n점검 결과:", "통과" if ok else "실패 — 매트릭스를 돌리지 말 것")
    return ok


# ── report ──
def wilson(k: int, n: int, z: float = 1.959964) -> tuple[float, float]:
    if n == 0:
        return float("nan"), float("nan")
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def cmd_report(agents: list[str], cache: Path, out_tag: str):
    rows = []
    for agent in agents:
        for b in OPPONENTS:
            for al in ALS:
                for lag in LAGS:
                    path = cache / f"{job_key(agent, b, al, lag)}.json.gz"
                    if not path.exists():
                        continue
                    with gzip.open(path, "rt", encoding="utf-8") as f:
                        for r in json.load(f):
                            rows.append({"agent": agent_label(agent), "opponent": b, "action_latency": al,
                                         **game_row(r)})
    df = pd.DataFrame(rows)
    df.to_csv(RL / "results" / f"{out_tag}.csv", index=False)

    g = df.groupby(["agent", "opponent", "action_latency", "lag"], sort=False).agg(
        sets=("win", "size"), wins=("win", "sum"), pts_self=("scoreSelf", "sum"), pts_opp=("scoreOpp", "sum"),
        atk=("attack_success", "sum"), touches=("self_touches", "sum"),
        frecv=("failed_recv", "sum"), opp_touches=("opp_touches", "sum")).reset_index()

    def cell(r) -> str:
        lo, hi = wilson(int(r.wins), int(r.sets))
        return (f"**{r.wins / r.sets:.0%}** [{lo:.0%}–{hi:.0%}]<br>"
                f"공격 {r.atk / r.touches:.2%} ({int(r.atk)}/{int(r.touches)})")

    lines = [f"# ACTION_LATENCY 절제 실험 ({out_tag})", "",
             "상대 = PikaPlanner 사본, `ACTION_LATENCY`(봇이 가정하는 입력 반영 지연, 프레임) 한 줄만 다름. "
             "lag = 환경의 실제 반영 지연(에이전트·상대 양쪽 동일).",
             "칸 = **세트 승률** [Wilson 95% CI] / 공격 성공률 = 상대 리시브 실패(내가 마지막으로 친 공이 상대 코트에 떨어짐) ÷ 내 접촉 수.",
             "칸마다 지터 {0,8} × 시드 24 × 양 진영 = 96세트, 결정론적 정책. 대각선(AL = lag)이 '봇 가정 = 현실' 조건.",
             "AL=1 행은 원본과 바이트 동일한 사본이다(동치성 점검 통과).", ""]
    for agent in [agent_label(a) for a in agents]:
        lines += [f"## 에이전트: {agent}", ""]
        for b in OPPONENTS:
            sub = g[(g.agent == agent) & (g.opponent == b)]
            if sub.empty:
                continue
            lines += [f"### vs {b}", "", "| ACTION_LATENCY \\ lag | lag 1 | lag 2 | lag 3 |", "|---|---|---|---|"]
            for al in ALS:
                cells = []
                for lag in LAGS:
                    r = sub[(sub.action_latency == al) & (sub.lag == lag)]
                    cells.append(cell(r.iloc[0]) if len(r) else "—")
                lines.append(f"| AL {al} | " + " | ".join(cells) + " |")
            lines.append("")
        # 요약: 대각선 vs 불일치
        lines += ["#### 요약 (세트 승률)", "", "| 상대 | 일치 대각선 AL=lag (1/2/3) | 원본 AL=1 (lag 1/2/3) | 불일치 칸 평균 |", "|---|---|---|---|"]
        for b in OPPONENTS:
            sub = g[(g.agent == agent) & (g.opponent == b)]
            if len(sub) < 9:
                continue
            sw = lambda al, lag: float(sub[(sub.action_latency == al) & (sub.lag == lag)].eval("wins/sets").iloc[0])  # noqa: E731
            diag = " / ".join(f"{sw(k, k):.0%}" for k in LAGS)
            orig = " / ".join(f"{sw(1, k):.0%}" for k in LAGS)
            off = [sw(al, lag) for al in ALS for lag in LAGS if al != lag]
            lines.append(f"| {SHORT[b]} | {diag} | {orig} | {sum(off) / len(off):.0%} |")
        lines.append("")
    (RL / "results" / f"{out_tag}.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["check", "matrix", "report"])
    ap.add_argument("agents", nargs="+")
    ap.add_argument("--cache", required=True, type=Path)
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--out", default="latency_ablation")
    args = ap.parse_args()
    torch.set_num_threads(1)
    args.cache.mkdir(parents=True, exist_ok=True)

    if args.phase == "check":
        sys.exit(0 if cmd_check(args.agents[0], args.cache, args.workers) else 1)
    if args.phase == "matrix":
        jobs = [(a, b, al, lag) for a in args.agents for b in OPPONENTS for al in ALS for lag in LAGS]
        run_all(jobs, args.cache, args.workers)
    cmd_report(args.agents, args.cache, args.out)


if __name__ == "__main__":
    main()
