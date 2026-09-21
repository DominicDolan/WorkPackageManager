import { issueLinkRows } from "./issueLinks"
import { readIssue } from "./issues"
import { noteLinkRows } from "./noteLinks"
import { readNote } from "./notes"
import type { WorkPackageReference } from "../shared/types"

/** More than the largest card can show, so a preview never runs out early. */
const PREVIEW_CHARS = 4000

/** Readable characters in a body, so markup does not make a card look long. */
function textLength(body: string, format: "markdown" | "html"): number {
    const text =
        format === "html"
            ? body.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ")
            : body
    return text.replace(/\s+/g, " ").trim().length
}

/**
 * The notes and issues attached to a work package, as one collection, newest
 * attachment first.
 *
 * Each file is read on every request, like the note list. A link whose file
 * has since gone is left out rather than drawn as a card that cannot open.
 */
export function workPackageReferences(
    workPackageRef: string,
): WorkPackageReference[] {
    const notes = noteLinkRows("work-package", workPackageRef).flatMap(
        ({ path, attachedAt }): WorkPackageReference[] => {
            try {
                const {
                    body,
                    attachments: _attachments,
                    ...note
                } = readNote(path)
                return [
                    {
                        kind: "note",
                        note,
                        attachedAt,
                        preview: body.slice(0, PREVIEW_CHARS),
                        previewFormat: "markdown",
                        length: textLength(body, "markdown"),
                    },
                ]
            } catch {
                return []
            }
        },
    )
    const issues = issueLinkRows(workPackageRef).flatMap(
        ({ id, attachedAt }): WorkPackageReference[] => {
            try {
                const { body, bodyFormat, raw: _raw, ...issue } = readIssue(id)
                return [
                    {
                        kind: "issue",
                        issue,
                        attachedAt,
                        preview: body.slice(0, PREVIEW_CHARS),
                        previewFormat: bodyFormat,
                        length: textLength(body, bodyFormat),
                    },
                ]
            } catch {
                return []
            }
        },
    )
    return [...notes, ...issues].sort((left, right) =>
        right.attachedAt.localeCompare(left.attachedAt),
    )
}
