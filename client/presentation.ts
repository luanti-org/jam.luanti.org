/** Values come from repository-owned configuration; substitution never accepts API content. */
export function substitute(text: string, values: Record<string, string>) {
    return text.replace(/\{\{(\w+)\}\}/g, (token, name: string) => values[name] ?? token);
}

export function recentlyPublished(publishedAt: string, now = Date.now()) {
    const age = now - Date.parse(publishedAt);

    return age >= 0 && age < 24 * 60 * 60 * 1000;
}

export function eventDates(event: { startsAt: string; endsAt: string }, timeZone?: string) {
    const format = new Intl.DateTimeFormat(timeZone ? "en" : undefined, {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
        timeZoneName: "short", timeZone,
    });

    return {
        startsAt: format.format(new Date(event.startsAt)),
        endsAt: format.format(new Date(event.endsAt)),
        timeZone: format.resolvedOptions().timeZone,
    };
}

// These bindings cover plain UI labels/attributes only; prose is authored in Markdown.
export const copyAttributes = {
    "data-copy": "text",
    "data-copy-aria-label": "aria-label",
    "data-copy-alt": "alt",
    "data-copy-href": "href",
    "data-copy-placeholder": "placeholder",
    "data-copy-content": "content",
};

export function copyAt(copy: unknown, path: string): string {
    const value = path.split(".").reduce((value, key) => (value as Record<string, unknown>)?.[key], copy);

    if (typeof value !== "string") {
        throw new Error(`Unknown text label: ${path}`);
    }

    return value;
}

/** Development HTML uses the same bindings that the production build fills ahead of time. */
export function populateLabels(copy: unknown, values: Record<string, string>) {
    for (const [attribute, target] of Object.entries(copyAttributes)) {
        for (const node of document.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
            const value = copyAt(copy, node.getAttribute(attribute)!);

            if (target === "text") {
                node.textContent = value;
            } else {
                node.setAttribute(target, value);
            }
        }
    }

    for (const node of document.querySelectorAll<HTMLElement>("[data-event-value]")) {
        const name = node.dataset.eventValue!;

        if (!Object.hasOwn(values, name)) {
            throw new Error(`Unknown event value: ${name}`);
        }

        node.textContent = values[name];
    }
}
