/**
 * 최근 경기 즉시 조회 — Cloudflare Pages Functions
 *
 * GET /api/recent?name=내 이름은 정준토&tag=KR1
 *
 * 원칙
 *  · Riot API 키는 환경변수(RIOT_API_KEY)에만 두고 브라우저로 절대 내보내지 않는다.
 *  · 로스터에 없는 소환사는 조회하지 않는다 — 공개 프록시가 되면 남이 이 키의
 *    쿼터를 태우고, 그러면 정작 친구들에게는 "요청이 너무 많습니다"만 보인다.
 *  · 같은 소환사 재조회는 60초 캐시로 흡수한다.
 */

import ALLOW from "./_allow.json";

const REGIONAL = "https://asia.api.riotgames.com";
const CACHE_SEC = 60;

function json(data, status = 200, maxAge = CACHE_SEC, origin = null) {
  const h = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": `public, max-age=${maxAge}`,
  };
  if (origin) h["access-control-allow-origin"] = origin;
  return new Response(JSON.stringify(data), { status, headers: h });
}

async function riot(path, key, params) {
  const url = new URL(REGIONAL + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { "X-Riot-Token": key } });
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

export async function onRequestGet({ request, env }) {
  const self = new URL(request.url).origin;
  const key = env.RIOT_API_KEY;
  if (!key) return json({ error: "서버에 RIOT_API_KEY가 설정되지 않았습니다." }, 500, 0, self);

  const u = new URL(request.url);
  const name = (u.searchParams.get("name") || "").trim();
  const tag = (u.searchParams.get("tag") || "").trim();
  if (!name || !tag) return json({ error: "name 과 tag 가 필요합니다." }, 400, 0, self);

  // 로스터 허용목록 검사
  const want = `${name}#${tag}`.toLowerCase();
  if (!Array.isArray(ALLOW) || !ALLOW.includes(want)) {
    return json({ error: "이 사이트에 등록된 소환사만 조회할 수 있습니다." }, 403, 0, self);
  }

  // 엣지 캐시 (같은 사람 재조회 흡수)
  const cache = caches.default;
  const ckey = new Request(`${self}/api/recent?k=${encodeURIComponent(want)}`, request);
  const hit = await cache.match(ckey);
  if (hit) return hit;

  try {
    const acct = await riot(
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
      key
    );
    const ids = await riot(`/lol/match/v5/matches/by-puuid/${acct.puuid}/ids`, key, {
      queue: 420,
      start: 0,
      count: 3,
    });

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
      const cs = (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);
      games.push({
        matchId: id,
        champion: me.championName,
        position: me.teamPosition,
        win: !!me.win,
        kda: `${me.kills}/${me.deaths}/${me.assists}`,
        cs,
        cspm: +(cs / mins).toFixed(1),
        killParticipation: +(((me.kills + me.assists) / teamKills) * 100).toFixed(1),
        damageShare: +(((me.totalDamageDealtToChampions || 0) / teamDmg) * 100).toFixed(1),
        visionScore: me.visionScore || 0,
        durationMin: Math.round(mins),
        playedAt: new Date(info.gameEndTimestamp || info.gameCreation || Date.now()).toISOString(),
        opponent: opp ? opp.championName : null,
        enemyJungler: ejg ? ejg.championName : null,
      });
    }
    const res = json({ riotId: `${acct.gameName}#${acct.tagLine}`, games }, 200, CACHE_SEC, self);
    await cache.put(ckey, res.clone());
    return res;
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      return json({ error: "API 키가 만료되었거나 유효하지 않습니다. 관리자에게 알려주세요." }, 502, 0, self);
    }
    if (e.status === 429) {
      return json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." }, 429, 0, self);
    }
    if (e.status === 404) {
      return json({ error: "최근 솔로랭크 경기를 찾을 수 없습니다." }, 404, 0, self);
    }
    return json({ error: "조회에 실패했습니다." }, 502, 0, self);
  }
}
