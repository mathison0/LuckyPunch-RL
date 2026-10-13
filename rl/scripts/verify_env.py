"""Phase 1 검증: (0) Gymnasium env_checker, (a) 같은 시드 = 같은 결과, (b) 초당 env 스텝, (c) 랜덤 vs 내장 AI.

사용법: rl/.venv/Scripts/python rl/scripts/verify_env.py [--sets 48]
"""
from __future__ import annotations

import argparse
import hashlib
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pikarl import PikaEnv, PikaVecEnv  # noqa: E402


def rollout_hash(opponent: str, seed: int, side: str, act_seed: int, lag: int = 1, jitter: int = 8):
    """새 프로세스에서 랜덤 정책으로 한 세트를 돌리고 (관측·보상 해시, 점수, 스텝 수)를 반환."""
    env = PikaEnv(opponent=opponent, side=side, lag=lag, jitter=jitter, shaping=True)
    rng = np.random.default_rng(act_seed)
    obs, _ = env.reset(seed=seed)
    h = hashlib.sha256(obs.tobytes())
    steps = 0
    while True:
        obs, r, term, trunc, info = env.step(int(rng.integers(18)))
        h.update(obs.tobytes())
        h.update(np.float32(r).tobytes())
        steps += 1
        if term or trunc:
            break
    env.close()
    return h.hexdigest()[:16], (info["scoreSelf"], info["scoreOpp"]), steps


def check_determinism():
    print("== (a) 재현성: 같은 시드·같은 행동열 → 별도 프로세스 2회 실행 비교")
    ok = True
    for opp in ["ai", "LuckyPunch_v10.js", "LuckyPunch_v16.js"]:  # v10은 봇 내부 Math.random 사용
        for side in ["LEFT", "RIGHT"]:
            a = rollout_hash(opp, 1234, side, 7)
            b = rollout_hash(opp, 1234, side, 7)
            c = rollout_hash(opp, 1235, side, 7)
            same = a == b
            ok &= same
            print(f"  {opp:20s} {side:5s} run1={a[0]} run2={b[0]} {'일치' if same else '불일치!'}"
                  f"  (점수 {a[1][0]}-{a[1][1]}, {a[2]} steps; 다른 시드 → {c[0]}, {'다름' if c[0] != a[0] else '같음?'})")
    return ok


def check_env_checker():
    print("== (0) gymnasium env_checker / SB3 check_env")
    from gymnasium.utils.env_checker import check_env as gym_check
    from stable_baselines3.common.env_checker import check_env as sb3_check
    env = PikaEnv()
    gym_check(env, skip_render_check=True)
    sb3_check(env, warn=True)
    env.close()
    print("  통과")


def measure_sps(seconds: float = 8.0):
    print("== (b) 초당 env 스텝 (랜덤 행동, 상대 내장 AI / v16)")
    rows = []
    env = PikaEnv()
    env.reset(seed=1)
    rng = np.random.default_rng(0)
    n, t0 = 0, time.perf_counter()
    while time.perf_counter() - t0 < seconds:
        _, _, term, trunc, _ = env.step(int(rng.integers(18)))
        n += 1
        if term or trunc:
            env.reset()
    sps = n / (time.perf_counter() - t0)
    env.close()
    rows.append(("PikaEnv (1게임/1프로세스)", "ai", sps))
    for opp in ["ai", "LuckyPunch_v16.js"]:
        for nenv in [8, 32, 64]:
            venv = PikaVecEnv(nenv, opponent=opp, jitter=8, seed=1)
            venv.reset()
            n, t0 = 0, time.perf_counter()
            while time.perf_counter() - t0 < seconds:
                venv.step(rng.integers(18, size=nenv))
                n += nenv
            sps = n / (time.perf_counter() - t0)
            venv.close()
            rows.append((f"PikaVecEnv n={nenv}", opp, sps))
    for name, opp, sps in rows:
        print(f"  {name:28s} 상대={opp:18s} {sps:9.0f} steps/s")
    return rows


def random_vs_ai(sets: int):
    print(f"== (c) 랜덤 에이전트 vs 내장 AI: {sets}세트 (lag1, 지터 0/8 반반, 양 진영 반반)")
    wins = pts_self = pts_opp = 0
    rallies = 0
    venv_by_jit = {}
    for jit in (0, 8):
        venv_by_jit[jit] = PikaVecEnv(sets // 2, opponent="ai", jitter=jit, seed=10_000 + jit)
    rng = np.random.default_rng(0)
    for jit, venv in venv_by_jit.items():
        venv.reset()
        finished = [False] * venv.num_envs
        while not all(finished):
            _, _, dones, infos = venv.step(rng.integers(18, size=venv.num_envs))
            for i, d in enumerate(dones):
                if d and not finished[i]:
                    finished[i] = True
                    info = infos[i]
                    wins += info["win"]
                    pts_self += info["scoreSelf"]
                    pts_opp += info["scoreOpp"]
                    rallies += info["rallies"]
        venv.close()
    print(f"  세트 {wins}/{sets} ({wins / sets:.1%})  득점 {pts_self}-{pts_opp}"
          f"  랠리 승률 {pts_self / max(1, pts_self + pts_opp):.1%} (n={pts_self + pts_opp}랠리)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sets", type=int, default=48)
    args = ap.parse_args()
    check_env_checker()
    det_ok = check_determinism()
    measure_sps()
    random_vs_ai(args.sets)
    sys.exit(0 if det_ok else 1)
