// Runs inside the page after detector.js. Rewrites the DOM so the honest choice is
// as visible as the manipulative one. Returns a list of the fixes it applied.
(findings) => {
  const fixes = [];
  const byId = (id) => document.querySelector(`[data-cg-id="${id}"]`);
  const text = (el) => (el.innerText || el.value || el.textContent || "").replace(/\s+/g, " ").trim();
  const setLabel = (el, label) => {
    if (el.tagName === "INPUT") el.value = label;
    else el.textContent = label;
  };
  const badge = (el, msg) => {
    const b = document.createElement("span");
    b.className = "cg-badge";
    b.textContent = "⚠ CoercionGuard: " + msg;
    b.style.cssText = "display:inline-block;margin:4px 0;padding:2px 6px;background:#fff3cd;color:#7a4b00;border:1px solid #e0a800;border-radius:4px;font:600 12px/1.4 system-ui;";
    el.insertAdjacentElement("afterend", b);
  };

  for (const f of findings) {
    const el = byId(f.element_id);
    if (!el) continue;
    el.style.outline = "2px dashed #d93025";

    switch (f.type) {
      case "subscription_trap": {
        el.style.cssText += ";font-size:16px!important;color:#b00020!important;opacity:1!important;font-weight:700!important;";
        // Surface the hidden cost on the most prominent submit button: that's the one it hides behind.
        const form = el.closest("form");
        const cost = text(el);
        if (form) {
          const area = (b) => { const r = b.getBoundingClientRect(); return r.width * r.height; };
          const buttons = Array.from(form.querySelectorAll("button[type=submit], button:not([type]), input[type=submit]"));
          const main = buttons.sort((a, b) => area(b) - area(a))[0];
          if (main && !text(main).includes("⚠")) setLabel(main, `${text(main)} ⚠ ${cost}`);
        }
        fixes.push({ type: f.type, element_id: f.element_id, action: "Enlarged hidden recurring cost and copied it onto the CTA" });
        break;
      }
      case "preselection":
        if (el.checked) {
          el.checked = false;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        badge(el.closest("label") || el, "this was pre-ticked; unticked for you");
        fixes.push({ type: f.type, element_id: f.element_id, action: "Unticked pre-selected option" });
        break;
      case "trick_question":
        // Normalise to "not consenting": these labels are opt-out phrased, so checked = no marketing.
        badge(el.closest("label") || el, "confusing double negative; set to the no-marketing option");
        if (/uncheck|untick|deselect/i.test(f.label || "")) el.checked = true;
        else el.checked = false;
        fixes.push({ type: f.type, element_id: f.element_id, action: "Resolved double-negative consent to opt-out" });
        break;
      case "forced_action":
        el.required = false;
        el.checked = false;
        badge(el.closest("label") || el, "data-sharing consent is bundled with the download; declined");
        fixes.push({ type: f.type, element_id: f.element_id, action: "Unbundled forced consent" });
        break;
      case "false_urgency":
        el.textContent = "⏱ (urgency claim removed: no verifiable deadline)";
        el.style.cssText += ";color:#555!important;font-size:12px!important;animation:none!important;";
        fixes.push({ type: f.type, element_id: f.element_id, action: "Neutralised countdown/scarcity claim" });
        break;
      case "misleading_free": {
        const cost = f.hidden_cost || "";
        if (cost && !text(el).includes(cost)) {
          const note = document.createElement("span");
          note.textContent = ` — then ${cost}`;
          note.style.cssText = "color:#b00020;font-weight:800;";
          el.append(note);
        }
        fixes.push({ type: f.type, element_id: f.element_id, action: "Put the hidden recurring price on the free claim" });
        break;
      }
      case "social_proof":
        el.textContent = "(unverified popularity claim removed)";
        el.style.cssText += ";color:#555!important;font-size:12px!important;font-weight:500!important;";
        fixes.push({ type: f.type, element_id: f.element_id, action: "Removed unverified social-proof claim" });
        break;
      case "confirmshaming":
        setLabel(el, el.getAttribute("aria-label") || el.title || "No thanks");
        fixes.push({ type: f.type, element_id: f.element_id, action: "Replaced guilt-trip wording with a neutral label" });
        // falls through so the decline option is also made equally visible
      case "interface_interference": {
        const dominant = f.dominant_element_id ? byId(f.dominant_element_id) : null;
        el.style.cssText += ";display:inline-block!important;font-size:16px!important;padding:12px 20px!important;color:#fff!important;background:#1a73e8!important;border:0!important;border-radius:6px!important;opacity:1!important;text-decoration:none!important;";
        if (dominant) {
          const r = dominant.getBoundingClientRect();
          el.style.minWidth = r.width + "px";
        }
        if (f.type === "interface_interference") {
          fixes.push({ type: f.type, element_id: f.element_id, action: "Gave the alternative option equal visual weight" });
        }
        break;
      }
      case "drip_pricing": {
        el.style.cssText += ";font-weight:700!important;color:#b00020!important;";
        badge(el, "fee not included in headline price");
        const feeMatch = text(el).match(/[$€£₹]\s?\d[\d,.]*/);
        if (feeMatch) {
          for (const n of document.querySelectorAll("body *")) {
            if (n.children.length) continue;
            const t = text(n);
            if (t.length > 16 || !/^[$€£₹]/.test(t) || t.includes(feeMatch[0])) continue;
            if (parseFloat(getComputedStyle(n).fontSize) < 24) continue;
            n.append(document.createTextNode(" + " + feeMatch[0]));
          }
        }
        fixes.push({ type: f.type, element_id: f.element_id, action: "Highlighted the fee and added it to the headline price" });
        break;
      }
      case "disguised_ad":
        setLabel(el, "[AD] " + text(el));
        el.style.opacity = "0.5";
        fixes.push({ type: f.type, element_id: f.element_id, action: "Labelled disguised ad" });
        break;
      case "nagging":
        el.remove();
        fixes.push({ type: f.type, element_id: f.element_id, action: "Removed nagging overlay" });
        break;
    }
  }

  // Stop countdown timers only when one was actually a fake deadline.
  // Timer ids in a fresh page are small; cap the walk so a huge id can't stall the scan.
  if (findings.some((f) => f.type === "false_urgency")) {
    const newest = setTimeout(() => {}, 0);
    clearTimeout(newest);
    const cap = Math.min(newest, 4000);
    for (let i = 0; i <= cap; i++) clearInterval(i);
  }

  if (fixes.length && document.body && !document.querySelector(".cg-banner")) {
    const bar = document.createElement("div");
    bar.className = "cg-banner";
    bar.setAttribute("role", "status");
    const noun = fixes.length === 1 ? "element" : "elements";
    bar.textContent = `CoercionGuard neutralized ${fixes.length} manipulative ${noun} on this page.`;
    bar.style.cssText = "position:relative;z-index:5;margin:0;padding:10px 14px;background:#1f4ea8;color:#fff;font:600 14px/1.4 system-ui;";
    document.body.prepend(bar);
  }

  return fixes;
}
