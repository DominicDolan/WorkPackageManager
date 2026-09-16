import { type InvestigationDetail } from "@shared/types"
import { Show, createSignal } from "solid-js"
import { api } from "../api"

export function InvestigationBrief(props: {
    investigation: InvestigationDetail
    saved: () => void
}) {
    const [brief, setBrief] = createSignal(props.investigation.brief)
    const [busy, setBusy] = createSignal(false)
    const [saved, setSaved] = createSignal(false)
    const [error, setError] = createSignal("")
    const save = async () => {
        setBusy(true)
        setSaved(false)
        setError("")
        try {
            await api.updateInvestigation(props.investigation.ref, {
                brief: brief(),
            })
            props.saved()
            setSaved(true)
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }
    return (
        <div class="investigation-brief p-[1.5rem] [&_textarea]:min-h-[13rem] [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>div]:gap-[1rem] [&>div]:mt-[0.75rem]">
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
                    class="outlined"
                    disabled={busy() || brief() === props.investigation.brief}
                    onClick={save}
                >
                    {busy() ? "Saving…" : "Save brief"}
                </button>
            </div>
        </div>
    )
}
