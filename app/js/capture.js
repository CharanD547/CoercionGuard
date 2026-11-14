// Runs inside a captured page. Reads only: returns visible text, choice controls with their
// default state, price labels and links to pricing/terms pages. Never clicks or submits.
() => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && parseFloat(s.opacity) > 0.05 && r.width > 0 && r.height > 0;
  };
  // Custom-styled inputs are often hidden; judge them by their label instead.
  const shown = (input) => visible(input) || (input.labels && [...input.labels].some(visible));
  const labelOf = (el) => {
    if (el.labels && el.labels.length) return clean([...el.labels].map((l) => l.innerText).join(" "));
    const aria = el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") || "").split(" ")
      .map((id) => document.getElementById(id)?.innerText || "").join(" ");
    if (clean(aria)) return clean(aria);
    const wrap = el.closest("label, li, tr, [role=radio], [role=checkbox]") || el.parentElement;
    return clean(wrap ? wrap.innerText : "");
  };
  const groupLabel = (el) => {
    const fs = el.closest("fieldset");
    const legend = fs && fs.querySelector("legend");
    if (legend) return clean(legend.innerText);
    const rg = el.closest("[role=radiogroup]");
    if (rg) return clean(rg.getAttribute("aria-label") || "");
    return "";
  };

  // Visible text as short lines, so excerpts can be checked against it later.
  const lines = [];
  const seen = new Set();
  for (const raw of (document.body ? document.body.innerText : "").split("\n")) {
    const t = clean(raw);
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    lines.push(t.slice(0, 500));
    if (lines.length >= 800) break;
  }

  const controls = [];
  // IDs are written onto the elements, so a second read of the same page (after an agent
  // has used it) reports the same IDs and the two states can be compared.
  window.__cgN = window.__cgN || 0;
  const idOf = (el) => el.dataset.cgCtl || (el.dataset.cgCtl = "c" + ++window.__cgN);
  // Sites often repeat a control (desktop and mobile copies); keep one of each.
  const sigs = new Set();
  const fresh = (sig) => !sigs.has(sig) && sigs.add(sig);
  const isOn = (el) => (el.matches("input") ? el.checked : el.getAttribute("aria-checked") === "true");
  const BILLING = (a, b) => (/month/i.test(a) && /(year|annual)/i.test(b)) || (/(year|annual)/i.test(a) && /month/i.test(b));

  // Two-way switches: "Monthly [toggle] Yearly". The toggle has no useful label of its own, so
  // the words on either side are the two options; on means the right-hand one.
  const sideText = (el, dir) => {
    for (let n = el, up = 0; n && up < 3; n = n.parentElement, up++) {
      const sib = dir < 0 ? n.previousElementSibling : n.nextElementSibling;
      const t = sib && clean(sib.innerText);
      if (t) return t.length <= 30 ? t : "";
    }
    return "";
  };
  for (const el of document.querySelectorAll("[role=switch], input[type=checkbox]")) {
    if (!shown(el)) continue;
    const left = el.dataset.cgLeft || sideText(el, -1), right = el.dataset.cgRight || sideText(el, 1);
    if (!left || !right || left === right) continue;
    const isSwitch = el.getAttribute("role") === "switch";
    if (!BILLING(left, right) && !(isSwitch && left.length <= 20 && right.length <= 20)) continue;
    if (!fresh("sw|" + left + "|" + right)) { el.dataset.cgSkip = "1"; continue; }
    Object.assign(el.dataset, { cgLeft: left, cgRight: right, cgSwitch: "1" });
    const id = idOf(el);
    controls.push({ id, kind: "radio", switch: true, label: groupLabel(el) || "Billing", default: isOn(el) ? `${id}o2` : `${id}o1`,
                    options: [{ id: `${id}o1`, label: left }, { id: `${id}o2`, label: right }] });
  }

  // Segmented buttons: [Monthly | Yearly] built from pressed/selected buttons or tabs.
  const segments = new Map();
  for (const el of document.querySelectorAll("button[aria-pressed], [role=tab], button[aria-selected]")) {
    const t = el.dataset.cgLabel || clean(el.innerText);  // first read's wording, before any tag was added
    if (!shown(el) || !t || t.length > 30) continue;
    el.dataset.cgLabel = t;
    if (!segments.has(el.parentElement)) segments.set(el.parentElement, []);
    segments.get(el.parentElement).push(el);
  }
  const pressed = (el) => el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-selected") === "true";
  for (const [, els] of segments) {
    const labels = els.map((el) => el.dataset.cgLabel.slice(0, 60));
    if (els.length < 2 || els.length > 4) continue;
    if (!labels.some((l) => /month/i.test(l)) || !labels.some((l) => /(year|annual)/i.test(l))) continue;
    if (!fresh("seg|" + labels.join("|"))) continue;
    const id = idOf(els[0]);
    els.forEach((el, i) => (el.dataset.cgOpt = `${id}o${i + 1}`));
    const def = els.findIndex(pressed);
    controls.push({ id, kind: "radio", segmented: true, label: "Billing", default: def >= 0 ? `${id}o${def + 1}` : null,
                    options: labels.map((l, i) => ({ id: `${id}o${i + 1}`, label: l })) });
  }

  // Class-marked choices: <div class="period selected">Yearly</div><div class="period">Monthly</div>.
  const PERIOD = /^(pay |billed |bill )?(monthly|yearly|annual(ly)?|month|year)\b/i;
  const ACTIVE = /(^|\s)(\S*[-_])?(selected|active|checked|current|is-on)([-_]\S*)?(\s|$)/i;
  const classGroups = new Map();
  for (const el of document.querySelectorAll("body *")) {
    // Skip controls found above, but not this group's own elements on a later read.
    if (el.children.length > 3 || ((el.dataset.cgOpt || el.dataset.cgCtl) && !el.dataset.cgCls) || !shown(el)) continue;
    const t = el.dataset.cgLabel || clean(el.innerText);
    if (!t || t.length > 30 || !PERIOD.test(t)) continue;
    el.dataset.cgLabel = t;
    if (!classGroups.has(el.parentElement)) classGroups.set(el.parentElement, []);
    classGroups.get(el.parentElement).push(el);
  }
  for (const [, els] of classGroups) {
    const labels = els.map((el) => el.dataset.cgLabel.slice(0, 60));
    const def = els.findIndex((el) => ACTIVE.test(el.getAttribute("class") || ""));
    if (els.length < 2 || els.length > 4 || def < 0) continue;
    if (!labels.some((l) => /month/i.test(l)) || !labels.some((l) => /(year|annual)/i.test(l))) continue;
    if (!fresh("cls|" + labels.join("|"))) continue;
    const id = idOf(els[0]);
    els.forEach((el, i) => Object.assign(el.dataset, { cgOpt: `${id}o${i + 1}`, cgCls: "1" }));
    controls.push({ id, kind: "radio", label: "Billing", default: `${id}o${def + 1}`,
                    options: labels.map((l, i) => ({ id: `${id}o${i + 1}`, label: l })) });
  }

  // One button holding both periods, whose label says which is on ("…: Annual selected").
  for (const el of document.querySelectorAll("button, [role=button]")) {
    if (!shown(el) || el.dataset.cgOpt || el.dataset.cgSwitch) continue;
    let pair = el.dataset.cgLeft ? [el.dataset.cgLeft, el.dataset.cgRight] : null;
    if (!pair) {
      const words = [...new Set([...el.querySelectorAll("span, div")].map((n) => clean(n.innerText))
        .filter((t) => t && t.length <= 20 && /^(monthly|yearly|annual(ly)?)$/i.test(t)))];
      if (words.length !== 2 || !BILLING(words[0], words[1])) continue;
      pair = words;
    }
    const said = (el.getAttribute("aria-label") || "").match(/(\w+)\s+selected/i);
    let def = said ? pair.findIndex((w) => w.toLowerCase().startsWith(said[1].toLowerCase().slice(0, 4))) : -1;
    if (def < 0 && el.hasAttribute("aria-pressed")) def = el.getAttribute("aria-pressed") === "true" ? 1 : 0;
    if (def < 0 || !fresh("tg|" + pair.join("|"))) continue;
    Object.assign(el.dataset, { cgLeft: pair[0], cgRight: pair[1], cgToggle: "1" });
    const id = idOf(el);
    controls.push({ id, kind: "radio", toggle: true, label: "Billing", default: `${id}o${def + 1}`,
                    options: [{ id: `${id}o1`, label: pair[0] }, { id: `${id}o2`, label: pair[1] }] });
  }

  for (const el of document.querySelectorAll("input[type=checkbox], [role=checkbox]")) {
    if (!shown(el) || el.dataset.cgSwitch || el.dataset.cgSkip) continue;
    const label = el.dataset.cgLabel || labelOf(el);
    if (!label || !fresh("cb|" + label)) continue;
    el.dataset.cgLabel = label;  // later reads keep the original wording even if the page relabels it
    controls.push({ id: idOf(el), kind: "checkbox", label: label.slice(0, 240), default: isOn(el), required: !!el.required });
  }

  const groups = new Map();
  for (const el of document.querySelectorAll("input[type=radio], [role=radio]")) {
    if (!shown(el)) continue;
    const key = el.matches("input") ? "name:" + (el.name || idOf(el)) : "rg:" + (el.closest("[role=radiogroup]")?.getAttribute("aria-label") || "group");
    if (!groups.has(key)) groups.set(key, { label: groupLabel(el), inputs: [] });
    groups.get(key).inputs.push(el);
  }
  for (const [, g] of groups) {
    const labels = g.inputs.map((el) => (el.dataset.cgLabel = el.dataset.cgLabel || labelOf(el).slice(0, 240)));
    if (g.inputs.length < 2 || !fresh("rg|" + g.label + "|" + labels.join("|"))) continue;
    const id = idOf(g.inputs[0]);
    g.inputs.forEach((el, i) => (el.dataset.cgOpt = `${id}o${i + 1}`));
    const options = g.inputs.map((el, i) => ({ id: `${id}o${i + 1}`, label: labels[i] }));
    const def = g.inputs.findIndex(isOn);
    controls.push({ id, kind: "radio", label: g.label || "Choose one", options, default: def >= 0 ? options[def].id : null });
  }

  for (const el of document.querySelectorAll("select")) {
    if (!shown(el) || el.options.length < 2 || !fresh("sel|" + labelOf(el) + "|" + [...el.options].map((o) => o.text).join("|"))) continue;
    const id = idOf(el);
    const options = [...el.options].map((o, i) => ({ id: `${id}o${i + 1}`, label: clean(o.text).slice(0, 240) }));
    controls.push({ id, kind: "select", label: labelOf(el).slice(0, 240) || "Choose one", options, default: options[el.selectedIndex]?.id ?? null });
  }

  // Short visible texts that carry a price, e.g. "Total $49" or "$10/month".
  const PRICE = /([$€£₹¥]\s?\d|\d[\d,.]*\s?(USD|EUR|GBP|INR|CAD|AUD)\b)/i;
  const prices = [];
  const priceSeen = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (el.children.length > 3 || !visible(el)) continue;
    const t = clean(el.innerText);
    if (!t || t.length > 140 || !PRICE.test(t) || priceSeen.has(t)) continue;
    priceSeen.add(t);
    prices.push(t);
    if (prices.length >= 120) break;
  }

  const LINKISH = /(pric|plan|terms|conditions|cancel|subscription|billing|refund|renew|legal)/i;
  const links = [];
  const linkSeen = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href;
    if (!/^https?:/.test(href) || linkSeen.has(href)) continue;
    const text = clean(a.innerText || a.getAttribute("aria-label") || "");
    if (!LINKISH.test(text + " " + href)) continue;
    linkSeen.add(href);
    links.push({ text: text.slice(0, 120), href });
    if (links.length >= 20) break;
  }

  const bodyText = (document.title + " " + (document.body ? document.body.innerText.slice(0, 3000) : "")).toLowerCase();
  const passwordField = [...document.querySelectorAll("input[type=password]")].some(visible);
  return {
    title: clean(document.title).slice(0, 200),
    url: location.href,
    lines,
    controls,
    prices,
    links,
    signals: {
      login: passwordField || /\b(sign in|log in) to (continue|view|see)\b/.test(bodyText),
      blocked: /just a moment|attention required|verify you are human|are you a robot|access denied|captcha/.test(bodyText)
        || !!document.querySelector("iframe[src*=captcha], iframe[src*=challenge], #challenge-form"),
      submit_only: /\b(terms|price|pricing) (will be )?(shown|available|revealed) (after|once) (you )?(submit|sign up|checkout)/.test(bodyText),
    },
  };
}
