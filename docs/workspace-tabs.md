# Conversation workspace tabs

## Surfaces and identity

A conversation route owns one centre column: a compact title, a nonwrapping view
selector, and one full-size active surface. Conversation is pinned and cannot be
closed. Files and terminals are sibling views. A full-height explorer sits to the
right on desktop. Its divider previews a proposed width and commits only on
pointer release; Escape and pointer cancellation retain the previous width.
Preview and commit share the 45%-of-container limit. A click without movement
does not replace a wider desktop preference with the currently constrained width.
Withdrawing the divider cancels its gesture rather than retaining a stale preview.

The explorer waits for its conversation's directory adoption to complete and
for a root to exist. The keyed `WorkspaceTree` owns that request and its local
`adoptedCwd` state; the authenticated layout only adopts standalone browser roots.
The browsed root is never compared with cwd: entering folders and going up both
change it. Checking only root existence allowed a cold conversation to show the
previous tree while metadata or registration was pending. Adoption retains the
old cache, ignores superseded replies, and shows the requested directory even
when registration fails so its own read error stays visible. It never clears
the root first, preserving expansion and selection for the same directory.

`ConversationFrame` and its scroller keep the same React identity across sibling
view changes. Inactive surfaces retain geometry using `visibility` and `inert`;
portalled controls observe the surface activity context and close on withdrawal.
Only the selected conversation keeps a transcript React tree. The desktop
tablist has one tab stop; arrows move focus without activation and Delete closes
a focused closable tab. Other conversations
retain data, view descriptors, and semantic reading bookmarks.

Phone/tablet controls use an always-reachable Conversation action, a current-view
chooser, and Explorer. The chooser selects explicitly; moving keyboard focus does
not activate a view. Explorer uses the existing sheet component. Changing the
breakpoint changes controls and explorer presentation, not the active content
identity or the remembered desktop width. The left navigation is unchanged.

## State ownership

| Owner | Lifetime and responsibility |
| --- | --- |
| `workspace-store` | In-memory per-conversation tab order, active view, editor view state and one-shot reveal requests; reset on reload |
| `layout-store` | Persisted explorer collapse state and preferred width, alongside existing navigation preferences |
| `document-store` | Shared text model, saved content/revision pair, dirty/conflict/save state for an absolute file |
| `terminal-store` | Shared metadata, typed operations, creation-free discovery and presented-only recovery |
| `terminal-view-store` / `TerminalHost` | Local retained attachments and the currently visible presentation rectangle |
| `timeline-store` and its action modules | Conversation-scoped history, opening, submission, execution and pending decisions |
| `transcript-anchor` | In-memory reading bookmarks independent of runtime-cache eviction |

Opening a file resolves its path in the originating conversation. Changing the
working directory changes future opens and the tree; existing absolute file
references and terminal working directories remain the same. An unavailable root
shows its own error. It does not substitute a different directory or clear drafts.
Confirmed deletion removes only the deleted conversations' descriptors/bookmarks
and local terminal attachments. Idle transcript eviction does not delete tab sets.

File views are inexpensive descriptors; inactive editor widgets can be released.
Two views of one absolute path use the same Monaco text model. Dirty models retain
text and undo history without a mounted editor. Clean unused models are disposed.
A read cannot overwrite a dirty model or advance its saved revision. A save pairs
the submitted text with the returned revision; edits during the request remain
dirty. Cursor and scroll state, and line-reveal requests, belong to the view. A
reveal is consumed after the intended active model has actually been revealed.

A destination with no usable layout size cannot fit/report terminal dimensions
using a previously measured rectangle.

The standalone Files and Terminal routes remain separate navigation destinations
and use these same document/attachment owners.

## History readiness and controls

Foreground opens request the current first-page size (20 turns) with full items.
Summary/not-loaded responses never qualify for presentation. A valid empty page,
a short exhausted page, and a full page with an older-turn cursor are distinct
from failed or incomplete reads. A running turn can have valid full persisted
items without being finished.

The loading gate is a sibling overlay outside the Conversation scroller. Header,
view controls, and remembered file/terminal views remain usable while it loads.
The initial response is reconciled with live observations; an acknowledged room
join triggers a fresh full read to cover the HTTP/socket gap. Covered turns reuse
that full page, with no per-row enrichment requests.

