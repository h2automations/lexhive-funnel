# LexHive UI, UX, and growth review

Reviewed 10 September 2026. This is a review and proposed implementation brief; application code has not been changed.

## Recommendation

Build around a short, reassuring, tap-first qualification flow, followed by the minimum contact information needed for a useful follow-up. Optimize for contactable, buyer-accepted qualified leads per visitor and per advertising dollar. A completed form alone is insufficient evidence of success.

The current foundation is useful: large answer buttons, one question per screen, native autofill, readable body text, and no free-text medical narrative. The biggest opportunities are unnecessary questions, delayed routing, weak service context, and the sudden increase in effort at contact capture.

## Evidence and scope

Inspected the local React application and qualification/API code. Exercised the seven question screens, contact capture, success, unsupported-state flow, disqualified contact flow, operations login, and operations dashboard at 320, 390, 768, and 1440 CSS pixels wide in Chromium. Backend responses and operations data were mocked; external requests were blocked. These were layout and interaction checks, not production delivery verification. Loading and error handling findings also use source inspection. Checked the first screen at 200% root font size; this is not a complete accessibility certification or real-device keyboard test.

Measured findings:

| Finding | Evidence |
|---|---|
| Customer screens fit the tested widths | No horizontal document overflow at the four tested widths with default text size. |
| Contact capture has substantial vertical effort | At 390 × 844, document height is 1,112 px and Submit begins at y=911. At 320 × 844, it is 1,218 px tall. |
| State selection is a long nested scroll | 51 answer buttons in a container capped at 55vh. |
| The question moves substantially between steps | At 390 px wide, the opening card begins at y=293; the state card at y=91. Vertical centering changes the reading position with content height. |
| Enlarged text exposes wasted horizontal space | At 320 px and 200% root text size, the first screen reaches about 1,143 px tall. Relative outer and inner padding leave a very narrow text column. |
| Operations is not mobile responsive | With the mock data, its document is 527 px wide at both 320 and 390 px viewports. |
| Operations action contrast is broken | `ops.css` uses undefined `--action`, `--paper`, `--line`, and other color variables. View and Replay render as white text without their intended button background. |

No traffic, conversion baseline, buyer acceptance data, or user interviews were available. Impact estimates below are prioritization judgments, not measured uplift claims.

## Screen-by-screen changes

