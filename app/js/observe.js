// What the agent "sees": visible controls with the text a reader would notice.
() => {
  let nextId = document.querySelectorAll("[data-cg-id]").length;
  const tag = (el) => { if (!el.dataset.cgId) el.dataset.cgId = "cg" + nextId++; return el.dataset.cgId; };
  const text = (el) => (el.innerText || el.value || el.textContent || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
  };
  const overlay = Array.from(document.querySelectorAll("body *")).find((el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return visible(el) && s.position === "fixed" && r.width * r.height > innerWidth * innerHeight * 0.35;
  });

  const controls = [];
  for (const el of document.querySelectorAll("button, a[href], input[type=submit], input[type=button], [role=button]")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    controls.push({
      id: tag(el), kind: "button", label: text(el).slice(0, 160),
      area: Math.round(r.width * r.height), font_px: parseFloat(s.fontSize),
      is_submit: !!el.form && (el.type === "submit" || el.tagName === "BUTTON" && !el.getAttribute("type")),
      in_overlay: !!(overlay && overlay.contains(el)),
      // Site menus, headers and footers aren't where a page asks you to agree to something.
      in_chrome: !!el.closest("nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]"),
      // Plan or billing toggles are choices, not the action that commits to them.
      is_choice: !!(el.dataset.cgCtl || el.dataset.cgOpt) || /^(radio|tab|switch|option|menuitemradio)$/.test(el.getAttribute("role") || "") || el.hasAttribute("aria-pressed")
        || el.hasAttribute("aria-selected") || el.hasAttribute("aria-expanded") || el.tagName === "SUMMARY"
        || !!el.closest("[role=radiogroup], [role=tablist], fieldset, details"),
      button_like: el.tagName !== "A" || /\b(btn|button|cta)\b/i.test(el.className || "") || parseFloat(s.paddingTop) + parseFloat(s.paddingBottom) >= 12,
    });
  }
  for (const el of document.querySelectorAll("input[type=checkbox], input[type=radio]")) {
    if (!visible(el)) continue;
    const lab = el.labels && el.labels[0] ? text(el.labels[0]) : text(el.parentElement || el);
    controls.push({ id: tag(el), kind: el.type, label: lab.slice(0, 160), checked: el.checked, required: el.required, in_overlay: !!(overlay && overlay.contains(el)) });
  }
  for (const el of document.querySelectorAll("input[type=text], input[type=email], input[type=tel], input[type=number], textarea")) {
    if (!visible(el)) continue;
    const lab = el.labels && el.labels[0] ? text(el.labels[0]) : (el.getAttribute("aria-label") || el.name || el.placeholder || "text field");
    controls.push({
      id: tag(el), kind: "field", input_type: el.type || "text", label: lab.slice(0, 160),
      value: (el.value || "").slice(0, 120), required: el.required, in_overlay: !!(overlay && overlay.contains(el)),
    });
  }
  const receiptEl = document.getElementById("cg-receipt");
  return {
    url: location.href,
    title: document.title,
    has_overlay: !!overlay,
    controls,
    receipt: receiptEl ? JSON.parse(receiptEl.textContent) : null,
  };
}
