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

2차 실험(상대 풀 7종, v16·PikaPlanner_v4 홀드아웃):

```bash
rl/.venv/Scripts/python rl/scripts/train.py --name pool_lag1 --shaping --opponents pool7 --lags 1 --shards 4 ^
    --total-steps 20000000 --eval-every 1000000 --eval-seeds 6 ^
    --eval-opponents ai,LuckyPunch_v14.js,LuckyPunch_v16.js,PikaPlanner_v4.js
rl/.venv/Scripts/python rl/scripts/train.py --name pool_lagrand --shaping --opponents pool7 --lags 1,2,3 --shards 4 ^
    --total-steps 20000000 --eval-every 1000000 --eval-seeds 6 ^
    --eval-opponents ai,LuckyPunch_v14.js,LuckyPunch_v16.js,PikaPlanner_v4.js
rl/.venv/Scripts/python rl/scripts/plot_curve.py pool_lag1 pool_lagrand --per-opponent --out docs/strategy/img/rl_pool_curve.png
rl/.venv/Scripts/python rl/scripts/evaluate_final.py --tag pool --lags 1,2,3 ^
    pool_lag1=rl/runs/pool_lag1/final.zip pool_lagrand=rl/runs/pool_lagrand/final.zip
```

확장 평가(나머지 봇 16종)는 `evaluate_final.py --tag extended --opponents <쉼표 목록>`으로 돌린다. 목록은 `rl/results/eval_extended.md`에 있다.

산출물은 `rl/runs/<name>/`에 저장된다(git 제외). 구성은 `learning_curve.csv`(주기 평가), `checkpoints/step_*.zip`,
`final.zip`, `sb3_log/progress.csv`, `config.json`이다.

## 평가 (Phase 3)

```bash
rl/.venv/Scripts/python rl/scripts/evaluate_final.py --tag final --lags 1 ^
    ppo_off=rl/runs/shaping_off/final.zip ppo_on=rl/runs/shaping_on/final.zip rule:LuckyPunch_v16.js random
```

평가 상대는 `rl/tests/opponents.mjs`의 `EVAL_OPPONENTS` 9종이다. 상대마다 지터 {0,8} × 시드 24 × 양 진영 = 96세트를 둔다.
`rule:<봇>`은 룰 봇을 에이전트 슬롯에 넣어 같은 명세로 평가하는 기준선이다.
결과는 `rl/results/eval_<tag>.csv`(게임별 원자료)와 `eval_<tag>.md`(요약표)로 저장된다.

## 분석 (rl.md 5절)

```bash
rl/.venv/Scripts/python rl/scripts/diagnose.py --tag lag1 ^
    ppo_off=rl/runs/shaping_off/final.zip ppo_on=rl/runs/shaping_on/final.zip rule:LuckyPunch_v16.js
rl/.venv/Scripts/python rl/scripts/generalization_curve.py   # 체크포인트별 비학습 상대 승률
```

`diagnose.py`는 랠리 종료 유형(못 받음·자기 실책·서브 미스·5회 접촉)과 서브/리시브 승률을 집계한다.
결과는 `rl/results/diagnose_<tag>.{csv,md}`로 저장된다. 환경 쪽 랠리 로그는 명세에 `"log": true`를 넣을 때만 기록된다.

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
| `scripts/evaluate_final.py` | Phase 3 평가표 (PPO·룰 봇·랜덤을 같은 명세로) |
| `scripts/eval_rulebot.mjs` | 룰 봇 기준선 평가 (evaluate_final.py가 호출) |
| `scripts/diagnose.py` | 랠리 종료 유형 진단 |
| `scripts/generalization_curve.py` | 체크포인트별 일반화 곡선 |
| `results/` | 평가·진단 결과 (커밋됨) |
