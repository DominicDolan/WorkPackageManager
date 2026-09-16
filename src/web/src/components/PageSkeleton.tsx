export function PageSkeleton(props: { compact?: boolean }) {
    return (
        <div
            class={`mx-auto max-w-[1600px] animate-pulse px-6 ${props.compact ? "py-6" : "py-16"}`}
        >
            <div class="h-7 w-48 rounded bg-slate-200" />
            <article class="mt-5 h-32" />
        </div>
    )
}
