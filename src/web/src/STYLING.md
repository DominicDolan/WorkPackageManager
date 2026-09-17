# Styling conventions

The shared theme follows the **Layout Is Not Style** approach described in the
SolidJS LINS authoring guides. It uses this application's existing dark palette
and vocabulary; there is no LINS runtime dependency.

## Where styles live

- `styles.css`: palette tokens, base resets, focus, reduced motion, and imports.
- `elements.css`: shared element categories, appearance variants, and states.
- `prose.css`: rendered Markdown typography and intrinsic content spacing.
- CSS modules: genuinely local details (brand artwork, rail decoration, task
  navigation, portfolio progress, and investigation/delivery-check presentation).
  These use `@scope` with their module-local root class to contain their rules.

Every entry stylesheet declares the same cascade order:
`theme, base, components, utilities`. This matters because Vite can load a
component module before the global sheet. Shared appearance and modules live
in `components`; Tailwind layout utilities remain free to override defaults.

## Element + variant vocabulary

| Content                      | Markup                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Card                         | `<article>`                                                                       |
| Card variants                | `<article class="tonal">`, `elevated`, `inset`, `highlighted`                     |
| Titled information card      | `<article class="summary">` with a heading                                        |
| Full-page detail content     | `<article class="document">` (no card surface)                                    |
| Interactive card             | `<button class="card-item">`                                                      |
| Collection row               | `<button class="card-item row">` inside `<section class="collection">`            |
| Compact note row             | `<button class="card-item row compact">`                                          |
| Page header                  | `<header class="portfolio">`, `library`, or `workspace`                           |
| Collection / section heading | `<header class="collection">` or `section`                                        |
| Action / navigation link     | `<button class="primary">`, `<button class="outlined">`, or `<a class="primary">` |
| Back action                  | `<button class="back">`                                                           |
| Input group                  | `<label class="field">` with a span and native control                            |
| Checkbox option              | `<label class="choice">`                                                          |
| Code input                   | `<input class="code">` or `<textarea class="code">`                               |
| Picker menu                  | `<div class="menu">` / `[role="listbox"]`, with `<button class="option">`         |
| Tabs                         | `<nav role="tablist" class="underlined">` (use `useTabs`)                         |
| View toggle                  | `<div role="group" class="segmented">` with `aria-pressed` buttons                |
| Status badge / dot           | `<span class="badge" data-status="verified">` / `<span class="dot">`              |
| Informational badge          | `<span class="badge info">`, `success`, `warning`, `error`, `accent`              |
| Notice                       | `<p class="notice error">`, `success`, or `warning`                               |
| Empty view                   | `<section class="empty">`, optionally `outlined`                                  |
| Statistics / properties      | `<dl class="metrics">` / `<dl class="properties">`                                |
| Collapsible collection       | `<details class="collection">`                                                    |
| Rendered content             | `<article class="prose">` (or `.prose` on a content wrapper)                      |
| Dialog                       | Native `<dialog>` created by `useDialog`                                          |

Bare buttons stay unadorned so tabs, text actions, and custom picker controls
do not inherit action-button spacing. Use native buttons for interactive cards,
retaining their keyboard behavior instead of adding `role="button"` to articles.
Use headings, header/footer relationships, and existing native/ARIA roles for
context before introducing another class. Never add an ARIA role only to select
an appearance.

States are attributes: `aria-current="page"` for navigation, `aria-pressed` for
toggle buttons, `aria-selected` for tabs/options, `disabled` for controls, and
`open` for disclosures. Domain statuses use `data-status` because task/check
states have no equivalent ARIA attribute. Notice and badge tokens are resolved
on the element, avoiding accidental color inheritance between categories.

Use `aria-busy="true"` on the element performing asynchronous work. It draws an
animated coloured line along the bottom without shifting layout, including on
native inputs, buttons, articles, and list items. Keep action labels stable
("Save", not "Saving…") and retain `disabled` when duplicate requests must be
prevented: `aria-busy` does not disable interaction. Track the specific action
when multiple buttons share a request lock. `--busy-color` optionally overrides
the default signal colour; reduced-motion preferences produce a static line.
For check suites, mark only the currently executing row busy and retain previous
results until the completed report arrives. Keep live progress announcements
outside busy rows so assistive technology can announce them immediately.

Typography has a deliberately small vocabulary: `headline`, `title`,
`description`, `label`, `hint`/`caption`, `reference`, and `muted`. Semantic
heading and contextual defaults cover most uses. Keep page grids, widths,
responsive positioning, and spacing between unrelated sections in JSX.
Intrinsic button/input padding and prose spacing belong to their shared rules.
Existing one-off text/layout utilities can remain where a shared variant would
not improve reuse; avoid repeating a surface recipe in new markup.

## Example

```tsx
<article class="tonal">
    <header class="p-5">
        <h3>Delivery branch</h3>
        <p>Review the changes before opening a pull request.</p>
    </header>
    <div class="p-5">
        <label class="field">
            <span>Branch name</span>
            <input class="code" />
        </label>
    </div>
    <footer class="flex justify-end gap-2 p-5">
        <button class="outlined">Cancel</button>
        <button class="primary">Save</button>
    </footer>
</article>
```

## Visual review

Run `bun run dev:web` and open `/tests/style-preview.html`. This renders the
real portfolio, workspace, tasks, notes, issues, and creation dialogs with
read-only in-memory fixture data. API mutations reject without contacting a
server. Navigate normally, but reopen the preview URL after a full reload
(the app's navigation updates the address bar).

Review at desktop and mobile widths. `/tests/ui-helpers.html` separately checks
tab navigation, underline styling, dialog focus/lifetime, and legacy callers.
`/tests/busy.html` checks shared loading indicators and branch-check progress
using in-memory requests; run it with and without reduced-motion emulation.
