/**
 * 피드백 접수 — Cloudflare Pages Functions
 *
 * POST /api/feedback  {who, kind, body}
 *
 * 친구들은 대부분 GitHub 계정이 없다. 그래서 사이트에서 바로 쓰고 보내면
 * 디스코드(또는 슬랙) 웹훅으로 흘려보낸다.
 *
 * 필요한 환경변수 (Cloudflare Pages → Settings → Environment variables):
 *   FEEDBACK_WEBHOOK = 디스코드 채널 웹훅 URL (또는 슬랙 Incoming Webhook)
 * 안 걸려 있으면 503 을 돌려주고, 화면은 GitHub Issues 로 안내한다.
 *
 * 원칙
 *  · 웹훅 URL 은 브라우저로 절대 내보내지 않는다.
 *  · 남의 서버로 아무 내용이나 중계하는 통로가 되지 않도록 길이·빈도를 막는다.
 *  · @everyone 같은 멘션은 디스코드 쪽에서 통째로 비활성화한다.
 */

const MAX_BODY = 2000;
const MAX_WHO = 40;
const THROTTLE_SEC = 20;
const KINDS = ["버그", "숫자가 이상함", "이런 걸 보고 싶다", "기타"];

function json(data, status = 200, origin = null) {
  const h = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (origin) h["access-control-allow-origin"] = origin;
  return new Response(JSON.stringify(data), { status, headers: h });
}

/** 눈에 안 보이는 문자·과도한 줄바꿈 정리. 내용 자체는 손대지 않는다. */
function clean(s, max) {
  return String(s == null ? "" : s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, max);
}

export async function onRequestPost({ request, env }) {
  const self = new URL(request.url).origin;
  const hook = env.FEEDBACK_WEBHOOK;
  if (!hook) {
    return json({ error: "아직 접수 창구가 연결되지 않았습니다.", fallback: "github" }, 503, self);
  }

  let data;
  try {
    data = await request.json();
  } catch (e) {
    return json({ error: "요청을 읽지 못했습니다." }, 400, self);
  }

  const body = clean(data.body, MAX_BODY);
  const who = clean(data.who, MAX_WHO) || "익명";
  const kind = KINDS.includes(data.kind) ? data.kind : "기타";
  const page = clean(data.page, 120);
  if (body.length < 5) {
    return json({ error: "내용을 다섯 글자 이상 적어주세요." }, 400, self);
  }

  // 같은 사람이 연타로 채널을 도배하지 못하게. 엣지 캐시를 짧은 자물쇠로 쓴다.
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const cache = caches.default;
  const lock = new Request(`${self}/api/feedback-lock?ip=${encodeURIComponent(ip)}`, {
    method: "GET",
  });
  if (await cache.match(lock)) {
    return json({ error: `조금만 천천히요. ${THROTTLE_SEC}초 뒤에 다시 보내주세요.` }, 429, self);
  }

  const isSlack = /hooks\.slack\.com/.test(hook);
  // body 는 코드펜스 안이라 안전한데 who 는 펜스 밖에 그대로 렌더된다.
  // 그대로 두면 보낸 사람 칸에 [클릭](http://악성) 같은 링크를 심을 수 있다.
  const safeWho = String(who).replace(/[\[\]()*_~`>|#\\]/g, "").slice(0, 40);
  const text =
    `**[${kind}]** ${safeWho}\n` +
    (page ? `\`${page}\`\n` : "") +
    "```\n" + body.replace(/```/g, "'''") + "\n```";
  const payload = isSlack
    ? { text: text.replace(/\*\*/g, "*") }
    : { content: text.slice(0, 1900), allowed_mentions: { parse: [] } };

  let r;
  try {
    r = await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json({ error: "전송에 실패했습니다. 잠시 후 다시 시도해주세요." }, 502, self);
  }
  if (!r.ok) {
    return json({ error: `전송에 실패했습니다 (${r.status}).`, fallback: "github" }, 502, self);
  }

  await cache.put(
    lock,
    new Response("1", { headers: { "cache-control": `max-age=${THROTTLE_SEC}` } })
  );
  return json({ ok: true }, 200, self);
}

export async function onRequestGet({ request, env }) {
  const self = new URL(request.url).origin;
  return json({ ready: !!env.FEEDBACK_WEBHOOK, kinds: KINDS }, 200, self);
}
