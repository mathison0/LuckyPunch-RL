# rl/ — RL 에이전트 실험

설계와 결과는 [`docs/strategy/rl.md`](../docs/strategy/rl.md)에 있다.

## 설치 (Windows)

```bash
py -3.13 -m venv rl/.venv
rl/.venv/Scripts/python -m pip install -r rl/requirements.txt
```

Node 18 이상이 필요하다(검증은 v24). `node`가 PATH에 없으면 `NODE` 환경변수로 실행 파일 경로를 지정한다.

## 검증 (Phase 1)

```bash
node rl/tests/parity.mjs 3                        # arena 하네스와 점수·프레임 일치 (72조합)
node rl/tests/opponents.mjs                       # 평가 상대 10종 로드·재현성·속도
rl/.venv/Scripts/python rl/scripts/verify_env.py  # env_checker / 재현성 / steps/s / 랜덤 vs AI
```

## 파일

| 파일 | 역할 |
|---|---|
| `pika_env.mjs` | 엔진 래핑 코어 (`Game`: 결정 tick 단위 step, 관측 인코딩, 시드 고정 봇 로더) |
| `env_server.mjs` | stdin/stdout 줄 단위 JSON 서버. 한 프로세스에서 N게임을 배치로 진행 |
| `pikarl/env.py` | `PikaEnv`(Gymnasium, 1게임) / `PikaVecEnv`(SB3 VecEnv, N게임) |
| `tests/parity.mjs` | arena `playSet()`과의 동일성 검사 |
| `tests/opponents.mjs` | 평가 상대 10종(`EVAL_OPPONENTS`) 로드·재현성·속도 스모크 테스트 |
| `scripts/verify_env.py` | Phase 1 검증 스크립트 |
