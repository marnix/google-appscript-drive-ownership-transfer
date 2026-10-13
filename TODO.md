# TODO (Drive ownership transfer)

## Completed (archived)
- Offer phase: resumable single-pass scan (chunked), permission checks during walk, tree rendering with ancestor expansion, progress ratio, size tracking, bold file-summary, self-target guard.
- Accept phase (scan + tree): mode detection/UI branching, paginated accept scan filtering pending offers (pendingOwner:true), bytesChecked/bytesFound, ancestor-expanded tree building, busy-bar progress, locale-aware bytes formatting.
- Accept execution (c)+(g): startAccept/continueAccept/runAcceptState_ with Permissions.update({role:'owner'}, ..., {transferOwnership:true}), 15s chunking, accept-mode progress/result UI.
- Handle orphans (e): group items with no parents under virtual "Unorganized" root in accept tree.
- Size totals in UI (f): include bytes in accept count label (offer/accept counts as applicable).

## High-risk (do first)
1. **(4)** Update conceptual description: clarify this supports both leavers and current users handing over docs to org (for storage/control). Update README(s) and any in-app explanatory text accordingly. (docs-only or UI copy)
2. **(3)** On accept execution, when transferring ownership, remove the _direct_ permissions of the original owner(s) on files/folders, but preserve _indirect_ (inherited) permissions from parent folders. (code change in accept execution)
3. **(1)** Fix UI copy in accept mode: "accountHint" currently says "Use the account that owns the files" which is wrong for org accepting. Add accept-specific string (accountHintAccept) and set it in accept mode.
4. **(2)** Accept screen has empty notice block — add explanatory text (nothingMoves/roleNote equivalent for accept, or dedicated noticeAccept) explaining what happens on accept.

## Medium/cleanup
5. **(d)** Expand hierarchy to roots further if needed (increase ancestor expansion rounds or ensure deep paths fully expanded in accept/offer trees).
6. **(a)** Review and clean up: remove unused code, rename for clarity, reduce duplication across Offer.gs/Index.html/I18n.gs; general refactor pass.
7. **(b)** Final verification: end-to-end sanity test for accept mode (org-side), verify orphans, bytes totals, permission cleanup behavior. Document any manual test notes.

## Notes
- Do not commit changes for one-time accept test until explicitly requested.
- Preserve chunking/state behavior (15s budget, YIELD_REMAIN, Script Properties limits).
