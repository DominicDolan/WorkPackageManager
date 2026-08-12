/**
 * A small Markdown renderer for the notes preview.
 *
 * Written rather than installed on purpose. The package ships one runtime
 * dependency (Vue) and the SPA is served off disk by a bun process; adding a
 * parser and a sanitiser to render prose that this app itself wrote would be the
 * largest thing in the bundle. What notes actually use — headings, emphasis,
 * lists, code, quotes, tables, links and images — is all here, and anything
 * beyond it degrades to plain text rather than breaking.
 *
 * Escaping happens *before* any rule runs, so the only tags in the output are
 * the ones this file emits. That is what makes it safe to feed a note written by
 * hand, by an agent, or pulled from someone else's clone into `v-html`.
 */

export interface MarkdownOptions {
  /**
   * Rewrite a relative link or image path into something the browser can fetch.
   * Notes link their attachments relatively (`./attachments/x/shot.png`) so the
   * files keep working in any other Markdown reader; the preview needs those
   * pointed at the API instead.
   */
  resolveLink?: (href: string) => string | null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Absolute URLs, protocol-relative URLs and in-page anchors are left alone. */
function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#');
}

function href(raw: string, options: MarkdownOptions): string {
  const trimmed = raw.trim();
  // `javascript:` and `data:` are the two schemes that turn a link into a script
  // tag by another name.
  if (/^(javascript|data|vbscript):/i.test(trimmed)) return '#';
  if (isExternal(trimmed)) return trimmed;
  return options.resolveLink?.(trimmed) ?? trimmed;
}

/** Inline rules, applied to already-escaped text. */
function inline(text: string, options: MarkdownOptions): string {
  // Code spans are lifted out first so nothing else rewrites their contents.
  // Their placeholder is delimited by null bytes, which escaped text cannot hold.
  const codes: string[] = [];
  let output = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  output = output
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt: string, source: string) =>
      `<img src="${href(source, options)}" alt="${alt}" loading="lazy" />`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label: string, target: string) => {
      const url = href(target, options);
      const external = isExternal(url) && !url.startsWith('#');
      return `<a href="${url}"${external ? ' target="_blank" rel="noreferrer noopener"' : ''}>${label}</a>`;
    })
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(^|[\s(])([*_])(?=\S)([^*_]*?\S)\2/g, '$1<em>$3</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|\s)(#[a-z0-9][\w-]*)/gi, '$1<span class="md-tag">$2</span>');

  return output.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => `<code>${codes[Number(index)]}</code>`);
}

interface ListFrame {
  ordered: boolean;
  indent: number;
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  const lines = escapeHtml(source.replace(/\r\n?/g, '\n')).split('\n');
  const html: string[] = [];
  const lists: ListFrame[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join(' '), options)}</p>`);
    paragraph = [];
  };

  const closeLists = (toIndent = -1): void => {
    while (lists.length && lists[lists.length - 1]!.indent > toIndent) {
      html.push(lists.pop()!.ordered ? '</ol>' : '</ul>');
    }
  };

  const flushQuote = (): void => {
    if (!quote.length) return;
    // Quoted content is Markdown too, so it goes back through the whole renderer.
    html.push(`<blockquote>${renderMarkdown(quote.join('\n'), options)}</blockquote>`);
    quote = [];
  };

  const flushBlocks = (): void => {
    flushParagraph();
    closeLists();
    flushQuote();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    /* ------------------------------------------------------------ fences */
    const fence = /^\s*(?:```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushBlocks();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*(?:```|~~~)\s*$/.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      const language = fence[1] ? ` class="language-${fence[1]}"` : '';
      html.push(`<pre><code${language}>${code.join('\n')}</code></pre>`);
      continue;
    }

    /* ------------------------------------------------------------- quote */
    const quoted = /^\s*&gt;\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      closeLists();
      quote.push(quoted[1]!);
      continue;
    }
    flushQuote();

    /* ------------------------------------------------------------ blanks */
    if (!line.trim()) {
      flushParagraph();
      closeLists();
      continue;
    }

    /* -------------------------------------------------------------- rule */
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushBlocks();
      html.push('<hr />');
      continue;
    }

    /* ----------------------------------------------------------- heading */
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushBlocks();
      const level = heading[1]!.length;
      html.push(`<h${level}>${inline(heading[2]!, options)}</h${level}>`);
      continue;
    }

    /* ------------------------------------------------------------- table */
    if (line.includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1] ?? '')) {
      flushBlocks();
      const cells = (row: string) =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());

      const header = cells(line);
      index += 1;
      const rows: string[][] = [];
      while (index + 1 < lines.length && lines[index + 1]!.includes('|') && lines[index + 1]!.trim()) {
        index += 1;
        rows.push(cells(lines[index]!));
      }

      html.push(
        '<div class="md-table-wrap"><table><thead><tr>' +
          header.map((cell) => `<th>${inline(cell, options)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows
            .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell, options)}</td>`).join('')}</tr>`)
            .join('') +
          '</tbody></table></div>',
      );
      continue;
    }

    /* -------------------------------------------------------------- list */
    const item = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const indent = item[1]!.length;
      const ordered = item[2] === undefined;
      closeLists(indent);

      const open = lists[lists.length - 1];
      if (!open || open.indent < indent) {
        lists.push({ ordered, indent });
        html.push(ordered ? '<ol>' : '<ul>');
      } else if (open.ordered !== ordered) {
        html.push(open.ordered ? '</ol>' : '</ul>');
        lists[lists.length - 1] = { ordered, indent };
        html.push(ordered ? '<ol>' : '<ul>');
      }

      // `- [ ]` / `- [x]` render as a real (disabled) checkbox: a note's todo
      // list is worth seeing ticked, but the preview is not an editing surface.
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[4]!);
      if (task) {
        const checked = task[1]!.toLowerCase() === 'x' ? ' checked' : '';
        html.push(
          `<li class="md-task"><input type="checkbox" disabled${checked} />${inline(task[2]!, options)}</li>`,
        );
      } else {
        html.push(`<li>${inline(item[4]!, options)}</li>`);
      }
      continue;
    }

    closeLists();
    paragraph.push(line.trim());
  }

  flushBlocks();
  return html.join('\n');
}

/** Plain text of a note, for anywhere a preview would be too much. */
export function markdownToText(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
