# CoercionGuard improvements

This records the HackGlobal release, including the UI redesign. The original frontend has since been restored. The guard API, backend improvements, example client, and deployment documentation remain available. Use the [README](README.md) for the current walkthrough.

CoercionGuard now opens with a live terms review. Paste a public pricing, trial, checkout, or consent URL and say what you want to avoid. The app captures the page, compares its terms and selected options against your goal, and can turn a cited renewal clause into a calendar reminder.

## Live review and evidence

- **Review public pages or saved copies.** Open a live URL, upload a saved public HTML page, or use an archived copy when available. The **Try an example** button opens the fictional StreamFlix fixture as a labeled saved copy. Terms pages can be reviewed even when they have no interactive controls.
- **Try choices before you commit.** The private review shows captured defaults and lets you change supported options, reset them, and check again. Price changes are shown when the captured labels support the calculation. A budget check with an unknown or incomparable total requires review.
- **See where the answer came from.** Findings pair the conflict with a verified excerpt and source link. The page identifies whether the result came from Vultr Inference, the rules engine, or a rules fallback after an inference failure. Unsupported excerpts are held apart from verified evidence.
- **Compare with and without protection.** The consent lab still offers the bundled side-by-side comparison. **More review options** exposes the live-page comparison alongside the evidence-first review.

## Renewal reminders

- When a verified excerpt supports renewal, enter the trial end date, time zone, and lead time to preview a reminder. Download an `.ics` file for your own calendar.
- An authenticated demo operator can approve creation on the team Google Calendar. The preview is labeled **Proposed reminder** and changes to **Added to calendar** after Google confirms the write. Retries use the same event ID. Changing reviewed choices or reminder details requires a fresh check or preview before approval.

## Interface

- The carbon-copy intro appears on every open, including same-tab reloads. Its primary action takes the visitor to the live review and focuses the URL field. Escape and reduced-motion support are available.
- Top navigation links to **Live review**, **Consent lab**, and **For developers**. The desktop review pairs the evidence and reminder controls with the page capture. On mobile, the verdict and reminder come before the screenshot.
- A blocked lab proposal can be revised and checked again. Try dropping an add-on, removing automatic renewal, or sharing email only. Export the revised decision as JSON or restore the original proposal.

## Developer guard API

`POST /api/v1/guard/check` compares a proposed action with the user-authorized policy supplied by the calling app. It checks immediate charges, recurring billing intervals, and data field disclosures, then returns `allow`, `block`, or `review_required` with machine-readable reason codes. The caller owns the policy and tool execution. The guard only evaluates the proposal.

The lab calls the same endpoint. The [example client](examples/guard_client.py) shows a $49 proposal blocked by a $40 limit and the revised $40 proposal reaching a harmless demo tool. The **For developers** section links to OpenAPI and includes a copyable request.

## Verification and handoff

- The production frontend build and all 55 tests passed locally. Chromium checks covered the live Dropbox terms flow, cited evidence, reminder preview and download, and the guard's block → revise → allow flow. The saved example also passed at 320 px and 390 px.
- The [README](README.md) includes setup and Vultr deployment instructions, a system diagram, a demo walkthrough, and screenshots of the [opening](docs/screenshots/hackglobal-opening.png), [live evidence](docs/screenshots/hackglobal-live-evidence.png), and [reminder preview](docs/screenshots/hackglobal-reminder-preview.png).
- The local Dropbox walkthrough used the rules engine. Vultr deployment, live inference verification, and a real Google Calendar write remain part of the deployment handoff.
