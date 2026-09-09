import { onBeforeUnmount, onMounted, ref } from "vue"

/**
 * Tiny history-backed location state for this single-page app. It deliberately
 * only owns the pathname: views use it as their route and Vue renders the
 * matching pane without requiring a router dependency.
 */
export function useLocation() {
  const location = ref(window.location.pathname)

  const syncFromBrowser = () => {
    location.value = window.location.pathname
  }

  const navigate = (path: string): void => {
    const target = path.startsWith("/") ? path : `/${path}`
    if (target === location.value) return
    window.history.pushState({}, "", target)
    location.value = target
  }

  onMounted(() => window.addEventListener("popstate", syncFromBrowser))
  onBeforeUnmount(() => window.removeEventListener("popstate", syncFromBrowser))

  return { location, navigate }
}