Turns the pages did not cover are read individually, four at a time, on two
different footings. A turn holding an unterminated item or plan fragment — or the
one believed to be running — is visibly wrong until repaired, so it blocks the
reveal and its failure is reported as an incomplete recovery. A retained
*completed* turn is only swept for late sub-agent items, which attach after their
parent's `turn/completed`; nothing marks such a turn as swept, so an unbounded
sweep would be re-issued in full on every reconnect and would grow with every
page the reader loads. That sweep is therefore capped at eight
retained turns in history order, prioritizing the current reading bookmark. It
logs the dropped count and runs after required repair without being awaited by
the open. Failures appear as a background refresh warning, not a readiness
failure: one unreadable old turn must not replace a readable transcript with an error screen.
Late items on turns beyond the cap stay uncovered.

Partial item results may repair known fragments but report an error and do not
establish full coverage. Warm valid content remains readable after refresh failure.

`hydrated`, `historyRequest`, and `historyError` describe history. `openState`
describes opening/write readiness. `turnStartPending` covers the submission gap;
`activeTurnId` describes observed execution. Read-only, deletion and policy
confirmation remain independent restrictions. A substantive start response or a
matching lifecycle event reconciles submission. Merely finishing an HTTP request
does not release Send, and an old turn's event cannot release a newer submission.

## Geometry and reading position

The composer always floats. `ConversationFrame` measures the whole covering
wrapper, including padding and safe area, and supplies the same nonzero measurement
to `paddingEnd` and `scrollPaddingEnd`. Width, attachments and textarea growth can
change this measurement. The transcript and composer both fill the conversation
surface — neither caps its width — and share the same responsive horizontal
padding so the two stay aligned. The shell and the resizable explorer decide how
much room there is; all content remains within its available width. A width
change invalidates cached row heights, so it goes through the same geometry and
reading-anchor path as any other measurement change.

The composer is an opaque surface, and the scroller masks its own bottom edge so
rows dissolve as they pass under it rather than cutting against its edge or
surfacing in the gutters beside it. The mask ramp begins exactly where
`paddingEnd` already reserves the composer band, so a transcript resting at the
end is never faded. Rationale for not using a blurred pane instead is in
[frontend-ui.md](frontend-ui.md).

The pinned virtualizer uses `anchorTo: 'end'` with `followOnAppend: false`.
Indexed follow targets are prohibited: appends use one fixed `scrollToOffset`.
Direct DOM updates own the extent height and individually positioned measured
rows. Gates, history controls and jump controls live outside the scroller.

While following, **every** geometry batch re-pins to the end. Restricting it to
appends and viewport changes was measured to break the cold open in both
Chromium and WebKit: a first page settles by rows replacing their estimated
height with a measured one, which moves the end without changing the row count
or the viewport, so the transcript opened scrolled to the top. User input
cancels pending correction. A resize received during a gesture cannot leave
an older bookmark armed after it. Every library/application write records its
actual offset, so unexplained visible scrolling (including browser focus/search
navigation) is accepted without requiring an earlier wheel event. A recorded
offset clamped to a smaller scroll extent is geometry, not navigation, including
when shrinking composer padding leaves the viewport dimensions unchanged. End detection
uses a two-pixel rounding tolerance; an upward gesture within the former 80-pixel
threshold must still stop following. Hidden scrolling never changes intent.
The same tolerance is passed as `scrollEndThreshold`. It narrows, but does not
disable, the library's `wasAtEnd` size compensation. That branch and first
measurements can compensate during backward scrolling; only ordinary non-end
re-measurement uses the backward-direction exclusion in the pinned version.

`useFlushSync: false` avoids discarded flushes when measurement is invoked
from a React layout effect. Direct DOM updates synchronously position existing
nodes and resize the extent. They do not create missing nodes: when native
scrolling leaves the mounted/overscanned range, new rows still require a React
commit. This configuration does not guarantee same-paint mounting under main
thread pressure. Browser coverage must include large native range changes.

The scroll owner saves follow intent independently of incidental hidden scrolling.
Hidden output is ingested without per-append end writes. Activation measures the
target at its current width and restores history or settles at the end before
reveal. Width/font changes invalidate stale height assumptions; ordinary activation
does not clear the cache. A historical bookmark outside the retained window causes
bounded full paging. Unrecoverable identity is reported rather than silently
claiming an exact restoration or jumping to latest.

