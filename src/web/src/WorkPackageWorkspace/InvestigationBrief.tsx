import { type InvestigationDetail } from "@shared/types"
import { action, createOptimistic, createSignal } from "solid-js"
import { api } from "../api"
import { useError } from "../hooks/useError"

export function InvestigationBrief(props: {
    investigation: InvestigationDetail
    saved: () => void
}) {
    const [brief, setBrief] = createSignal(props.investigation.brief)
    const [busy, setBusy] = createOptimistic(false)
    const [saved, setSaved] = createSignal(false)
    const { handle, hasError, Banner } = useError()
    const save = action(function* () {
        if (busy()) return

        setBusy(true)
        setSaved(false)
        yield handle(() =>
            api.updateInvestigation(props.investigation.ref, {
                brief: brief(),
            }),
        )
        if (hasError()) return
        props.saved()
        setSaved(true)
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
            <Banner />
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
