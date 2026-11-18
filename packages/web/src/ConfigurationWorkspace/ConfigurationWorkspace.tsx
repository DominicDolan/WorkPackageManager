import {
    MODEL_TIERS,
    MODEL_TIER_LABELS,
    type ModelTier,
} from "@work-task-manager/shared"
import { For, Loading, Show, createEffect, createSignal } from "solid-js"
import { api } from "../api"
import { createQuery } from "../hooks/createQuery"
import { PageSkeleton } from "../components/PageSkeleton"
import { ProductRail } from "../components/ProductRail"
import type { MainView } from "../types/navigation"

function parseObject(content: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(content)
        return typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null
    } catch {
        return null
    }
}

export function ConfigurationWorkspace(props: {
    select: (view: MainView) => void
}) {
    const data = createQuery(async () => {
        const [file, environment] = await Promise.all([
            api.configFile(),
            api.agentEnvironment(),
        ])
        const catalogues = await Promise.all(
            environment.harnesses.map(
                async (harness) =>
                    [
                        harness.id,
                        await api.agentModels(harness.id).catch(() => []),
                    ] as const,
            ),
        )
        return {
            content: file.content,
            harnesses: environment.harnesses,
            catalogues: Object.fromEntries(catalogues),
        }
    })
    const [content, setContent] = createSignal("")
    const [initialized, setInitialized] = createSignal(false)
    const [saving, setSaving] = createSignal(false)
    const [error, setError] = createSignal("")
    const [saved, setSaved] = createSignal(false)
    createEffect(
        () => data.value,
        (current) => {
            if (current && !initialized()) {
                setContent(current.content)
                setInitialized(true)
            }
        },
    )

    const updateTier = (harness: string, tier: ModelTier, model: string) => {
        const config = parseObject(content())
        if (!config) return
        const tiers = {
            ...((config.modelTiers as
                Record<string, Record<string, string>> | undefined) ?? {}),
        }
        const harnessTiers = { ...(tiers[harness] ?? {}) }
        if (model) harnessTiers[tier] = model
        else delete harnessTiers[tier]
        if (Object.keys(harnessTiers).length) tiers[harness] = harnessTiers
        else delete tiers[harness]
        config.modelTiers = tiers
        setContent(`${JSON.stringify(config, null, 4)}\n`)
        setSaved(false)
        setError("")
    }

    const save = async () => {
        if (saving()) return
        setSaving(true)
        setError("")
        setSaved(false)
        try {
            const response = await api.saveConfigFile(content())
            setContent(response.content)
            setSaved(true)
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setSaving(false)
        }
    }

    return (
        <Loading fallback={<PageSkeleton />}>
            <Show when={data.value}>
                {(current) => {
                    const currentConfig = () => parseObject(content())
                    const currentModel = (harness: string, tier: ModelTier) => {
                        const modelTiers = currentConfig()?.modelTiers as
                            Record<string, Record<string, string>> | undefined
                        return modelTiers?.[harness]?.[tier] ?? ""
                    }
                    return (
                        <main class="app-shell min-h-screen text-slate-950 grid grid-cols-[220px_minmax(0,_1fr)] max-[820px]:block">
                            <ProductRail
                                active="configuration"
                                select={props.select}
                            />
                            <section class="work-surface min-w-0 p-[2.2rem_clamp(1.3rem,_3.5vw,_4.5rem)_4rem] max-[820px]:w-full max-[820px]:min-w-0 max-[820px]:p-[1.25rem]">
                                <div class="max-w-[1100px] m-auto">
                                    <header class="mb-8">
                                        <p class="eyebrow m-0">
                                            Workspace settings
                                        </p>
                                        <h1 class="mt-2">Configuration</h1>
                                        <p class="description">
                                            Edit{" "}
                                            <code>
                                                .tasks/tasks.config.json
                                            </code>
                                            . Choose the model each harness
                                            should use for recommended task
                                            tiers.
                                        </p>
                                    </header>

                                    <section class="mb-8">
                                        <h2>Recommended model tiers</h2>
                                        <p class="hint">
                                            These choices map a task's Fast,
                                            Standard, or Frontier recommendation
                                            to a model available in that
                                            harness.
                                        </p>
                                        <div class="grid gap-4">
                                            <For each={current().harnesses}>
                                                {(harness) => {
                                                    const models = () =>
                                                        current().catalogues[
                                                            harness.id
                                                        ] ?? []
                                                    return (
                                                        <article class="choice grid gap-3 p-4">
                                                            <div class="flex items-center justify-between gap-3">
                                                                <h3 class="m-0">
                                                                    {
                                                                        harness.label
                                                                    }
                                                                </h3>
                                                                <span class="caption muted">
                                                                    {harness.available
                                                                        ? "Available"
                                                                        : "Not installed"}
                                                                </span>
                                                            </div>
                                                            <div class="grid grid-cols-3 gap-3 max-[700px]:grid-cols-1">
                                                                <For
                                                                    each={
                                                                        MODEL_TIERS
                                                                    }>
                                                                    {(tier) => {
                                                                        const selected =
                                                                            () =>
                                                                                currentModel(
                                                                                    harness.id,
                                                                                    tier,
                                                                                )
                                                                        return (
                                                                            <label class="field">
                                                                                <span>
                                                                                    {
                                                                                        MODEL_TIER_LABELS[
                                                                                            tier
                                                                                        ]
                                                                                    }
                                                                                </span>
                                                                                <select
                                                                                    value={selected()}
                                                                                    disabled={
                                                                                        !parseObject(
                                                                                            content(),
                                                                                        )
                                                                                    }
                                                                                    onChange={(
                                                                                        event,
                                                                                    ) =>
                                                                                        updateTier(
                                                                                            harness.id,
                                                                                            tier,
                                                                                            event
                                                                                                .currentTarget
                                                                                                .value,
                                                                                        )
                                                                                    }>
                                                                                    <option value="">
                                                                                        Use
                                                                                        harness
                                                                                        default
                                                                                    </option>
                                                                                    <Show
                                                                                        when={
                                                                                            selected() &&
                                                                                            !models().some(
                                                                                                (
                                                                                                    model,
                                                                                                ) =>
                                                                                                    model.id ===
                                                                                                    selected(),
                                                                                            )
                                                                                        }>
                                                                                        <option
                                                                                            value={selected()}>
                                                                                            {selected()}{" "}
                                                                                            (configured)
                                                                                        </option>
                                                                                    </Show>
                                                                                    <For
                                                                                        each={models()}>
                                                                                        {(
                                                                                            model,
                                                                                        ) => (
                                                                                            <option
                                                                                                value={
                                                                                                    model.id
                                                                                                }>
                                                                                                {model.label ||
                                                                                                    model.id}
                                                                                            </option>
                                                                                        )}
                                                                                    </For>
                                                                                </select>
                                                                            </label>
                                                                        )
                                                                    }}
                                                                </For>
                                                            </div>
                                                        </article>
                                                    )
                                                }}
                                            </For>
                                        </div>
                                    </section>

                                    <section>
                                        <div class="flex items-center justify-between gap-4">
                                            <h2 class="m-0">Config file</h2>
                                            <button
                                                class="primary"
                                                disabled={saving()}
                                                onClick={save}>
                                                {saving()
                                                    ? "Saving…"
                                                    : "Save configuration"}
                                            </button>
                                        </div>
                                        <p class="hint mt-2">
                                            Edit any supported setting as JSON.
                                            Changes to model tiers apply to new
                                            task runs immediately; settings that
                                            affect server startup may require
                                            restarting the server.
                                        </p>
                                        <textarea
                                            class="mt-3 min-h-[28rem] w-full font-mono text-sm"
                                            spellcheck={false}
                                            value={content()}
                                            onInput={(event) => {
                                                setContent(
                                                    event.currentTarget.value,
                                                )
                                                setSaved(false)
                                                setError("")
                                            }}
                                            aria-label="tasks.config.json contents"
                                        />
                                        <Show when={!parseObject(content())}>
                                            <p class="hint mt-2 text-red-700">
                                                The config editor must contain a
                                                valid JSON object before model
                                                tier selectors or saving can be
                                                used.
                                            </p>
                                        </Show>
                                        <Show when={error()}>
                                            <p class="hint mt-2 text-red-700">
                                                {error()}
                                            </p>
                                        </Show>
                                        <Show when={saved()}>
                                            <p class="hint mt-2">
                                                Configuration saved.
                                            </p>
                                        </Show>
                                    </section>
                                </div>
                            </section>
                        </main>
                    )
                }}
            </Show>
        </Loading>
    )
}
