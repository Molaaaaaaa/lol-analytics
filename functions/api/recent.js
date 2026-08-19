/**
 * 방금 한 게임 즉시 분석 — Cloudflare Pages Functions
 *
 * GET /api/recent?name=내 이름은 정준토&tag=KR1
 *
 * Riot API 키는 Cloudflare 환경변수(RIOT_API_KEY)에만 두고 브라우저로 절대 내보내지 않는다.
 * 대시보드는 하루 한 번 배치로 갱신되므로, 이 엔드포인트는 "배치 이후에 한 게임"을 보기 위한 것.
 */

const REGIONAL = "https://asia.api.riotgames.com";

function json(data, status = 200, maxAge = 60) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
      "access-control-allow-origin": "*",
    },
  });
}

async function riot(path, key, params) {
  const url = new URL(REGIONAL + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { "X-Riot-Token": key } });
  if (!r.ok) {
    const body = await r.text();
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    err.body = body.slice(0, 200);
    throw err;
  }
  return r.json();
}

export async function onRequestGet({ request, env }) {
  const key = env.RIOT_API_KEY;
  if (!key) {
    return json({ error: "서버에 RIOT_API_KEY가 설정되지 않았습니다." }, 500, 0);
  }

  const u = new URL(request.url);
  const name = (u.searchParams.get("name") || "").trim();
  const tag = (u.searchParams.get("tag") || "").trim();
  if (!name || !tag) {
    return json({ error: "name 과 tag 가 필요합니다." }, 400, 0);
  }

  try {
    const acct = await riot(
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
      key
    );
    const ids = await riot(`/lol/match/v5/matches/by-puuid/${acct.puuid}/ids`, key, {
      queue: 420,
      start: 0,
      count: 5,
    });
    if (!ids.length) return json({ riotId: `${acct.gameName}#${acct.tagLine}`, games: [] });

    const games = [];
    for (const id of ids.slice(0, 3)) {
      const m = await riot(`/lol/match/v5/matches/${id}`, key);
      const info = m.info || {};
      const me = (info.participants || []).find((p) => p.puuid === acct.puuid);
      if (!me) continue;
      const team = (info.participants || []).filter((p) => p.teamId === me.teamId);
      const teamKills = team.reduce((s, p) => s + (p.kills || 0), 0) || 1;
      const teamDmg = team.reduce((s, p) => s + (p.totalDamageDealtToChampions || 0), 0) || 1;
      const opp = (info.participants || []).find(
        (p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition
      );
      const ejg = (info.participants || []).find(
        (p) => p.teamId !== me.teamId && p.teamPosition === "JUNGLE"
      );
      const mins = (info.gameDuration || 1) / 60;
      games.push({
        matchId: id,
        champion: me.championName,
        position: me.teamPosition,
        win: !!me.win,
        kda: `${me.kills}/${me.deaths}/${me.assists}`,
        cs: (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0),
        cspm: +(((me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0)) / mins).toFixed(1),
        killParticipation: +(((me.kills + me.assists) / teamKills) * 100).toFixed(1),
        damageShare: +(((me.totalDamageDealtToChampions || 0) / teamDmg) * 100).toFixed(1),
        visionScore: me.visionScore || 0,
        durationMin: Math.round(mins),
        playedAt: new Date(info.gameEndTimestamp || info.gameCreation || Date.now()).toISOString(),
        opponent: opp ? opp.championName : null,
        enemyJungler: ejg ? ejg.championName : null,
      });
    }
    return json({ riotId: `${acct.gameName}#${acct.tagLine}`, games });
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      return json({ error: "API 키가 만료되었거나 유효하지 않습니다." }, 502, 0);
    }
    if (e.status === 429) {
      return json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." }, 429, 0);
    }
    if (e.status === 404) {
      return json({ error: "해당 소환사를 찾을 수 없습니다." }, 404, 0);
    }
    return json({ error: `조회 실패: ${e.message}` }, 502, 0);
  }
}
