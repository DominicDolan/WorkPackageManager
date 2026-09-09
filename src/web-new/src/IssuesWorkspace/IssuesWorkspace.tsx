import { For, Loading, Show, createMemo, createSignal, refresh } from "solid-js"
import {
  ISSUE_SOURCE_LABELS,
  type IssueDetail,
  type IssueState,
  type IssueSummary,
} from "@shared/types"
import { api } from "../../../web/api"
import { PageSkeleton } from "../components/PageSkeleton"
import { ProductRail } from "../components/ProductRail"
import { BackIcon } from "../components/icons"
import type { MainView } from "../types/navigation"
import layoutStyles from "../components/LibraryLayout.module.css"
import styles from "./IssuesWorkspace.module.css"

export function IssuesWorkspace(props: { select: (view: MainView) => void }) {
  const [query, setQuery] = createSignal("")
  const [state, setState] = createSignal<IssueState | "all">("all")
  const [source, setSource] = createSignal("")
  const [label, setLabel] = createSignal("")
  const [selectedId, setSelectedId] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const listing = createMemo(() =>
    api.listIssues({
      q: query() || undefined,
      state: state(),
      source: source() || undefined,
      label: label() || undefined,
    }),
  )
  const selected = createMemo(async (): Promise<IssueDetail | null> =>
    selectedId() ? api.getIssue(selectedId()) : null,
  )
  const choose = (id: string) => {
    setSelectedId(id)
    refresh(selected)
  }
  const sync = async () => {
    setBusy(true)
    setError("")
    try {
      await api.pullNotes()
      refresh(listing)
      refresh(selected)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  const push = async () => {
    setBusy(true)
    setError("")
    try {
      await api.syncNotes(true)
      refresh(listing)
      refresh(selected)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main
      class={`${layoutStyles.scope} ${styles.scope} app-shell min-h-screen text-slate-950`}
    >
      <ProductRail active="issues" select={props.select} />
      <Loading fallback={<PageSkeleton />}>
        <Show when={listing()} keyed>
          {(data) => (
            <section class="library-surface">
              <header class="library-header">
                <div>
                  <p class="eyebrow">Imported context</p>
                  <h1>Issues</h1>
                  <p>
                    Review provider records from the notes folder. This view
                    never writes back to the tracker.
                  </p>
                </div>
                <div class="library-header-actions">
                  <Show when={data.notes.exists && data.notes.git.repo}>
                    <button class="button" disabled={busy()} onClick={sync}>
                      {busy() ? "Syncing…" : "Sync"}
                    </button>
                    <button
                      class="button"
                      disabled={busy() || !data.notes.git.upstream}
                      title={
                        data.notes.git.upstream ??
                        "No upstream configured for this repository."
                      }
                      onClick={push}
                    >
                      {busy() ? "Pushing…" : "Push"}
                    </button>
                  </Show>
                </div>
              </header>
              <Show when={error()}>
                <p class="banner mb-5">{error()}</p>
              </Show>
              <div class="library-layout">
                <aside class="library-list">
                  <label class="library-search">
                    <span>Find an issue</span>
                    <input
                      value={query()}
                      onInput={(event) => setQuery(event.currentTarget.value)}
                      placeholder="Search issues"
                      type="search"
                    />
                  </label>
                  <div class="library-filters">
                    <select
                      value={state()}
                      onChange={(event) =>
                        setState(
                          event.currentTarget.value as IssueState | "all",
                        )
                      }
                    >
                      <option value="all">All states</option>
                      <option value="open">Open</option>
                      <option value="closed">Closed</option>
                    </select>
                    <Show when={data.facets.sources.length > 1}>
                      <select
                        value={source()}
                        onChange={(event) =>
                          setSource(event.currentTarget.value)
                        }
                      >
                        <option value="">All sources</option>
                        <For each={data.facets.sources}>
                          {(item) => (
                            <option value={item.source}>
                              {ISSUE_SOURCE_LABELS[item.source] ?? item.source}{" "}
                              ({item.count})
                            </option>
                          )}
                        </For>
                      </select>
                    </Show>
                    <Show when={data.facets.labels.length}>
                      <select
                        value={label()}
                        onChange={(event) =>
                          setLabel(event.currentTarget.value)
                        }
                      >
                        <option value="">All labels</option>
                        <For each={data.facets.labels}>
                          {(item) => <option value={item}>{item}</option>}
                        </For>
                      </select>
                    </Show>
                  </div>
                  <p class="issue-total">
                    {data.issues.length} of {data.facets.total} shown
                  </p>
                </aside>
                <section class="issue-board">
                  <Loading fallback={<PageSkeleton compact />}>
                    <Show
                      when={selected()}
                      keyed
                      fallback={
                        <For
                          each={data.issues}
                          fallback={
                            <div class="library-empty">
                              <h2>No issues found</h2>
                              <p>
                                Place provider JSON files in the notes folder to
                                see them here.
                              </p>
                            </div>
                          }
                        >
                          {(issue) => (
                            <IssueCard
                              issue={issue}
                              open={() => choose(issue.id)}
                            />
                          )}
                        </For>
                      }
                    >
                      {(issue) => (
                        <IssueDetailPane
                          issue={issue}
                          back={() => setSelectedId("")}
                        />
                      )}
                    </Show>
                  </Loading>
                </section>
              </div>
            </section>
          )}
        </Show>
      </Loading>
    </main>
  )
}

function IssueCard(props: { issue: IssueSummary; open: () => void }) {
  return (
    <button class="issue-card" onClick={props.open}>
      <div>
        <span class="source-badge">
          {ISSUE_SOURCE_LABELS[props.issue.source] ?? props.issue.source}
        </span>
        <span class="issue-key">{props.issue.key}</span>
        <span class={`issue-state issue-${props.issue.state}`}>
          {props.issue.stateLabel}
        </span>
      </div>
      <h2>{props.issue.title}</h2>
      <p>
        {props.issue.excerpt || props.issue.container || "No summary provided."}
      </p>
      <footer>
        {props.issue.labels.slice(0, 3).map((label) => (
          <span>{label.name}</span>
        ))}
      </footer>
    </button>
  )
}

function IssueDetailPane(props: { issue: IssueDetail; back: () => void }) {
  const [raw, setRaw] = createSignal(false)
  return (
    <article class="issue-detail-pane">
      <button class="back-link" onClick={props.back}>
        <BackIcon />
        All issues
      </button>
      <header>
        <div>
          <span class="source-badge">
            {ISSUE_SOURCE_LABELS[props.issue.source] ?? props.issue.source}
          </span>
          <span class="issue-key">{props.issue.key}</span>
          <h2>{props.issue.title}</h2>
        </div>
        <Show when={props.issue.url}>
          {(url) => (
            <a
              class="button-primary"
              href={url()}
              target="_blank"
              rel="noreferrer"
            >
              Open source
            </a>
          )}
        </Show>
      </header>
      <dl class="issue-details">
        <div>
          <dt>State</dt>
          <dd>{props.issue.stateLabel}</dd>
        </div>
        <div>
          <dt>Assigned</dt>
          <dd>
            {props.issue.assignees.map((person) => person.name).join(", ") ||
              "Unassigned"}
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>
            {props.issue.updatedAt
              ? new Date(props.issue.updatedAt).toLocaleDateString()
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Comments</dt>
          <dd>{props.issue.commentCount ?? "—"}</dd>
        </div>
      </dl>
      <section class="issue-body">
        <h3>Description</h3>
        <pre>{props.issue.body || "No description."}</pre>
      </section>
      <button class="button" onClick={() => setRaw(!raw())}>
        {raw() ? "Hide raw JSON" : "Show raw JSON"}
      </button>
      <Show when={raw()}>
        <pre class="raw-json">{JSON.stringify(props.issue.raw, null, 2)}</pre>
      </Show>
    </article>
  )
}
