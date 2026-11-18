import { createClient } from "@work-task-manager/client"

export type {
    IssueListing,
    Meta,
    NewBranchInput,
    NoteListing,
} from "@work-task-manager/client"

/** This UI is always served from (or proxied to) the API's own origin. */
export const api = createClient()

export const { noteAssetUrl, imageUrl, taskAssetUrl } = api