| Screen/state | Current friction | Recommended change | Priority |
|---|---|---|---|
| Entry / age | Opens with an age question and no visible LexHive identity, service explanation, or privacy link. | Put a compact LexHive header and one-sentence service promise above the first question. State that this is a specialist enquiry, not a benefits application. Keep the first answer visible without a separate Start screen. Retain age selection if needed by the partner's intake rules. | High |
| Gender | An entire step whose code comment identifies advertising matching as the purpose. It is not a knockout question. | Remove from the initial funnel. Update server validation and integrations together. Do not replace the question with an inferred gender. | High |
| State | 51 large buttons require alphabetic scanning and nested scrolling. | Use an accessible state picker: native selection on mobile or a tested searchable combobox. Keep a visible label and confirm the choice before advancing so keyboard navigation does not select accidentally. Show “Checking availability…” while validating. | High |
| Work limitation | Plain Yes/No buttons are fast, but the question can feel abrupt without context. | Keep one tap per answer. Use short wording and one optional explanation where it improves accuracy. Preserve distinctions required by the intake criteria; do not broaden the wording and silently keep the old classification. | Medium |
| Duration | Long sentence requires several lines; users may be uncertain about prognosis. | Test “Has your condition lasted—or is it expected to last—at least 12 months?” Add “Not sure” only with an explicit manual-review route; it must not silently count as Yes or No. | Medium |
| Doctor's care | “Under a doctor's care” can be harder to interpret; No automatically disqualifies. | Test “Are you seeing a doctor for this condition?” Keep this screen only if it is necessary for partner acceptance. Otherwise collect it during follow-up. Lack of current care should not be described as a definitive SSA eligibility decision. | High |
| Work history | “20+ years (roughly 40 quarters)” mixes incompatible quantities and drives rejection. | Correct the qualification specification before rewriting this question. Use an approved plain-language screening question and route uncertainty for review. Do not ask people to calculate quarters. | Critical |
| Contact | Five required fields after seven question screens; generic “Submit”; little explanation of the benefit of sharing details. | For a phone-led service, test required first name, last name, and phone, with email optional. Keep ZIP only if needed for routing or partner acceptance. Use “Request a callback” when that is the actual fulfilled offer. Explain who will contact them and why. | High |
| Consent | A long paragraph is the first detailed explanation of outreach. | Explain the outreach earlier in plain language; keep the actual disclosure readable next to the unchecked checkbox. Link the real privacy notice and identify the contacting business accurately. Do not hide or preselect consent to shorten the form. | High |
| Unsupported state | The user answers four additional questions after state availability is known, then checks an acknowledgement and presses Submit despite no service being offered. | Show the availability outcome immediately. Offer official information and “Change state.” Remove the acknowledgement/submission step if no required business purpose exists. This needs an explicit early-exit API path, not a fake completed application. | High |
| Disqualified | The UI only distinguishes restricted from everyone else; disqualified users still enter full contact details and receive the generic specialist message. | Use a separate result: “This service may not be a match.” Offer useful next steps. Collect contact details only if a real alternative review service is offered and requested. | High |
| Checking availability | Buttons disable, but no visible checking text is rendered. An unsuccessful check can set the restricted state. | Distinguish “We cannot check availability right now” from “We do not serve this state.” Provide retry and a timeout; keep contact capture gated until availability is known. | High |
| Submission / validation error | Phone format can fail only at the server; most API rejections become a generic error. Back remains active during submission. | Show field-specific errors with examples, focus the first invalid field, preserve values, and prevent conflicting navigation while sending. Keep an honest retry state for network errors. | High |
| Success | “A benefits specialist may contact you” provides little preparation for the next interaction. Focus handling explicitly skips the done screen. | Confirm receipt, identify the contacting organization, explain the next step, and provide a realistic response window only if operations supports it. Move focus to the confirmation heading. Add optional scheduling only if the service supports it. | High |
| Back / return | In-memory answers survive Back but are not visually indicated; a reload restarts the interface despite server-side partial saves. | Highlight the existing answer when revisiting. Preserve position and answers during navigation. If adding reload recovery, define a short-lived privacy-aware resume mechanism for this sensitive form rather than broadly persisting answers on shared devices. | Medium |
| Operations login | View button loses its background; updating the key triggers loading while it is still being typed. | Define the missing color tokens, use a visible label, submit explicitly, show an authenticating state and a clear rejected-key error. | High |
| Operations dashboard | Wide tables overflow; action buttons lack contrast; Replay does not check the POST result before reloading. | Restore colors; use mobile cards for failures and recent activity; put necessary wide tables in labeled horizontal scroll regions. Show replay success/failure, last updated time, stale-data state, and next retry. Label technical states in plain language. | High |

