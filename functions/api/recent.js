/**
 * 최근 경기 즉시 조회 — Cloudflare Pages Functions
 *
 * GET /api/recent?name=내 이름은 정준토&tag=KR1
 *
 * 원칙
 *  · Riot API 키는 환경변수(RIOT_API_KEY)에만 두고 브라우저로 절대 내보내지 않는다.
 *  · 로스터에 없는 소환사는 조회하지 않는다 — 공개 프록시가 되면 남이 이 키의
 *    쿼터를 태우고, 그러면 정작 친구들에게는 "요청이 너무 많습니다"만 보인다.
 *  · **허용목록은 '누구를' 만 막는다. '얼마나 자주' 는 아래 세 겹으로 막는다.**
 *
 * 왜 세 겹인가
 * ------------
 * 예전에는 60초 캐시 하나뿐이었다. 그 캐시는 **같은 이름** 재조회만 흡수하므로,
 * 허용목록 19명을 돌려가며 부르면 캐시가 한 번도 안 맞는다. 콜드 미스 하나가
 * 상류 호출 5회(account 1 + 매치목록 1 + 매치 3)를 만들었으니, 분당 19명 x 5 =
 * 95회까지 개인 dev 키 쿼터를 태울 수 있었다. 브라우저 하나로 충분했다.
 *
 *  1) 증폭 줄이기 — 매치 본문은 **불변**이라 오래 캐시하고, riot id -> puuid 도
 *     거의 안 바뀌니 하루 캐시한다. 정상 사용에서 상류 호출이 5회 -> 0~1회가 된다.
 *  2) IP 단위 제한 — 한 IP 가 창당 정해진 횟수만.
 *  3) 전역 상류 예산 — 모든 IP 를 합쳐도 분당 상한을 못 넘는다. 이게 쿼터를
 *     지키는 마지막 방어선이다(분산 IP 공격은 2)로는 못 막는다).
 *
 * 엣지 캐시는 데이터센터(colo)별로 갈리므로 2)·3)은 완벽한 전역 카운터가 아니다.
 * 그래도 한 곳에서 무한정 두드리는 것은 막고, 무엇보다 1)이 정상 사용의 상류
 * 호출을 거의 0 으로 만들어 예산 자체를 아낀다. 완전한 전역 제한이 필요해지면
 * Cloudflare Rate Limiting Rules 나 KV/Durable Object 로 올려야 한다.
 */

import ALLOW from "./_allow.json";

const REGIONAL = "https://asia.api.riotgames.com";

const CACHE_SEC = 60;             // 응답(매치 목록) — 새 판을 하면 바뀐다
const ACCT_SEC = 86400;           // riot id -> puuid : 개명해도 puuid 는 그대로다
const MATCH_SEC = 2592000;        // 매치 본문은 불변 — 30일
const IP_LIMIT = 12;              // IP 당 허용 요청 수
const IP_WINDOW = 60;             // 그 창의 길이(초)
const UPSTREAM_BUDGET = 40;       // 분당 상류(라이엇) 호출 상한 — 전역

function json(data, status = 200, maxAge = CACHE_SEC, origin = null, extra = null) {
  const h = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": `public, max-age=${maxAge}`,
  };
  if (origin) h["access-control-allow-origin"] = origin;
  if (extra) Object.assign(h, extra);
  return new Response(JSON.stringify(data), { status, headers: h });
}

/**
 * 엣지 캐시를 카운터로 쓴다. 경합이 있으면 적게 세지만(막는 쪽이 느슨해짐)
 * 스로틀이지 정합성이 필요한 값이 아니라서 괜찮다.
 */
async function bump(cache, origin, name, limit, ttl) {
  const slot = Math.floor(Date.now() / (ttl * 1000));
  const key = new Request(`${origin}/__c/${encodeURIComponent(name)}/${slot}`);
  let n = 0;
  const hit = await cache.match(key);
  if (hit) n = parseInt(await hit.text(), 10) || 0;
  if (n >= limit) return false;
  await cache.put(
    key,
    new Response(String(n + 1), { headers: { "cache-control": `max-age=${ttl}` } })
  );
  return true;
}

