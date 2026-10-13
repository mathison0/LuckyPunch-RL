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
node rl/tests/opponents.mjs                       # 평가 상대 9종 로드·재현성·속도
rl/.venv/Scripts/python rl/scripts/verify_env.py  # env_checker / 재현성 / steps/s / 랜덤 vs AI
```

## 학습 (Phase 2)

```bash
rl/.venv/Scripts/python rl/scripts/train.py --name shaping_off --total-steps 20000000 --eval-every 500000
rl/.venv/Scripts/python rl/scripts/train.py --name shaping_on --shaping --total-steps 20000000 --eval-every 500000
rl/.venv/Scripts/python rl/scripts/plot_curve.py   # → docs/strategy/img/rl_learning_curve.png
```

산출물은 `rl/runs/<name>/`에 저장된다(git 제외). 구성은 `learning_curve.csv`(주기 평가), `checkpoints/step_*.zip`,
`final.zip`, `sb3_log/progress.csv`, `config.json`이다.

## 파일

| 파일 | 역할 |
|---|---|
| `pika_env.mjs` | 엔진 래핑 코어 (`Game`: 결정 tick 단위 step, 관측 인코딩, 시드 고정 봇 로더) |
| `env_server.mjs` | stdin/stdout 줄 단위 JSON 서버. 한 프로세스에서 N게임을 배치로 진행 |
| `pikarl/env.py` | `PikaEnv`(Gymnasium, 1게임) / `PikaVecEnv`(SB3 VecEnv, N게임) |
| `tests/parity.mjs` | arena `playSet()`과의 동일성 검사 |
| `tests/opponents.mjs` | 평가 상대 9종(`EVAL_OPPONENTS`) 로드·재현성·속도 스모크 테스트 |
| `scripts/verify_env.py` | Phase 1 검증 스크립트 |
| `pikarl/evaluate.py` | 평가 러너 (프로토콜 명세 생성, 배치 플레이, 승률 집계) — 학습 중 평가와 Phase 3 공용 |
| `scripts/train.py` | PPO 학습 + 주기 평가·체크포인트 |
| `scripts/plot_curve.py` | 학습 곡선 그림 |