The work-history issue is substantive: SSA says work credits depend on earnings, up to four per year; generally 40 credits are needed, with 20 earned in the preceding ten years, and younger workers may qualify with fewer. “20+ years” is not equivalent to “40 quarters.” Partner screening criteria must also be distinguished from a government benefits determination. [SSA eligibility guidance](https://www.ssa.gov/benefits/disability/qualify.html).

## Proposed flow

Keep one short decision per screen as the starting design. Removing screens is useful when the underlying information is unnecessary; combining several difficult questions into one page is not automatically faster. This is consistent with the [GOV.UK question-page guidance](https://design-system.service.gov.uk/patterns/question-pages/).

1. Compact service introduction + age question.
2. State picker → immediate availability outcome when unsupported.
3. Work limitation.
4. Duration.
5. Corrected work-history screening.
6. Doctor's care only if required for partner acceptance.
7. Minimal contact details + consent → confirmation.

This removes gender and can remove the doctor screen if it is not necessary. A supported prospect encounters five or six selection screens, followed by contact capture. Confirmed non-matches leave earlier. Keep answer buttons as direct actions and say “Tap an answer to continue”; avoid adding a Next click to every binary question. State selection needs a deliberate commit because arrowing through a picker is not the same as choosing an answer.

Show visible progress such as “Question 2 of 6” and “Final step: contact details.” Adjust the count for the actual branch. Do not display a fabricated percentage or claim “60 seconds” until observed completion times support it. W3C recommends communicating the number of steps and progress in multi-page forms. [W3C multi-page form guidance](https://www.w3.org/WAI/tutorials/forms/multi-page/).

Example entry copy, to align with the actual service:

> LexHive
>
> Find out whether our disability support service may be a match.
>
> Answer a few short questions. This is not an application for benefits.
>
> Are you between 18 and 64 years old?
>
> Yes · No
>
> Tap an answer to continue. Privacy notice.

The age range itself remains a partner-rule assumption, not a claim about universal SSA eligibility. Avoid adding “free,” benefit amounts, success statistics, reviews, credentials, or government associations unless they are verified and applicable.

## Responsive design brief

- Mobile: stable top alignment beneath the compact header; 16–20 px outer gutters; reduce card padding on narrow screens. Use a single column and large full-width answer buttons. Preserve the existing approximately 64 px answer targets and readable body text.
- Desktop/tablet: retain a focused form column around 520–600 px. Add only compact explanatory content if needed; avoid a large hero pushing the first question away from the action.
- Reduce typing and unnecessary fields before compressing typography. Put first and last name beside each other only where width comfortably allows; stack them on phones. Keep visible labels, autocomplete, and appropriate phone/email/numeric keyboards.
- Let long pages scroll normally. Do not force contact capture into one viewport by shrinking consent or text. If testing a sticky action, it must not cover fields, validation, consent, or the mobile keyboard; allow sufficient bottom space.
- Keep a stable question position between steps. Preserve clear keyboard focus and show the selected answer on Back. Guard against accidental duplicate activations. Honor reduced-motion preferences.
- Test 320, 360/390, 768, and 1440 px; 200% text; short landscape viewports; iOS Safari and Android Chrome with the keyboard open; keyboard-only and screen-reader completion. Existing Chromium checks do not replace those tests.

## Growth strategy and measurement

Use an operational MQL definition: within supported service criteria, valid reachable contact information, explicit request/consent for follow-up, and not a duplicate or test record. The current application's `qualified` label is a preliminary rule classification, not proof that a lead is contactable or accepted by a partner.

Track the journey internally: unique landing → first answer → qualification outcome → contact viewed → valid submission → contacted → accepted by the partner → appointment/intake. Measure each step by distinct submission/session rather than raw clicks, since revisiting answers can repeat step events.

Primary measures:

- Contactable qualified leads / unique landing visitors.
- Advertising spend / contactable qualified leads.
- Partner acceptance and appointment/intake rates.

Diagnostic measures:

- Start rate; abandonment and active completion time by step.
- Contact-form completion and field-error rates.
- Wrong-number, duplicate, unable-to-contact, and complaint rates.
- Time to first contact, compared across the same operating hours and lead cohorts.

Use actual traffic to prioritize subsequent tests. First correct inaccurate qualification and broken states; these are fixes, not experiments. Then test one major hypothesis at a time: state picker usability, shorter contact capture, and clearer offer/CTA. Compare equivalent channels/devices and predefine the evaluation window, minimum useful effect, sample requirement, and quality guardrails. No fixed uplift or sample size can be justified without baseline traffic and conversion rates.

Keep medical answers and health-derived qualification outcomes in appropriate first-party reporting. Do not assume a generic event name or hashing makes those data appropriate for advertising platforms. The current repository already notes a medical-category restriction; any platform conversion feedback must be reviewed against applicable platform permissions and data restrictions before adding it.

Message continuity matters: the ad, first screen, contact CTA, confirmation, and caller should describe the same offer. If the ad offers a benefits eligibility check but the fulfilled outcome is a specialist callback, make that relationship clear before contact capture. A person expecting a callback is more likely to recognize the follow-up as something they requested; measure that hypothesis through contact and acceptance rates.

## Implementation order and dependencies

1. Correct work-history wording and qualification rules; separate unsupported, non-match, temporary failure, and success outcomes.
2. Replace the state list, remove gender, and route confirmed non-matches earlier.
3. Establish the minimum partner-required contact fields; update UI and server validation together. The API currently requires both names, email, phone, ZIP, gender, and all question answers on completion. A UI-only removal will fail.
4. Add compact service context, progress labels, privacy information, field-level errors, and useful confirmation copy.
5. Stabilize mobile spacing and fix the operations color tokens and table layouts.
6. Validate keyboard/mobile behavior and launch a measured variant. Distinct URL labels alone currently do not produce a different UI or randomized assignment; implement the actual experiment and stable assignment.

Relevant source areas: `src/components/Funnel.tsx` for questions and screens; `src/styles/funnel.css` for layout; `api/_lib/qualification.ts` for knockout rules; `api/lead.ts` for required answers/contact and result classification; `src/components/Ops.tsx` and `src/styles/ops.css` for operations; `src/lib/datalayer.ts` for events. Update the page metadata too: it currently advertises six questions while the interface asks seven.
