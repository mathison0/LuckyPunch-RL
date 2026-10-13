"""정책 평가 러너. 학습 중 주기 평가(Phase 2)와 최종 평가표(Phase 3)가 같은 코드를 쓴다.

게임 명세(spec) = {opponent, side, lag, jitter, seed}. Node 프로세스 1개에서 슬롯 n개로 명세 큐를 소화한다.
정책은 관측 배치(np.ndarray [n, obs_dim]) → 행동 배치를 돌려주는 함수.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Callable, Iterable

import numpy as np

from .env import NodeClient

Policy = Callable[[np.ndarray], np.ndarray]

# 학습 시드(PikaVecEnv: seed + k*n + i, 작은 정수)와 겹치지 않는 평가 전용 시드 대역
EVAL_SEED_BASE = 900_000_000


def protocol_specs(opponents: Iterable[str], lags=(1,), jitters=(0, 8), n_seeds: int = 24,
                   seed_base: int = EVAL_SEED_BASE) -> list[dict]:
    """기존 측정 프로토콜: 상대 × lag × 지터 × 시드 × 양 진영."""
    specs = []
    for opp in opponents:
        for lag in lags:
            for jit in jitters:
                for s in range(n_seeds):
                    for side in ("LEFT", "RIGHT"):
                        specs.append({"opponent": opp, "side": side, "lag": lag, "jitter": jit,
                                      "seed": seed_base + s * 7919})
    return specs


def run_games(policy: Policy, specs: list[dict], n_slots: int = 32) -> list[dict]:
    """명세 전부를 한 번씩 플레이하고 명세+결과(scoreSelf, scoreOpp, win, rallies, frames)를 반환."""
    n = min(n_slots, len(specs))
    client = NodeClient(n)
    try:
        queue = list(enumerate(specs))
        slot_spec: list[tuple[int, dict] | None] = [None] * n
        obs = np.zeros((n, client.obs_dim), np.float32)
        results: list[dict | None] = [None] * len(specs)

        def start(i: int) -> bool:
            if not queue:
                slot_spec[i] = None
                return False
            idx, spec = queue.pop(0)
            r = client.call({"cmd": "reset", "i": i, **spec})
            slot_spec[i] = (idx, spec)
            obs[i] = r["obs"]
            return True

        for i in range(n):
            start(i)
        while any(s is not None for s in slot_spec):
            actions = np.asarray(policy(obs), dtype=np.int64).reshape(-1)
            r = client.call({"cmd": "step", "a": [int(a) for a in actions]})
            for i in range(n):
                if slot_spec[i] is None:
                    continue
                obs[i] = r["obs"][i]
                if r["done"][i]:
                    idx, spec = slot_spec[i]
                    results[idx] = {**spec, **r["info"][i]}
                    start(i)
        return results  # type: ignore[return-value]
    finally:
        client.close()


def summarize(results: list[dict], keys=("opponent",)) -> dict:
    """keys별 세트 승률·랠리 승률. 랠리 승률 = 내 득점 / 전체 득점 (4000프레임 무승부 랠리 제외)."""
    agg: dict = defaultdict(lambda: {"sets": 0, "wins": 0, "pts_self": 0, "pts_opp": 0})
    for r in results:
        k = tuple(r[key] for key in keys)
        a = agg[k]
        a["sets"] += 1
        a["wins"] += int(r["win"])
        a["pts_self"] += r["scoreSelf"]
        a["pts_opp"] += r["scoreOpp"]
    out = {}
    for k, a in agg.items():
        rallies = a["pts_self"] + a["pts_opp"]
        out[k] = {**a, "set_win": a["wins"] / a["sets"],
                  "rally_win": a["pts_self"] / rallies if rallies else float("nan"), "rallies": rallies}
    return out


def sb3_policy(model, deterministic: bool = True) -> Policy:
    def f(obs: np.ndarray) -> np.ndarray:
        a, _ = model.predict(obs, deterministic=deterministic)
        return a
    return f


def random_policy(seed: int = 0) -> Policy:
    rng = np.random.default_rng(seed)
    return lambda obs: rng.integers(18, size=len(obs))
