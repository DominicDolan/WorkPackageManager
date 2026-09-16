import { For, Show, createSignal } from "solid-js"
import type { VisualComparison } from "@shared/types"
import { imageUrl } from "../api"

type ComparisonMode = "side-by-side" | "slider" | "diff" | "before" | "after"

export function ComparisonViewer(props: { comparison: VisualComparison }) {
    const before = () => imageUrl(props.comparison.beforePath)
    const after = () => imageUrl(props.comparison.afterPath)
    const diff = () => imageUrl(props.comparison.diffPath)
    const initial: ComparisonMode = diff()
        ? "diff"
        : before() && after()
          ? "side-by-side"
          : after()
            ? "after"
            : "before"
    const [mode, setMode] = createSignal<ComparisonMode>(initial)
    const [position, setPosition] = createSignal(50)
    const modes = (): {
        id: ComparisonMode
        label: string
        enabled: boolean
    }[] => [
        {
            id: "side-by-side",
            label: "Side by side",
            enabled: Boolean(before() && after()),
        },
        {
            id: "slider",
            label: "Slider",
            enabled: Boolean(before() && after()),
        },
        { id: "diff", label: "Diff", enabled: Boolean(diff()) },
        { id: "before", label: "Before", enabled: Boolean(before()) },
        { id: "after", label: "After", enabled: Boolean(after()) },
    ]
    const singleImage = () =>
        mode() === "diff" ? diff() : mode() === "before" ? before() : after()

    return (
        <article class="overflow-hidden">
            <header class="flex flex-wrap items-center gap-3 px-5 py-4">
                <strong class="font-mono text-sm">
                    {props.comparison.scenario}
                </strong>
                <span class="badge px-2 py-0.5 capitalize">
                    {props.comparison.status}
                </span>
                <Show when={props.comparison.percentChanged !== null}>
                    <span class="caption muted">
                        {props.comparison.percentChanged!.toFixed(2)}% of pixels
                    </span>
                </Show>
                <div
                    role="group"
                    aria-label="Comparison view"
                    class="segmented inset ml-auto flex flex-wrap gap-1 p-1"
                >
                    <For each={modes()}>
                        {(option) => (
                            <button
                                class="px-3 py-2"
                                aria-pressed={
                                    option.id === mode() ? "true" : "false"
                                }
                                disabled={!option.enabled}
                                onClick={() => setMode(option.id)}
                            >
                                {option.label}
                            </button>
                        )}
                    </For>
                </div>
            </header>
            <Show when={props.comparison.description}>
                <p class="px-5 pt-4 description">
                    {props.comparison.description}
                </p>
            </Show>
            <div class="p-5">
                <Show when={mode() === "side-by-side"}>
                    <div class="grid gap-4 xl:grid-cols-2">
                        <figure>
                            <figcaption class="mb-2 text-xs font-semibold text-slate-400">
                                Before
                            </figcaption>
                            <img
                                class="framed w-full"
                                src={before()!}
                                alt={`${props.comparison.scenario} before`}
                            />
                        </figure>
                        <figure>
                            <figcaption class="mb-2 text-xs font-semibold text-slate-400">
                                After
                            </figcaption>
                            <img
                                class="framed w-full"
                                src={after()!}
                                alt={`${props.comparison.scenario} after`}
                            />
                        </figure>
                    </div>
                </Show>
                <Show when={mode() === "slider"}>
                    <div>
                        <div class="framed relative overflow-hidden">
                            <img
                                class="block w-full"
                                src={before()!}
                                alt={`${props.comparison.scenario} before`}
                            />
                            <img
                                class="absolute inset-0 block h-full w-full"
                                style={{
                                    "clip-path": `inset(0 ${100 - position()}% 0 0)`,
                                }}
                                src={after()!}
                                alt={`${props.comparison.scenario} after`}
                            />
                            <div
                                class="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow"
                                style={{ left: `${position()}%` }}
                            >
                                <span class="absolute left-1/2 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-blue-600 shadow-lg" />
                            </div>
                        </div>
                        <input
                            class="mt-4 w-full accent-blue-500"
                            type="range"
                            min="0"
                            max="100"
                            value={position()}
                            onInput={(event) =>
                                setPosition(Number(event.currentTarget.value))
                            }
                            aria-label="Reveal the after image"
                        />
                        <p class="mt-1 text-center caption muted">
                            Left of the handle is after; right is before.
                        </p>
                    </div>
                </Show>
                <Show when={mode() !== "side-by-side" && mode() !== "slider"}>
                    <Show
                        when={singleImage()}
                        fallback={
                            <div class="empty outlined p-[2.5rem]">
                                This image was not captured.
                            </div>
                        }
                    >
                        {(src) => (
                            <img
                                class="framed block w-full"
                                src={src()}
                                alt={`${props.comparison.scenario} ${mode()}`}
                            />
                        )}
                    </Show>
                </Show>
            </div>
        </article>
    )
}
