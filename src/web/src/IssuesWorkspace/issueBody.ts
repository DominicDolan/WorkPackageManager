import type { IssueDetail } from "@shared/types"
import { renderMarkdown, type MarkdownOptions } from "../markdown"

/**
 * An issue's description as safe HTML for the detail pane.
 *
 * GitHub bodies are Markdown and go through the notes renderer. Azure DevOps
 * descriptions are HTML written by somebody else's rich-text editor, so they are
 * parsed inert and rebuilt from an allowlist: no scripts, no event handlers, no
 * inline styles (a dark editor theme pasted in would otherwise paint the pane),
 * and only links and images with an absolute http(s) address.
 *
 * One HTML case is really Markdown. Text copied out of a code editor and pasted
 * into Azure DevOps arrives as a `<div>` per line with coloured spans, so the
 * `##` and `**` are still literal. HTML made of nothing but that line markup,
 * whose text reads as Markdown, is flattened back to its lines and rendered as
 * the Markdown it was written as.
 */
export function renderIssueBody(issue: IssueDetail): string {
    return renderRichBody(issue.body, issue.bodyFormat)
}

/** The same, for any body in either format — a work package's reference cards
 *  draw notes and issues alike. `options` reaches the Markdown renderer. */
export function renderRichBody(
    body: string,
    format: "markdown" | "html",
    options: MarkdownOptions = {},
): string {
    if (!body.trim()) return ""
    if (format === "markdown") return renderMarkdown(body, options)

    const document = new DOMParser().parseFromString(body, "text/html")
    if (onlyLineMarkup(document.body)) {
        const text = linesOf(document.body)
        if (looksLikeMarkdown(text)) return renderMarkdown(text, options)
    }
    const clean = document.createElement("div")
    for (const child of [...document.body.childNodes])
        appendSanitized(clean, child)
    return clean.innerHTML
}

/** Tags an editor uses to lay out lines, as opposed to meaning anything. */
const LINE_TAGS = new Set(["DIV", "SPAN", "BR", "P", "FONT", "B", "STRONG"])

function onlyLineMarkup(root: Element): boolean {
    return [...root.querySelectorAll("*")].every((element) =>
        LINE_TAGS.has(element.tagName),
    )
}

const BLOCK_TAGS = new Set(["DIV", "P"])

/** The text, one line per block and per `<br>`, as the editor showed it. */
function linesOf(root: Element): string {
    let out = ""
    const breakLine = () => {
        if (out && !out.endsWith("\n")) out += "\n"
    }
    const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            out += (node.textContent ?? "").replace(/\u00a0/g, " ")
            return
        }
        if (!(node instanceof Element)) return
        if (node.tagName === "BR") {
            out += "\n"
            return
        }
        const block = BLOCK_TAGS.has(node.tagName)
        if (block) breakLine()
        for (const child of node.childNodes) walk(child)
        if (block) breakLine()
    }
    walk(root)
    return out
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
}

function looksLikeMarkdown(text: string): boolean {
    return (
        /^ {0,3}(#{1,6} |[-*+] |\d+\. |> |```)/m.test(text) ||
        /\*\*[^*\n]+\*\*/.test(text) ||
        /`[^`\n]+`/.test(text)
    )
}

/** Kept, with their children. */
const ALLOWED = new Set([
    "A",
    "B",
    "BLOCKQUOTE",
    "BR",
    "CAPTION",
    "CODE",
    "DD",
    "DEL",
    "DIV",
    "DL",
    "DT",
    "EM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HR",
    "I",
    "IMG",
    "LI",
    "OL",
    "P",
    "PRE",
    "S",
    "SPAN",
    "STRIKE",
    "STRONG",
    "SUB",
    "SUP",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "U",
    "UL",
])

/** Dropped with everything inside them. Anything else unknown is unwrapped. */
const DROPPED = new Set([
    "BUTTON",
    "EMBED",
    "FORM",
    "HEAD",
    "IFRAME",
    "INPUT",
    "LINK",
    "MATH",
    "META",
    "NOSCRIPT",
    "OBJECT",
    "SCRIPT",
    "SELECT",
    "STYLE",
    "SVG",
    "TEMPLATE",
    "TEXTAREA",
    "TITLE",
])

function safeUrl(value: string | null): string | null {
    if (!value) return null
    try {
        const url = new URL(value.trim())
        return url.protocol === "https:" || url.protocol === "http:"
            ? url.href
            : null
    } catch {
        return null
    }
}

function appendSanitized(parent: Element, node: Node): void {
    const document = parent.ownerDocument
    if (node.nodeType === Node.TEXT_NODE) {
        parent.append(document.createTextNode(node.textContent ?? ""))
        return
    }
    if (!(node instanceof Element) || DROPPED.has(node.tagName)) return
    if (!ALLOWED.has(node.tagName)) {
        for (const child of [...node.childNodes]) appendSanitized(parent, child)
        return
    }

    const copy = document.createElement(node.tagName.toLowerCase())
    if (node.tagName === "A") {
        const href = safeUrl(node.getAttribute("href"))
        if (href) {
            copy.setAttribute("href", href)
            copy.setAttribute("target", "_blank")
            copy.setAttribute("rel", "noreferrer")
        }
    } else if (node.tagName === "IMG") {
        const src = safeUrl(node.getAttribute("src"))
        if (!src) return
        copy.setAttribute("src", src)
        copy.setAttribute("alt", node.getAttribute("alt") ?? "")
        copy.setAttribute("loading", "lazy")
    } else if (node.tagName === "TD" || node.tagName === "TH") {
        for (const name of ["colspan", "rowspan"]) {
            const value = node.getAttribute(name)
            if (value && /^\d+$/.test(value)) copy.setAttribute(name, value)
        }
    }
    for (const child of [...node.childNodes]) appendSanitized(copy, child)
    parent.append(copy)
}
