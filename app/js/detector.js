// Runs inside the page. Tags suspicious elements with data-cg-id and returns findings.
// Uses computed styles, so it sees what a human (or a screenshot-reading agent) would see.
() => {
  const findings = [];
  let nextId = document.querySelectorAll("[data-cg-id]").length;
  const seen = new Set();

  const tag = (el) => {
    if (!el.dataset.cgId) el.dataset.cgId = "cg" + nextId++;
    return el.dataset.cgId;
  };
  const text = (el) => (el.innerText || el.value || el.textContent || "").replace(/\s+/g, " ").trim();
  const add = (type, el, evidence, extra = {}) => {
    const id = tag(el);
    const key = type + ":" + id;
    if (seen.has(key)) return;
    seen.add(key);
    const r = el.getBoundingClientRect();
    findings.push({
      type, element_id: id, text: text(el).slice(0, 200), evidence,
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      ...extra,
    });
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
  };
  const labelFor = (input) => {
    if (input.labels && input.labels.length) return text(input.labels[0]);
    const p = input.closest("label") || input.parentElement;
    return p ? text(p) : "";
  };

  // --- colour helpers for contrast ---
  const parseRgb = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = parseRgb(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (el) => {
    const fg = parseRgb(getComputedStyle(el).color) || { r: 0, g: 0, b: 0 };
    const a = lum(fg), b = lum(bgOf(el));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const prominence = (el) => {
    const r = el.getBoundingClientRect();
    const bg = parseRgb(getComputedStyle(el).backgroundColor);
    const filled = bg && bg.a > 0.5 && lum(bg) < 0.7 ? 1.6 : 1;
    return r.width * r.height * filled;
  };

  const PRICE = /([$€£₹]\s?\d[\d,.]*|\d[\d,.]*\s?(usd|eur|inr|rs\.?))/i;
  const RECURRING = /(\/\s?(mo|month|yr|year|week)|per (month|year|week)|monthly|annually|auto[- ]?renew|recurring|after (the )?(free )?trial|billed)/i;
  const ADDON = /(insurance|protection|warranty|add[- ]?on|premium|priority|donat|tip|seat selection|upgrade|membership|plan)/i;
  const MARKETING = /(newsletter|marketing|partner|third[- ]part|offers|promotion|share (my|your) (data|information))/i;
  const SHAME = /(no thanks,? i|i (don'?t|do not) (want|like|care)|i('?d)? (prefer|rather|enjoy)|i'?m not interested in (saving|being)|i hate|miss(ing)? out|stay (poor|uninformed)|full price)/i;
  const URGENCY = /(only \d+ (left|remaining|seats?)|offer ends|ends in|expires in|hurry|limited time|\d+ (people|others) (are )?(viewing|looking)|last chance|selling fast|\b\d{1,2}:\d{2}(:\d{2})?\b)/i;
  const DOUBLE_NEG = /(uncheck|untick|deselect|do not|don'?t).{0,40}\b(not|no|don'?t|opt[- ]?out)\b/i;
  const FEE = /(service|convenience|booking|processing|handling|platform) fee/i;
  const SOCIAL = /\b(?:join\s+\d|\d[\d,.]*\+?\s+(?:people|customers|users|marketers|shoppers|buyers|others)|trusted by\b|bestseller)\b/i;

  const all = Array.from(document.querySelectorAll("body *")).filter(visible);
  let hiddenCost = "";

  // 1. Hidden recurring costs: small or low-contrast price/renewal text.
  for (const el of all) {
    if (el.children.length > 3) continue;
    const t = text(el);
    if (!t || t.length > 400) continue;
    if (!(PRICE.test(t) && RECURRING.test(t))) continue;
    const s = getComputedStyle(el);
    const size = parseFloat(s.fontSize);
    const c = contrast(el);
    if (size < 11.5 || c < 3 || parseFloat(s.opacity) < 0.6) {
      add("subscription_trap", el, `Recurring cost shown at ${size}px, contrast ${c.toFixed(1)}:1`, {
        font_px: size, contrast: +c.toFixed(2),
      });
      if (!hiddenCost) {
        const quoted = t.match(/[$€£₹]\s?\d[\d,.]*\s*(?:\/\s*|per\s+)?(?:mo|month|yr|year|week)?/i);
        hiddenCost = (quoted ? quoted[0] : t).slice(0, 80);
      }
    }
  }

  // 2. Pre-selected paid add-ons, trick questions, forced consent.
  for (const input of document.querySelectorAll("input[type=checkbox], input[type=radio]")) {
    const label = labelFor(input);
    const paidDefault = input.checked && !MARKETING.test(label) && (PRICE.test(label) || (input.type === "checkbox" && ADDON.test(label)));
    if (paidDefault) {
      add("preselection", input, `Checked by default: "${label.slice(0, 120)}"`, { label });
    }
    if (DOUBLE_NEG.test(label) && MARKETING.test(label)) {
      add("trick_question", input, `Double-negative consent wording (checked=${input.checked})`, { label });
    } else if (input.checked && MARKETING.test(label)) {
      add("preselection", input, `Marketing consent pre-ticked: "${label.slice(0, 120)}"`, { label });
    }
    if (input.required && MARKETING.test(label)) {
      add("forced_action", input, "Marketing/data-sharing consent is required to continue", { label });
    }
  }

  // 3. False urgency (countdowns, scarcity claims) and unverified crowd claims.
  for (const el of all) {
    if (el.children.length > 2) continue;
    const t = text(el);
    if (!t || t.length >= 160) continue;
    if (URGENCY.test(t)) add("false_urgency", el, "Urgency/scarcity claim");
    else if (SOCIAL.test(t)) add("social_proof", el, "Popularity claim with no source a reader can check");
  }

  // A headline that says "free" while a recurring charge is buried elsewhere.
  if (hiddenCost) {
    for (const el of document.querySelectorAll("h1, h2, h3")) {
      if (!visible(el)) continue;
      const t = text(el);
      if (t.length < 90 && /\bfree\b/i.test(t) && !PRICE.test(t)) {
        add("misleading_free", el, `Says "${t}" while the page discloses ${hiddenCost}`, { hidden_cost: hiddenCost });
      }
    }
  }

  // 4. Confirmshaming + asymmetric choices.
  const clickables = all.filter((el) => el.matches("button, a, input[type=submit], input[type=button], [role=button]"));
  for (const el of clickables) {
    const t = text(el);
    if (SHAME.test(t)) add("confirmshaming", el, "Decline option uses guilt-tripping language");
  }
  for (const form of document.querySelectorAll("form")) {
    const opts = clickables.filter((el) => form.contains(el) || el.getAttribute("form") === form.id);
    if (opts.length < 2) continue;
    const ranked = opts.map((el) => ({ el, p: prominence(el), c: contrast(el) })).sort((a, b) => b.p - a.p);
    const top = ranked[0], low = ranked[ranked.length - 1];
    if (top.p > low.p * 6 || (low.c < 3 && top.c >= 3)) {
      add("interface_interference", low.el,
        `Alternative is ${Math.round(top.p / Math.max(low.p, 1))}x less prominent than "${text(top.el).slice(0, 40)}"`,
        { dominant_element_id: tag(top.el) });
    }
  }

  // 5. Drip pricing.
  for (const el of all) {
    if (el.children.length > 2) continue;
    const t = text(el);
    if (t.length < 200 && FEE.test(t) && PRICE.test(t)) add("drip_pricing", el, "Extra fee disclosed separately from headline price");
  }

  // 6. Disguised ads.
  for (const el of clickables) {
    const box = el.closest("[class*=ad-], [class*=sponsor], [id*=sponsor], [data-ad], [class*=promo]");
    if (box && /(download|continue|next|start|get)/i.test(text(el)) && !/\b(ad|sponsored)\b/i.test(text(box))) {
      add("disguised_ad", el, "Ad styled as a primary action without an ad label");
    }
  }

  // 7. Nagging overlays.
  const vw = innerWidth, vh = innerHeight;
  for (const el of all) {
    const s = getComputedStyle(el);
    if (s.position !== "fixed" && s.position !== "sticky") continue;
    const r = el.getBoundingClientRect();
    if ((r.width * r.height) / (vw * vh) > 0.35 && parseInt(s.zIndex || "0") > 10) add("nagging", el, "Overlay covers most of the viewport");
  }

  const blocked = /just a moment|attention required|verify you are human|captcha|access denied|are you a robot/i.test(
    document.title + " " + (document.body ? document.body.innerText.slice(0, 2000) : "")
  ) || !!document.querySelector("iframe[src*=captcha], iframe[src*=challenge], #challenge-form");

  return { findings, blocked, title: document.title, viewport: { vw: innerWidth, vh: innerHeight } };
}