/** 라이엇 호출 하나. 결과를 엣지 캐시에 담아 같은 것을 두 번 안 부른다. */
async function riot(path, key, params, cache, origin, ttl) {
  const url = new URL(REGIONAL + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);

  const ck = new Request(`${origin}/__riot${url.pathname}${url.search}`);
  if (ttl) {
    const hit = await cache.match(ck);
    if (hit) return hit.json();
  }

  // 전역 예산은 **실제로 라이엇을 부르기 직전에만** 깎는다. 캐시로 답한 요청은
  // 예산을 안 쓴다 — 그래야 정상 사용이 공격자 때문에 막히지 않는다.
  if (!(await bump(cache, origin, "upstream", UPSTREAM_BUDGET, 60))) {
    const e = new Error("upstream budget");
    e.budget = true;
    throw e;
  }

  const r = await fetch(url, { headers: { "X-Riot-Token": key } });
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  if (ttl) {
    await cache.put(
      ck,
      new Response(JSON.stringify(data), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${ttl}`,
        },
      })
    );
  }
  return data;
}

export async function onRequestGet({ request, env }) {
  const self = new URL(request.url).origin;
  const key = env.RIOT_API_KEY;
  if (!key) return json({ error: "서버에 RIOT_API_KEY가 설정되지 않았습니다." }, 500, 0, self);

  const u = new URL(request.url);
  const name = (u.searchParams.get("name") || "").trim();
  const tag = (u.searchParams.get("tag") || "").trim();
  if (!name || !tag) return json({ error: "name 과 tag 가 필요합니다." }, 400, 0, self);

  // 로스터 허용목록 검사 — '누구를' 을 막는다
  const want = `${name}#${tag}`.toLowerCase();
  if (!Array.isArray(ALLOW) || !ALLOW.includes(want)) {
    return json({ error: "이 사이트에 등록된 소환사만 조회할 수 있습니다." }, 403, 0, self);
  }

  const cache = caches.default;

  // 응답 캐시가 맞으면 상류도 카운터도 건드리지 않는다
  const ckey = new Request(`${self}/api/recent?k=${encodeURIComponent(want)}`);
  const hit = await cache.match(ckey);
  if (hit) return hit;

  // IP 단위 제한 — '얼마나 자주' 를 막는다
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!(await bump(cache, self, `ip:${ip}`, IP_LIMIT, IP_WINDOW))) {
    return json(
      { error: `요청이 너무 잦습니다. ${IP_WINDOW}초 뒤에 다시 시도하세요.` },
      429,
      0,
      self,
      { "retry-after": String(IP_WINDOW) }
    );
  }

  try {
    const acct = await riot(
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
      key,
      null,
      cache,
      self,
      ACCT_SEC
    );
    const ids = await riot(
      `/lol/match/v5/matches/by-puuid/${acct.puuid}/ids`,
      key,
      { queue: 420, start: 0, count: 3 },
      cache,
      self,
      CACHE_SEC
    );

    const games = [];
    for (const id of ids.slice(0, 3)) {
      // 매치 본문은 불변이라 오래 캐시한다 — 증폭을 줄이는 가장 큰 한 방이다.
      const m = await riot(`/lol/match/v5/matches/${id}`, key, null, cache, self, MATCH_SEC);
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
    // 예산을 다 쓴 것은 '지금 붐빈다' 이지 장애가 아니다 — 사용자에게 그렇게 말한다.
    if (e.budget) {
      return json(
        { error: "지금 조회 요청이 몰려 있습니다. 잠시 후 다시 시도하세요." },
        429,
        0,
        self,
        { "retry-after": "60" }
      );
    }
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
