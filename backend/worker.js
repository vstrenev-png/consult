/*
 * Знахарницата — платежен бекенд (Cloudflare Worker)
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
const MERCHANT_CODE = "M7JCYFHR"; // от GET /me → merchant_profile.merchant_code
const CURRENCY = "EUR";           // от GET /me → default_currency

// Цените се пазят ТУК (на сървъра), за да не могат да се подправят от браузъра.
const PRICES = {
  "Интро пакет": 2.5,
  "Стартов пакет": 20,
  "Курс на лечение": 150,
  "Двоен курс": 275,
};

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

    // Стъпка 2: тестово създаване на плащане (checkout) за 1.00 EUR.
    // Само СЪЗДАВА checkout със статус PENDING — НЕ таксува нищо (таксуване има
    // само след реално плащане). Целта е да видим как SumUp връща checkout-а.
    if (url.pathname === "/test-order") {
      if (!env.SUMUP_SECRET_KEY) {
        return json({ ok: false, error: "Липсва SUMUP_SECRET_KEY." }, cors, 500);
      }
      const ref = "TEST-" + Date.now();
      let r, data;
      try {
        r = await fetch(SUMUP_API + "/v0.1/checkouts", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + env.SUMUP_SECRET_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            checkout_reference: ref,
            amount: 1.0,
            currency: CURRENCY,
            merchant_code: MERCHANT_CODE,
            description: "Тестова поръчка (Знахарницата) " + ref,
          }),
        });
        data = await r.json();
      } catch (e) {
        return json({ ok: false, error: "Грешка при връзка със SumUp", detail: String(e) }, cors, 502);
      }
      return json({ ok: r.ok, status: r.status, reference: ref, checkout: data }, cors, r.ok ? 200 : r.status);
    }

    // Стъпка 3: истинско създаване на плащане за поръчка.
    // Тяло (JSON): { pack: "Курс на лечение", reference: "ZT-260724-1234" }
    // Цената се определя ТУК по пакета — браузърът не може да я подмени.
    if (url.pathname === "/order" && request.method === "POST") {
      if (!env.SUMUP_SECRET_KEY) return json({ ok: false, error: "Липсва SUMUP_SECRET_KEY." }, cors, 500);
      let body;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: "Невалиден JSON" }, cors, 400); }
      const amount = PRICES[body.pack];
      if (!amount) return json({ ok: false, error: "Непознат пакет: " + body.pack }, cors, 400);
      const ref = String(body.reference || "ZT-" + Date.now()).slice(0, 60);
      let r, data;
      try {
        r = await fetch(SUMUP_API + "/v0.1/checkouts", {
          method: "POST",
          headers: { Authorization: "Bearer " + env.SUMUP_SECRET_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            checkout_reference: ref,
            amount: amount,
            currency: CURRENCY,
            merchant_code: MERCHANT_CODE,
            description: body.pack + " — Знахарницата (" + ref + ")",
          }),
        });
        data = await r.json();
      } catch (e) {
        return json({ ok: false, error: "Грешка при връзка със SumUp", detail: String(e) }, cors, 502);
      }
      if (!r.ok) return json({ ok: false, status: r.status, sumup: data }, cors, r.status);
      return json({ ok: true, id: data.id, reference: ref, amount: amount, status: data.status }, cors);
    }

    // Стъпка 3: проверка дали плащане е минало.
    // GET /confirm?id=<checkout-id>  → { paid: true/false, status: "PAID"|"PENDING"|... }
    if (url.pathname === "/confirm") {
      if (!env.SUMUP_SECRET_KEY) return json({ ok: false, error: "Липсва SUMUP_SECRET_KEY." }, cors, 500);
      const id = url.searchParams.get("id");
      if (!id) return json({ ok: false, error: "Липсва параметър id" }, cors, 400);
      let r, data;
      try {
        r = await fetch(SUMUP_API + "/v0.1/checkouts/" + encodeURIComponent(id), {
          headers: { Authorization: "Bearer " + env.SUMUP_SECRET_KEY },
        });
        data = await r.json();
      } catch (e) {
        return json({ ok: false, error: "Грешка при връзка със SumUp", detail: String(e) }, cors, 502);
      }
      if (!r.ok) return json({ ok: false, status: r.status, sumup: data }, cors, r.status);
      return json({ ok: true, id: id, status: data.status, paid: data.status === "PAID", reference: data.checkout_reference }, cors);
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
