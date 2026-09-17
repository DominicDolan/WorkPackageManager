import type { NotesWorkspaceInfo } from "@shared/types"
import { Show } from "solid-js"

export function NotesStatus(props: {
    workspace: NotesWorkspaceInfo
    busy: boolean
    initialising: boolean
    initialise: () => Promise<void>
}) {
    return (
        <footer class="status mt-auto p-[1rem] [&_p]:m-[0_0_0.5rem] [&_p]:overflow-hidden max-[820px]:hidden">
            <p>{props.workspace.dir}</p>
            <Show
                when={!props.workspace.exists}
                fallback={
                    <>
                        <p>
                            {props.workspace.git.repo
                                ? `${props.workspace.git.branch ?? "Detached"} · ${props.workspace.git.dirty ? `${props.workspace.git.dirty} uncommitted` : "clean"}`
                                : "Not yet a Git repository"}
                        </p>
                    </>
                }
            >
                <p>The notes folder does not exist yet.</p>
                <button
                    class="primary"
                    disabled={props.busy}
                    aria-busy={props.initialising ? "true" : "false"}
                    onClick={props.initialise}
                >
                    Create folder
                </button>
            </Show>
        </footer>
    )
}
