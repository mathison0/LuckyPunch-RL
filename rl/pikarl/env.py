"""리온이 배구 RL 환경 (Python 쪽).

Node 프로세스(rl/env_server.mjs)가 실제 엔진을 돌리고, 여기서는 줄 단위 JSON으로 명령만 보낸다.
- PikaEnv:    Gymnasium Env. 게임 1개 = Node 프로세스 1개. env_checker·SubprocVecEnv용.
- PikaVecEnv: SB3 VecEnv. 게임 N개를 Node 프로세스 1개에서 배치로 진행 (IPC 1회 = N스텝). 학습용.

행동: Discrete(18) = x{-1,0,1} × y{-1,0,1} × hit{0,1}, 인덱스 = (x+1)*6 + (y+1)*2 + hit (에이전트 관점).
관측: 37차원, 항상 LEFT 관점으로 미러링 (구성은 rl/pika_env.mjs encodeObs).
보상: 득점 +1 / 실점 -1, shaping=True면 내 공 접촉마다 +touch_bonus.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium import spaces
from stable_baselines3.common.vec_env.base_vec_env import VecEnv

RL_DIR = Path(__file__).resolve().parent.parent
SERVER = RL_DIR / "env_server.mjs"
N_ACTIONS = 18
DEFAULT_TOUCH_BONUS = 0.05


def find_node() -> str:
    for cand in (os.environ.get("NODE"), shutil.which("node"), r"C:\Program Files\nodejs\node.exe"):
        if cand and Path(cand).exists():
            return cand
    raise FileNotFoundError("node 실행 파일을 찾을 수 없음 (NODE 환경변수로 지정 가능)")


def action_index(x: int, y: int, hit: int) -> int:
    return (x + 1) * 6 + (y + 1) * 2 + hit


class NodeClient:
    """env_server.mjs 프로세스 하나와의 줄 단위 JSON 통신."""

    def __init__(self, n: int):
        self.proc = subprocess.Popen(
            [find_node(), str(SERVER)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,  # stderr는 그대로 콘솔로
            text=True, encoding="utf-8", bufsize=1,
        )
        r = self.call({"cmd": "init", "n": n})
        self.obs_dim = int(r["obsDim"])

    def call(self, msg: dict) -> dict:
        self.send(msg)
        return self.recv()

    def send(self, msg: dict):
        self.proc.stdin.write(json.dumps(msg, separators=(",", ":")) + "\n")
        self.proc.stdin.flush()

    def recv(self) -> dict:
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError(f"env_server 종료됨 (exit={self.proc.poll()}); 위 stderr 참고")
        r = json.loads(line)
        if "error" in r:
            raise RuntimeError(r["error"])
        return r

    def close(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.write('{"cmd":"close"}\n')
                self.proc.stdin.flush()
                self.proc.wait(timeout=5)
            except Exception:
                self.proc.kill()


def _reward(ev, shaping: bool, touch_bonus: float) -> float:
    scored, conceded, touch = ev
    r = float(scored - conceded)
    if shaping:
        r += touch_bonus * touch
    return r


class PikaEnv(gym.Env):
    """한 세트(10점) = 한 에피소드. 에이전트 결정 tick(3프레임) = 한 step."""

    metadata = {"render_modes": []}

    def __init__(self, opponent: str = "ai", side: str = "random", lag: int = 1, jitter: int = 0,
                 shaping: bool = False, touch_bonus: float = DEFAULT_TOUCH_BONUS):
        super().__init__()
        self.opponent, self.side, self.lag, self.jitter = opponent, side, lag, jitter
        self.shaping, self.touch_bonus = shaping, touch_bonus
        self.client = NodeClient(1)
        self.observation_space = spaces.Box(-np.inf, np.inf, (self.client.obs_dim,), np.float32)
        self.action_space = spaces.Discrete(N_ACTIONS)

    def reset(self, *, seed: int | None = None, options: dict | None = None):
        super().reset(seed=seed)
        opts = options or {}
        game_seed = int(self.np_random.integers(0, 2**31 - 1)) if seed is None else int(seed)
        side = opts.get("side", self.side)
        if side == "random":
            side = "LEFT" if self.np_random.random() < 0.5 else "RIGHT"
        self._side = side
        r = self.client.call({
            "cmd": "reset", "i": 0, "seed": game_seed, "side": side,
            "opponent": opts.get("opponent", self.opponent),
            "lag": opts.get("lag", self.lag), "jitter": opts.get("jitter", self.jitter),
        })
        return np.asarray(r["obs"], np.float32), {"side": side, "seed": game_seed}

    def step(self, action):
        r = self.client.call({"cmd": "step", "a": [int(action)]})
        ev = r["ev"][0]
        done = r["done"][0]
        info: dict[str, Any] = {"scored": ev[0], "conceded": ev[1], "touch": ev[2]}
        if done:
            info.update(r["info"][0])
        return (np.asarray(r["obs"][0], np.float32), _reward(ev, self.shaping, self.touch_bonus),
                bool(done), False, info)

    def close(self):
        self.client.close()


class PikaVecEnv(VecEnv):
    """게임 n개를 Node 프로세스 shards개에 나눠 배치로 돌리는 VecEnv. 끝난 게임은 다음 시드로 자동 리셋.

    step은 모든 shard에 요청을 먼저 보내고 응답을 모아서 받으므로 shard들이 병렬로 진행한다
    (상대 봇 decide가 무거울 때 Node 단일 스레드 병목을 피하기 위함).

    시드: slot i의 k번째 에피소드 = seed + k*n + i. 진영은 (k+i) 짝홀로 번갈아 → 양 진영 균등.
    opponent가 목록이면 에피소드 번호 순으로 돌아가며 배정, lag가 목록이면 에피소드마다 무작위(시드 고정).
    """

    def __init__(self, n: int, opponent: str | list[str] = "ai", lag: int | list[int] = 1, jitter: int = 0,
                 shaping: bool = False, touch_bonus: float = DEFAULT_TOUCH_BONUS, seed: int = 0, shards: int = 1):
        shards = max(1, min(shards, n))
        # slot i → (shard, shard 안 인덱스). 앞쪽 shard부터 균등 분할
        self.shard_sizes = [n // shards + (1 if j < n % shards else 0) for j in range(shards)]
        self.clients = [NodeClient(m) for m in self.shard_sizes]
        self.slot_map = [(j, li) for j, m in enumerate(self.shard_sizes) for li in range(m)]
        obs_space = spaces.Box(-np.inf, np.inf, (self.clients[0].obs_dim,), np.float32)
        super().__init__(n, obs_space, spaces.Discrete(N_ACTIONS))
        self.opponents = opponent if isinstance(opponent, list) else [opponent]
        self.lags = lag if isinstance(lag, list) else [lag]
        self.jitter, self.shaping, self.touch_bonus = jitter, shaping, touch_bonus
        self.base_seed = seed
        self.episode_k = [0] * n
        self._actions = None

    def _reset_slot(self, i: int) -> np.ndarray:
        k = self.episode_k[i]
        self.episode_k[i] += 1
        g = k * self.num_envs + i  # 이 env의 전체 에피소드 번호
        # lag 목록이 여러 개면 에피소드마다 시드 고정 난수로 하나를 뽑는다 (지연 무작위화)
        if len(self.lags) == 1:
            lag = self.lags[0]
        else:
            lag = self.lags[int(np.random.default_rng([self.base_seed, g]).integers(len(self.lags)))]
        shard, li = self.slot_map[i]
        r = self.clients[shard].call({
            "cmd": "reset", "i": li, "seed": self.base_seed + g,
            "side": "LEFT" if (k + i) % 2 == 0 else "RIGHT",
            "opponent": self.opponents[g % len(self.opponents)],
            "lag": lag, "jitter": self.jitter,
        })
        return np.asarray(r["obs"], np.float32)

    def reset(self):
        return np.stack([self._reset_slot(i) for i in range(self.num_envs)])

    def step_async(self, actions):
        self._actions = [int(a) for a in actions]

    def step_wait(self):
        pos = 0
        for c, m in zip(self.clients, self.shard_sizes):  # 먼저 전부 보내고
            c.send({"cmd": "step", "a": self._actions[pos:pos + m]})
            pos += m
        parts = [c.recv() for c in self.clients]  # 그다음 모아서 받는다 (shard끼리 병렬 진행)
        r = {k: [x for p in parts for x in p[k]] for k in ("obs", "ev", "done", "info")}
        obs = np.asarray(r["obs"], np.float32)
        rews = np.zeros(self.num_envs, np.float32)
        dones = np.asarray(r["done"], bool)
        infos: list[dict] = []
        for i in range(self.num_envs):
            ev = r["ev"][i]
            rews[i] = _reward(ev, self.shaping, self.touch_bonus)
            info: dict[str, Any] = {}
            if dones[i]:
                info.update(r["info"][i])
                info["terminal_observation"] = obs[i].copy()
                info["TimeLimit.truncated"] = False
                obs[i] = self._reset_slot(i)
            infos.append(info)
        return obs, rews, dones, infos

    def close(self):
        for c in self.clients:
            c.close()

    # SB3 VecEnv 추상 메서드 — 이 환경에선 쓰지 않는다
    def get_attr(self, attr_name, indices=None):
        return [getattr(self, attr_name, None)] * len(self._get_indices(indices))

    def set_attr(self, attr_name, value, indices=None):
        setattr(self, attr_name, value)

    def env_method(self, method_name, *args, indices=None, **kwargs):
        return [None] * len(self._get_indices(indices))

    def env_is_wrapped(self, wrapper_class, indices=None):
        return [False] * len(self._get_indices(indices))

    def seed(self, seed=None):
        if seed is not None:
            self.base_seed = int(seed)
        return [self.base_seed + i for i in range(self.num_envs)]
