# LoL 솔로랭크 분석 대시보드

친구 그룹의 솔로랭크 전적을 Riot Match-V5 / Timeline-V5 데이터로 분석한 정적 사이트입니다.

- 데이터: 솔로랭크(queue 420)만, 이번 시즌
- 승률은 최근 경기에 가중(최근 30판 3배 / 31~100판 2배)
- 표본이 적은 항목은 경험적 베이즈 축소 + Wilson 95% 신뢰구간으로 보정

빌드: `python -m scripts.build_group_site` (lol-coach-agents 저장소)
