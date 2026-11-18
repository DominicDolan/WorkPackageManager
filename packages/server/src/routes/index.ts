import { createRouter, route } from "../router"
import { agentRoutes } from "./agents"
import { baselineRoutes } from "./baselines"
import { branchRoutes } from "./branches"
import { investigationRoutes } from "./investigations"
import { issueRoutes } from "./issues"
import { metaRoutes } from "./meta"
import { noteRoutes } from "./notes"
import { taskRoutes } from "./tasks"
import { transcriptRoutes } from "./transcripts"
import { workPackageRoutes } from "./workPackages"

export { API_VERSION } from "./meta"

/** Every route the API serves, in the order `GET /api/routes` lists them. */
export const routes = [
    ...metaRoutes,
    ...workPackageRoutes,
    ...taskRoutes,
    ...investigationRoutes,
    ...branchRoutes,
    ...agentRoutes,
    ...noteRoutes,
    ...issueRoutes,
    ...transcriptRoutes,
    ...baselineRoutes,
]

export const router = createRouter([
    ...routes,
    route(
        "GET",
        "/routes",
        "This list: every route's method, path and summary.",
        () => ({
            routes: router.describe(),
        }),
    ),
])
