import { createSignal, Show, type Accessor, type Element } from "solid-js"

type ErrorView = (message: Accessor<string>) => Element

type ErrorViews = Record<string, ErrorView>

type NamedViews<Views extends ErrorViews> = {
    [
        Key in keyof Views as Key extends string ? Capitalize<Key> : never
    ]: () => Element
}

/** Create a component-local error state with one or more presentation views. */
export function defineErrorHandling<const Views extends ErrorViews>(
    views: Views,
) {
    return function useErrorHandling() {
        const [message, setMessage] = createSignal("")

        const presentation = Object.fromEntries(
            Object.entries(views).map(([name, render]) => {
                const component = () => (
                    <Show when={message()}>{render(message)}</Show>
                )
                return [name[0].toUpperCase() + name.slice(1), component]
            }),
        ) as NamedViews<Views>

        const clear = () => setMessage("")

        async function handle<T>(
            request: () => T | Promise<T>,
        ): Promise<T | undefined> {
            clear()
            try {
                return await request()
            } catch (caught) {
                capture(caught)
                return undefined
            }
        }

        function capture(caught: unknown) {
            setMessage(
                caught instanceof Error ? caught.message : String(caught),
            )
        }

        return {
            handle,
            capture,
            message,
            hasError: () => message().length > 0,
            clear,
            ...presentation,
        }
    }
}

export const useError = defineErrorHandling({
    banner: (message) => <p class="notice error mt-4">{message()}</p>,
})
