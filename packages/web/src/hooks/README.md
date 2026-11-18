# UI helpers

## Plain HTML tabs

```tsx
const { activeTab, setActiveTab, matches, tabProps, windowProps } = useTabs<
    "overview" | "investigation"
>("overview")

return (
    <>
        <nav role="tablist" class="underlined" aria-label="Work package">
            <button ref={tabProps("overview")}>Overview</button>
            <button ref={tabProps("investigation")}>Investigation</button>
        </nav>
        <section {...windowProps("overview")}>Overview content</section>
        <section {...windowProps("investigation")}>
            Investigation content
        </section>
    </>
)
```

`activeTab()` and `matches(value)` are reactive reads; `setActiveTab(value)`
selects a tab programmatically. String and number values are supported. An
accessor can supply a reactive default until the user selects a tab.

`tabProps(value)` returns a ref callback supplying click handling, ARIA associations, roving
tab index, and arrow/Home/End keyboard navigation. Put the buttons inside a
`role="tablist"` element; vertical lists can set `aria-orientation="vertical"`.
Add `class="underlined"` to the tablist for the shared underline style. Styling
uses `[aria-selected="true"]`; the hook does not set or overwrite classes.
You can supply your own button classes and style other tablist variants.

The ref factory creates its effect and cleanup in Solid's owned setup scope.
The returned callback attaches the element and native listeners, and applies
the initial state. It does not create reactive primitives in the unowned ref
callback; see the two-phase directive pattern in `docs/solid-2.0/07-dom.md`.

`windowProps(value)` supplies panel identity, labeling, and `hidden`. Panels
stay mounted by default. For expensive content, put
`<Show when={matches(value)}>…</Show>` inside the panel, as the work-package
workspace does. The hook owns selection and accessibility, not panel animation.

## Function-driven native dialogs

```tsx
const { openDialog, closeDialog } = useDialog(
    ({ closeDialog }) => <DialogContentComponent close={closeDialog} />,
    { id: "some-id", label: "Edit task" },
)

return <button onClick={openDialog}>Edit task</button>
```

The config and content callback argument are optional: `useDialog(() =>
<DialogContentComponent />)` also works. No outlet or open signal is needed.
Call the hook during component setup. It mounts a native `<dialog>` in the
document body on demand, preserving the caller's Solid context. Repeated opens
are ignored while open; reopening mounts fresh content. Closing or removing the
owning component disposes the rendered content and removes the dialog.

Defaults are modal presentation (`popover: false`) and
`closedby: "closerequest"` (Escape dismisses; backdrop clicks do not).
`closedby: "any"` also permits backdrop dismissal; `"none"` requires an
explicit close. Native modal dialogs handle focus trapping, background
interaction, and focus restoration. `popover: "auto" | "manual"` opts into
the browser's non-modal Popover API and its dismissal rules instead.

`closeDialog(returnValue?)` closes programmatically. `onClose(returnValue)`
receives user/programmatic dismissals, including native `dialog.close()` or
`method="dialog"` forms; owner disposal does not call it. `label` defaults to
"Dialog"; give plain content a descriptive label. Existing `Modal` content
provides its title as the accessible label and reuses the host dialog.

`Modal` also supports existing signal-driven callers, opening a native dialog
when mounted and allowing backdrop dismissal as before.

## Extraction notes

Thirteen secondary components were moved into adjacent files across the work
package, task, notes, issues, home, and agent-settings screens. Their existing
prop contracts were retained: none required additional props.

`WorkPackageContent` remains nested in `WorkPackageWorkspace`: it captures the
parent props, work-package accessor, error/busy state, mutation handler, tabs,
and dialog actions. Extracting it would require at least two additional inputs,
so it is the exception to this pass. Small presentation helpers such as
`BranchSection`, `Metric`, `Detail`, and `RunChoice` stay beside their consumers.

## Browser verification

Run `bun run dev:web` and visit `/tests/ui-helpers.html`. The page reports
checks for reactive tabs, keyboard focus, native dialogs, caller context,
reopening, native close, popovers, owner disposal, and legacy modal callers.
It must end with `ALL CHECKS PASSED`. Use normal browser timing: Chrome's
`--virtual-time-budget` can advance timers before native dialog close events,
which are scheduled with rendering.
