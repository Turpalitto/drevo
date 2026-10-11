# Design QA — Editorial Family Archive

final result: passed

## Comparison target

- Source: selected Product Design concept 3, `exec-069e9a29-deca-40df-afba-1b7c2c080416.png` (1672 × 944).
- Implementation: local `index.html`, captured in the selected-person state and transferred to Figma at node `2:2` (1342 × 792 capture).
- States checked: desktop tree, selected profile panel, four lineage filters, relationship calculator, edit transition, mobile tree, mobile profile dialog.

## Findings

- No remaining P0, P1, or P2 findings.
- The implementation preserves the concept's core composition: dark archive header, warm paper workspace, serif editorial hierarchy, generation labels, brass lineage paths, forest selected state, and a right-side person profile.
- The profile opens non-modally on desktop and modally on mobile, preventing the original full-screen interruption while retaining all edit fields.
- The tree remains a real interactive SVG driven by archive data; it was not replaced by a decorative static image.
- Couples and joint parents are aligned on the same generation and kept adjacent, reducing line crossings.
- Person cards now prioritize larger portraits or initials, clearer names, life dates, and birthplace.
- The relationship calculator explains both the degree and the visible path.

## Required fidelity surfaces

- Fonts and typography: serif display hierarchy and sans-serif controls match the reference character; Russian labels wrap correctly at desktop and mobile sizes.
- Spacing and layout rhythm: three-region desktop composition and stacked mobile composition are stable; controls remain reachable in selected-person state.
- Colors and visual tokens: paper, forest, ink, brass, muted, and divider colors are centralized in CSS and mirrored as Figma variables.
- Image quality and assets: generated paper texture is sharp, low-contrast, and compressed for the web. Real person photos are shown when archive data provides them; initials are the intentional privacy-safe fallback.
- Copy and content: existing Russian product copy and archive behavior are preserved. The quick profile adds useful parent and child context without inventing family facts.

## Verification

- JavaScript parsed successfully with `new Function`.
- The tree booted with 10 demo people across 4 corrected generation rows; joint parents were confirmed at matching vertical positions.
- All four lineage modes were exercised: direct line, ancestors, descendants, and all blood relatives.
- Relationship checks passed for direct ancestry and siblings with Russian labels and path lengths.
- Desktop selection, lineage highlight, quick profile, edit transition, and reset were exercised in the in-app browser.
- Mobile layout and mobile person dialog were visually checked at 390 × 844.
- Browser console: no errors or warnings.
- Contribution flow was tested end to end on an isolated SQLite database: invitation context, guest submission, owner notification count, review dialog, approval, archive revision update, and pending-queue removal.
- The guest link exposes only the minimal person list needed to describe a relationship; it does not create an editor session.

## Follow-up polish

- P3: add real family portraits and places to archive records to realize the full richness of the reference.
- P3: consider a compact top search on very wide screens while keeping the sidebar search on smaller screens.

## Workspace refinement — 2026-09-14

- Added a persistent desktop control that collapses the editorial sidebar and refits the tree into the wider canvas; the hidden panel is removed from keyboard and accessibility navigation.
- Reworked the first-run state around two clear actions: add the first person or open the demo example.
- Increased person-card dates and metadata to 12–13px, strengthened generation labels, and preserved the existing archival visual language.
- Replaced the ambiguous local badge with an explicit shared/local storage status.
- Verified the empty archive, first-person form, populated four-generation demo, expanded and collapsed desktop layouts, and 390 × 844 mobile layout.
- Browser console: no errors or warnings; no horizontal mobile overflow.
