"""Maps each detected dark-pattern type to the rules it falls under in India, the EU and the US."""

PATTERNS: dict[str, dict] = {
    "subscription_trap": {
        "label": "Subscription trap / hidden recurring cost",
        "severity": 5,
        "india_ccpa": "Subscription Trap; SaaS Billing",
        "eu": "UCPD Annex I (misleading 'free'); DSA Art. 25",
        "us": "CA ROSCA / Auto-Renewal Law; FTC Negative Option Rule",
    },
    "preselection": {
        "label": "Pre-selected paid add-on",
        "severity": 4,
        "india_ccpa": "Basket Sneaking",
        "eu": "Consumer Rights Directive Art. 22 (no pre-ticked boxes)",
        "us": "FTC Act §5 (unfair practices)",
    },
    "false_urgency": {
        "label": "False urgency / fake countdown",
        "severity": 3,
        "india_ccpa": "False Urgency",
        "eu": "UCPD Annex I #7",
        "us": "FTC Act §5 (deceptive practices)",
    },
    "confirmshaming": {
        "label": "Confirmshaming",
        "severity": 2,
        "india_ccpa": "Confirm Shaming",
        "eu": "DSA Art. 25",
        "us": "CCPA Regs §7004 (symmetry in choice)",
    },
    "interface_interference": {
        "label": "Asymmetric choice / interface interference",
        "severity": 3,
        "india_ccpa": "Interface Interference",
        "eu": "DSA Art. 25",
        "us": "CCPA Regs §7004 (symmetry in choice)",
    },
    "trick_question": {
        "label": "Trick question / double negative",
        "severity": 4,
        "india_ccpa": "Trick Question",
        "eu": "GDPR Art. 7 (clear consent)",
        "us": "CCPA Regs §7004 (no confusing language)",
    },
    "forced_action": {
        "label": "Forced consent / forced action",
        "severity": 4,
        "india_ccpa": "Forced Action",
        "eu": "GDPR Art. 7(4) (consent not bundled)",
        "us": "CCPA Regs §7004",
    },
    "drip_pricing": {
        "label": "Drip pricing / hidden fees",
        "severity": 3,
        "india_ccpa": "Drip Pricing",
        "eu": "Consumer Rights Directive Art. 6(1)(e)",
        "us": "FTC Rule on Unfair or Deceptive Fees",
    },
    "disguised_ad": {
        "label": "Disguised advertisement",
        "severity": 2,
        "india_ccpa": "Disguised Advertisement",
        "eu": "UCPD Annex I #11; DSA Art. 26",
        "us": "FTC Endorsement Guides",
    },
    "nagging": {
        "label": "Nagging overlay",
        "severity": 1,
        "india_ccpa": "Nagging",
        "eu": "DSA Art. 25(3)(b)",
        "us": "-",
    },
}


def enrich(finding: dict) -> dict:
    meta = PATTERNS.get(finding["type"], {})
    return {
        **finding,
        "pattern_label": meta.get("label", finding["type"]),
        "severity": meta.get("severity", 1),
        "regulations": {
            "india_ccpa_2023": meta.get("india_ccpa"),
            "eu": meta.get("eu"),
            "us": meta.get("us"),
        },
    }


def risk_score(findings: list[dict]) -> int:
    """0-100: sum of severities per distinct element, saturating."""
    total = sum(PATTERNS.get(f["type"], {}).get("severity", 1) for f in findings)
    return min(100, total * 6)
