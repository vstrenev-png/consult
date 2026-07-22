/*
 * Жук Терапия — платежен бекенд (Cloudflare Worker)
 * =================================================
 * Стъпка 1: проверка на връзката със SumUp.
 *
 * Тайният SumUp ключ НЕ стои в този файл. Той се добавя в Cloudflare като
 * шифрован Secret с име SUMUP_SECRET_KEY (Settings → Variables and Secrets).
 *
 * Маршрути:
 *   GET /health  → проверка, че Worker-ът е жив
 *   GET /me      → пита SumUp „кой съм аз" и връща профила (валидира ключа)
 *
 * Следващите стъпки (създаване на плащане, webhook, имейл до клиента) се
 * добавят тук, след като Стъпка 1 проработи на живо.
 */

const SUMUP_API = "https://api.sumup.com";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*", // по-късно ще заключим само за сайта
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // Проверка на живота на бекенда
    if (url.pathname === "/health") {
      return json({ ok: true, service: "zhuk-pay", step: 1 }, cors);
    }

    // Валидира ключа и връща профила на търговеца
    if (url.pathname === "/me") {
      if (!env.SUMUP_SECRET_KEY) {
        return json({ ok: false, error: "Липсва SUMUP_SECRET_KEY (добавете го като Secret в Cloudflare)." }, cors, 500);
      }
      let r, data;
      try {
        r = await fetch(SUMUP_API + "/v0.1/me", {
          headers: { Authorization: "Bearer " + env.SUMUP_SECRET_KEY },
        });
        data = await r.json();
      } catch (e) {
        return json({ ok: false, error: "Грешка при връзка със SumUp", detail: String(e) }, cors, 502);
      }
      if (!r.ok) {
        return json({ ok: false, status: r.status, sumup: data }, cors, r.status);
      }
      // Връщаме целия профил, за да видим точните полета (merchant_code, валута и т.н.)
      return json({ ok: true, profile: data }, cors);
    }

    return json({ ok: false, error: "not found", path: url.pathname }, cors, 404);
  },
};

function json(obj, headers, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}