Inline bookmarks identify a row, item, block, and logical text offset. React's
pre-mutation snapshot retains the point; the transcript layout effect runs after
adapter effects, synchronously measures mounted rows, then writes only the
remaining displacement. Browser-driven row resize schedules one microtask after
the synchronous measurement batch. User input cancels correction; later layout
changes establish a new batch. Missing semantic identity falls back to a
retained boundary/current offset. No timer reasserts an anchor, and CSS scroll
anchoring is not required.

A batch normally ends on **two consecutive** zero-displacement passes, not one, and the
original point survives every pass in between. A single zero reading is a
sample, not convergence — measured over an 800→430 column change in both
engines: the width cache is invalidated, so every unmounted row drops back to
its estimate; the point is restored exactly and the next pass legitimately
reads zero; then the rows above it mount and measure taller and the point moves
~950px. Releasing on that first zero re-anchored to a half-converged position
and then corrected *towards* it, walking the reader away from the sentence that
had just been put back. At most six geometry checks participate, counting zero
samples as well as correction writes. Missing geometry is not a zero sample;
unreachable offsets accept clamping and release. Input, hiding and explicit
navigation end the batch. Only actual commit/measurement notifications drive
checks, with no timer or polling loop waiting for an image or font. Two zeros
are a settling heuristic, not proof against future layout changes: a delayed
asset after release starts a new batch from the last settled reading point.

The width invalidation itself is a known deviation: the agreed design says to
invalidate the *affected* heights, and the pinned virtualizer exposes only
`measure()`, which clears the whole cache. The transaction surviving across
passes compensates for that; it does not remove it.

## Terminals and verification

Logical terminal identity and tab position survive replacement of the physical PTY. Only the presented terminal in a visible browser page requests replacement; hidden lost terminals stay lost until selected. The backend enforces three automatic attempts per identity in a rolling 24 hours, persisted across restart. A visible limit message offers manual recovery without resetting that budget. Replacement displays a persistent shell/cwd notice and the most recent previous shell's local output in a separate read-only section; disconnected input is discarded. See [terminal.md](terminal.md) for durable close ordering and directory precedence.

Terminal instances live in `TerminalHost`, beyond route and sibling-tab lifetimes.
Inactive instances stay mounted, attached and receiving output. Only a visibly
usable active instance fits/reports dimensions, including after reconnect.
Closing a terminal tab explicitly closes the shared session; shared attachments
retain the confirmation. A failed close keeps the view. Natural exit keeps its retained output; remote logical close preserves local output while permanently revoking replacement eligibility. Route cleanup only
detaches local ownership and never invokes destructive close. Conversation opening discovers and attaches extant sessions, including exited buffers, without selecting their tabs or creating processes. Listing a session does not authorize replacing it if it disappears before attachment.

Vitest has separate `unit` (existing jsdom) and `browser` projects. Browser tests
exercise, in Chromium and WebKit: the production virtualizer under hidden
retention, activation after width changes, simultaneous row changes and native
wheel input with late content; the terminal overlay tracking its published
rectangle, staying out of hit testing while hidden, and reporting dimensions
only while visibly presented; the explorer divider previewing without reflow,
committing the same constrained width it previewed, and leaving a wider
preference alone on an unmoved click; and the view selector holding one row and
one tab stop, `inert` actually blocking pointers and focus, and a portalled
dialog leaving the document when its surface deactivates. Because
`visibility: hidden` alone already refuses focus and hit testing, the `inert`
case asserts it on a *visible* panel and then removes it as a positive control.
Assertions name the reading point, not `scrollTop`: when a browser navigates to
a sentence and rows above it then measure taller than their estimates, holding
that sentence still is precisely what moves the offset, so an offset assertion
would fail on correct behaviour and pass on a restored stale anchor. In `web/`: `pnpm test` runs
the jsdom project, `pnpm test:browser` the real-browser one, and
`pnpm test:browser:install` downloads the binaries it needs. Failure screenshots
and their annotation attachment copies go under `web/.vitest-screenshots`,
which `test:browser` clears on each run — the
default puts them beside each test file, where they accumulate and orphan
themselves whenever a case is renamed. They are separate commands because the browser project cannot
run without those binaries, and a default command that fails on a fresh clone
teaches people to ignore it — but skipping it is not neutral. jsdom has no layout
engine: `getBoundingClientRect` returns zeros, `Range.getClientRects` returns
nothing, and `ResizeObserver` is a stub, so every claim in this section about
positions and measurement is unverifiable there. A browser launch failure means
layout behavior has not been verified; unit tests are not a substitute.
