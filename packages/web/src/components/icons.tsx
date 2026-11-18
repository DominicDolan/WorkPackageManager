export function BackIcon() {
    return (
        <svg
            class="icon w-[1.15rem] h-[1.15rem]"
            viewBox="0 0 20 20"
            aria-hidden="true">
            <path d="m11.8 4.7-5.3 5.3 5.3 5.3M6.8 10h7" />
        </svg>
    )
}

export function PlusIcon() {
    return (
        <svg
            class="icon w-[1.15rem] h-[1.15rem]"
            viewBox="0 0 20 20"
            aria-hidden="true">
            <path d="M10 4v12M4 10h12" />
        </svg>
    )
}

/** Grow a card: arrows out to the corners. */
export function ExpandIcon() {
    return (
        <svg
            class="icon w-[1rem] h-[1rem]"
            viewBox="0 0 20 20"
            aria-hidden="true">
            <path d="M11.5 3.5h5v5M16.5 3.5l-5.5 5.5M8.5 16.5h-5v-5M3.5 16.5 9 11" />
        </svg>
    )
}

/** Shrink a card back: arrows in from the corners. */
export function CollapseIcon() {
    return (
        <svg
            class="icon w-[1rem] h-[1rem]"
            viewBox="0 0 20 20"
            aria-hidden="true">
            <path d="M16.5 8.5h-5v-5M11.5 8.5l5-5M3.5 11.5h5v5M8.5 11.5l-5 5" />
        </svg>
    )
}

/* Tab kinds on the work package page. Sized to sit beside tab text. */

export function TasksIcon() {
    return (
        <svg
            class="icon w-[1rem] h-[1rem]"
            viewBox="0 0 20 20"
            aria-hidden="true">
            <path d="M3.5 5.5 5 7l2.5-2.5M3.5 12.5 5 14l2.5-2.5M10 6h6.5M10 13h6.5" />
        </svg>
    )
}

export function InvestigationIcon() {
    return (
        <svg
            class="icon w-[1rem] h-[1rem]"
            viewBox="0 0 20 20"
            aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="4.75" />
            <path d="m12 12 4.5 4.5" />
        </svg>
    )
}

export function BranchIcon() {
    return (
        <svg
            class="icon w-[1rem] h-[1rem]"
            viewBox="0 0 20 20"
            aria-hidden="true">
            <circle cx="6" cy="4.5" r="1.75" />
            <circle cx="6" cy="15.5" r="1.75" />
            <circle cx="14" cy="6.5" r="1.75" />
            <path d="M6 6.25v7.5M14 8.25c0 3.5-8 2.5-8 5.5" />
        </svg>
    )
}

export function RunIcon() {
    return (
        <svg
            class="icon w-[1rem] h-[1rem]"
            viewBox="0 0 20 20"
            aria-hidden="true">
            <path d="M6.5 4.5v11l9-5.5z" stroke-linejoin="round" />
        </svg>
    )
}
