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
        self.proc.stdin.write(json.dumps(msg, separators=(",", ":")) + "\n")
        self.proc.stdin.flush()
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
    """게임 n개를 Node 프로세스 1개에서 돌리는 배치 VecEnv. 끝난 게임은 다음 시드로 자동 리셋.

    시드: slot i의 k번째 에피소드 = seed + k*n + i. 진영은 (k+i) 짝홀로 번갈아 → 양 진영 균등.
    """

    def __init__(self, n: int, opponent: str | list[str] = "ai", lag: int = 1, jitter: int = 0,
                 shaping: bool = False, touch_bonus: float = DEFAULT_TOUCH_BONUS, seed: int = 0):
        self.client = NodeClient(n)
        obs_space = spaces.Box(-np.inf, np.inf, (self.client.obs_dim,), np.float32)
        super().__init__(n, obs_space, spaces.Discrete(N_ACTIONS))
        self.opponents = opponent if isinstance(opponent, list) else [opponent]
        self.lag, self.jitter, self.shaping, self.touch_bonus = lag, jitter, shaping, touch_bonus
        self.base_seed = seed
        self.episode_k = [0] * n
        self._actions = None

    def _reset_slot(self, i: int) -> np.ndarray:
        k = self.episode_k[i]
        self.episode_k[i] += 1
        r = self.client.call({
            "cmd": "reset", "i": i, "seed": self.base_seed + k * self.num_envs + i,
            "side": "LEFT" if (k + i) % 2 == 0 else "RIGHT",
            "opponent": self.opponents[(k * self.num_envs + i) % len(self.opponents)],
            "lag": self.lag, "jitter": self.jitter,
        })
        return np.asarray(r["obs"], np.float32)

    def reset(self):
        return np.stack([self._reset_slot(i) for i in range(self.num_envs)])

    def step_async(self, actions):
        self._actions = [int(a) for a in actions]

    def step_wait(self):
        r = self.client.call({"cmd": "step", "a": self._actions})
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
        self.client.close()

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
