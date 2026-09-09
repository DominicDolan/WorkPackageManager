# `web-new` organisation

The `web-new` frontend is organised around **Areas**. The purpose of this
convention is to make the source tree easy to browse: a reader should be able to
find the entry point for a substantial part of the UI from its directory name,
then find all of its private implementation nearby.

## Areas

An Area is a substantial, recognisable part of the application. It will usually
be a page, but it can also be another self-contained piece of UI with enough
complexity to deserve its own boundary, such as a dialog.

Each Area:

- has a **PascalCase** directory name;
- has an entry component with exactly the same name as its directory; and
- keeps files used only by that Area inside the Area directory.

For example, `UserPage/UserPage.tsx` is the entry point for the `UserPage` Area.
The repeated name serves the same navigational purpose as an `index` file while
remaining explicit in editor tabs, imports, and search results.

```text
src/
  UserPage/
    UserPage.tsx       # Area entry point
    UserDetails.tsx    # Component private to UserPage
    userService.ts     # Service private to UserPage
```

Import the Area through its named entry file:

```ts
import { UserPage } from "./UserPage/UserPage"
```

Do not add `index.ts` barrel files merely to hide the entry filename. The
`AreaName/AreaName.tsx` pairing is the convention that tells a reader where to
start.

## Colocation

Prefer keeping code beside the Area that owns it. Components, services, types,
helpers, styles, and tests that are used by only one Area belong in that Area's
directory.

An Area may contain further directories when it becomes large, but its entry
component remains directly inside the Area directory and retains the same name.

```text
src/
  UserPage/
    UserPage.tsx
    UserDetails.tsx
    userService.ts
    userTypes.ts
    UserPage.module.css
```

Code should be moved into a shared directory only when it is genuinely used by
more than one Area. Avoid creating global abstractions in anticipation of reuse.

### Area styles

When an Area needs CSS, use a colocated **CSS Module** with a `.module.css`
extension. Name it after the component it styles, such as
`UserPage.module.css` or `UserDetails.module.css`, and import it directly from
that component.

```tsx
import styles from "./UserPage.module.css"

export function UserPage() {
  return <main class={styles.page}>...</main>
}
```

Do not add Area-specific selectors to the global stylesheet. Global CSS should
be limited to application-wide concerns such as resets, design tokens, fonts,
and base element styles.

## Shared code

Shared directories use lowercase names so that Areas stand out when scanning
the source tree. Add a shared directory when the application has code that fits
that category; an empty directory is not required.

The common shared locations are:

```text
src/
  components/          # Reusable UI components
  services/            # API clients and other shared external interactions
  utils/               # Small, UI-independent helpers
  types/               # Types shared across multiple Areas, when needed
```

The distinction is ownership rather than file type. A service used only by
`UserPage` stays in `UserPage`; a component used across several Areas belongs in
`components`.

Shared code must not import from an Area. Areas may depend on shared code, and
one Area's entry point may compose another Area, but shared modules should not
depend on private Area implementation files.

## Application entry point

`main.tsx` is the application bootstrap. It should stay small: initialise the
application, mount the top-level Area, and contain only wiring that truly belongs
at the application boundary. Substantial UI and behaviour belong in Areas or
shared modules.

## Placement checklist

When adding a file, decide where it belongs in this order:

1. Is it part of a substantial page, dialog, or other feature? Put it in a
   PascalCase Area directory.
2. Is it used only by one Area? Keep it inside that Area, regardless of whether
   it is a component, service, helper, type, style, or test.
3. Is it already used by multiple Areas? Put it in the appropriate lowercase
   shared directory.
4. Is it application bootstrap code? Keep only the minimal wiring in `main.tsx`.

The default is local ownership. Promote code to shared scope when actual reuse
makes that ownership clearer.
