import { type InvestigationDetail } from "@shared/types"
import { action, createOptimistic, Show, createSignal } from "solid-js"
import { api } from "../api"

export function InvestigationBrief(props: {
    investigation: InvestigationDetail
    saved: () => void
}) {
    const [brief, setBrief] = createSignal(props.investigation.brief)
    const [busy, setBusy] = createOptimistic(false)
    const [saved, setSaved] = createSignal(false)
    const [error, setError] = createSignal("")
    const save = action(function* () {
        if (busy()) return

        setBusy(true)
        setSaved(false)
        setError("")
        try {
            yield api.updateInvestigation(props.investigation.ref, {
                brief: brief(),
            })

            props.saved()
            setSaved(true)
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        }
    })
    return (
        <div class="investigation-brief p-6 [&_textarea]:min-h-52 [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>div]:gap-4 [&>div]:mt-3">
            <label class="field">
                <span>Investigation brief</span>
                <textarea
                    value={brief()}
                    onInput={(event) => {
                        setBrief(event.currentTarget.value)
                        setSaved(false)
                    }}
                    placeholder="Describe what the agent should investigate, where to start, and what a useful answer should cover."
                />
            </label>
            <Show when={error()}>
                <p class="notice error mt-4">{error()}</p>
            </Show>
            <div>
                <span>
                    {saved() ? "Saved" : `${brief().length} characters`}
                </span>
                <button
                    aria-busy={busy() ? "true" : "false"}
                    class="outlined"
                    disabled={busy() || brief() === props.investigation.brief}
                    onClick={save}>
                    Save brief
                </button>
            </div>
        </div>
    )
}
