import { expect, test } from "bun:test";
import hosts from "../content/hosts.json";
import { ingredientCatalog, jam, submitBrew } from "../client/sdk";
import wizard from "../content/wizard.json";
import workshop from "../content/workshop.json";
import { renderMarkdown, renderPage, renderProse, renderWizard, renderWorkshop } from "../client/markdown";
import { eventDates, recentlyPublished } from "../client/presentation";

test("recent publication includes this instant and expires at 24 hours, excluding future dates", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const at = (offset: number) => new Date(now + offset).toISOString();
    expect(recentlyPublished(at(0), now)).toBe(true);
    expect(recentlyPublished(at(-86400000 + 1), now)).toBe(true);
    expect(recentlyPublished(at(-86400000), now)).toBe(false);
    expect(recentlyPublished(at(-86400001), now)).toBe(false);
    expect(recentlyPublished(at(1), now)).toBe(false);
    expect(recentlyPublished("invalid", now)).toBe(false);
});

test("authored headings and document titles can position or omit the year without markup changes", async () => {
    const templates = await Promise.all(["index", "guide"].map((page) =>
        Bun.file(new URL(`../client/${page}.html`, import.meta.url)).text()));
    const originalHeading = workshop.heading;
    const originalPageTitle = workshop.pageTitle;

    try {
        for (const [authored, expected] of [
            ["{{year}}: {{title}}", `${jam.id}: ${workshop.title}`],
            ["{{title}} ({{year}} edition)", `${workshop.title} (${jam.id} edition)`],
            ["A workshop for small games", "A workshop for small games"],
        ]) {
            workshop.heading = authored;
            workshop.pageTitle = "{{title}}: the workshop";
            const copy = renderWorkshop();
            expect(copy.heading).toBe(expected);
            expect(copy.pageTitle).toBe(`${workshop.title}: the workshop`);

            for (const [i, page] of (["index", "guide"] as const).entries()) {
                const html = await renderPage(templates[i], page);
                let heading = "";
                let title = "";

                await new HTMLRewriter()
                    .on("h1", {
                        text(chunk) {
                            heading += chunk.text;
                        },
                    })
                    .on("title", {
                        text(chunk) {
                            title += chunk.text;
                        },
                    })
                    .transform(new Response(html))
                    .text();

                // Read the static output directly: scripts must not be needed to fix either string.
                expect(heading).toBe(expected);
                expect(title).toBe(page === "index" ? copy.pageTitle : copy.guide.title);
                expect(html).not.toContain('id="jam-year"');
                expect(html).not.toContain("{{year}}");
            }
        }
    } finally {
        workshop.heading = originalHeading;
        workshop.pageTitle = originalPageTitle;
    }
});

test("shared Markdown supplies event values and date markers, with UTC prose in the static guide", async () => {
    const copy = renderWorkshop();
    expect(copy.pageTitle).toContain(jam.id);
    expect(copy).not.toHaveProperty("rulesSchedule");
    expect(copy).not.toHaveProperty("localTimeNote");
    expect(copy).not.toHaveProperty("wizard");
    const content = await renderProse();

    for (const { host } of hosts) {
        expect(content.rules).toContain(host);
    }

    expect(content.rules).toContain(jam.participationFile);
    expect(content.cauldron).toContain(jam.participationFile);
    expect(content.rules).not.toMatch(/\{\{|HEAD|MiB|megapixel/i);
    expect(content.rules).toContain("Contact the administrator");
    expect(content.rules).toContain("multiple entries");
    expect(content.rules).toContain('data-event-value="startsAt"');
    expect(content.rules).toContain('data-event-value="endsAt"');
    expect(content.rules).toContain('data-event-value="timeZone"');
    expect(content.rules.indexOf("Jam window")).toBeLessThan(content.rules.indexOf("Pack your spellbook"));
    const local = eventDates(jam, "America/Los_Angeles");
    expect(local.startsAt).toContain("Oct 31, 2026");
    expect(local.startsAt).toContain("PDT");
    expect(local.endsAt).toContain("Nov 21, 2026");
    expect(local.endsAt).toContain("PST");
    expect(local.timeZone).toBe("America/Los_Angeles");
    const guide = await renderPage(await Bun.file(new URL("../client/guide.html", import.meta.url)).text(), "guide");
    expect(guide).toContain("Nov 1, 2026");
    expect(guide).toContain("Nov 22, 2026");
    expect(guide).toContain("Times are shown in UTC.");
    expect(guide).not.toContain("{{");
    expect(guide).toContain(copy.guide.back);
});

test("Markdown controls prose order and accepts values rather than passage includes", () => {
    const source = "Closing: **{{endsAt}}**.\n\n### Earlier wording\n\nOpening: {{startsAt}}. Engine: {{engine}}.";
    const html = renderMarkdown(source, true);
    expect(html.indexOf("Closing:")).toBeLessThan(html.indexOf("Earlier wording"));
    expect(html.indexOf("Earlier wording")).toBeLessThan(html.indexOf("Opening:"));
    expect(html).toContain(`<time datetime="${jam.endsAt}" data-event-value="endsAt">`);
    expect(html).toContain(jam.engine);
    expect(() => renderMarkdown("{{rulesSchedule}}")).toThrow("Unknown event value");
    expect(() => renderMarkdown("{{pantry}}")).toThrow("Unknown event value");
    const original = workshop.title;

    try {
        workshop.title = '<img src=x onerror="alert(1)">';
        const escaped = renderMarkdown("# {{title}}");
        expect(escaped).toContain("&lt;img");
        expect(escaped).not.toContain("<img");
    } finally {
        workshop.title = original;
    }
});

test("wizard configuration is separate and validates timer durations", () => {
    expect(renderWizard()).toEqual(wizard);
    const original = wizard.speechDurationMs;

    try {
        wizard.speechDurationMs = 0;
        expect(() => renderWizard()).toThrow("Wizard timings");
        wizard.speechDurationMs = 2147483648;
        expect(() => renderWizard()).toThrow("Wizard timings");
    } finally {
        wizard.speechDurationMs = original;
    }
});

test("Markdown widgets occupy whole paragraphs, preserve order and reject duplicate or inline controls", () => {
    const widgets = { submission: '<form id="example-form"></form>' };
    const html = renderMarkdown("Before.\n\n{{!submission}}\n\nAfter {{engine}}.", true, widgets);
    expect(html).toContain('<p>Before.</p>\n<form id="example-form"></form>\n<p>After');
    expect(html).not.toContain("<p><form");
    expect(html).toContain(jam.engine);
    expect(() => renderMarkdown("Text {{!submission}}.", true, widgets)).toThrow("own paragraph");
    expect(() => renderMarkdown("{{!submission}}\n\n{{!submission}}", true, widgets)).toThrow("Duplicate widget");
    expect(() => renderMarkdown("{{!unknownWidget}}", true, widgets)).toThrow("Unknown widget");
    expect(() => renderMarkdown("{{submission}}", true, widgets)).toThrow("Unknown event value");
    expect(() => renderMarkdown("{{!engine}}", true, widgets)).toThrow("Unknown widget");
    expect(renderMarkdown("{{engine}}\n\n{{!engine}}", true, { engine: "<aside>Widget</aside>" }))
        .toContain(`<p>${jam.engine}</p>\n<aside>Widget</aside>`);
});

test("widget examples stay literal in code while event values in code remain escaped", () => {
    const source = "`{{!submission}}` and `{{engine}}`.\n\n```md\n{{!submission}}\n{{!unknownWidget}}\n```";
    const html = renderMarkdown(source, true, { submission: "<form></form>" });
    expect(html).toContain("<code>{{!submission}}</code>");
    expect(html).toContain(`<code>${jam.engine}</code>`);
    expect(html).toContain("{{!unknownWidget}}");
    expect(html).not.toContain("<form");
});

test("composed widgets have resolved labels in static HTML and pantry widgets supply the script-free guide", async () => {
    const copy = renderWorkshop();
    const index = await renderPage(await Bun.file(new URL("../client/index.html", import.meta.url)).text(), "index");
    let forms = 0;
    let label = "";
    let placeholder = "";

    await new HTMLRewriter()
        .on("#cauldron-content #submit-form", { element() { forms++; } })
        .on("#submit-label", { text(chunk) { label += chunk.text; } })
        .on("#repository", { element(element) { placeholder = element.getAttribute("placeholder")!; } })
        .transform(new Response(index)).text();
    expect(forms).toBe(1);
    expect(label).toBe(copy.submission.submit);
    expect(placeholder).toBe(copy.submission.repositoryPlaceholder);
    expect(index).toContain(`aria-label="${copy.submission.repositoryLabel}"`);
    expect(index).toContain('data-prose="cauldron" data-rendered');
    expect(index).not.toContain('aria-describedby="cauldron-content"');
    expect(index).not.toContain("{{");

    const guide = await renderPage(await Bun.file(new URL("../client/guide.html", import.meta.url)).text(), "guide");
    let entries = 0;
    await new HTMLRewriter().on('[data-prose="pantry"] article h4', {
        element() {
            entries++;
        },
    })
        .transform(new Response(guide)).text();
    expect(entries).toBe(ingredientCatalog.length);
    expect(guide.indexOf("Theme scraps (optional)")).toBeLessThan(guide.indexOf(ingredientCatalog[0].name));
    expect(guide.indexOf("Resource crates")).toBeLessThan(guide.indexOf("Kenney game assets"));
    expect(guide).not.toMatch(/<script\b|<form\b|\{\{/);
});

test("unsupported submission schemes fail locally before any transport", () => {
    let calls = 0;
    const fetcher = (async () => {
        calls++;
        throw new Error("Unexpected fetch");
    }) as unknown as typeof fetch;

    for (const url of ["ftp://github.com/o/g", "ssh://github.com/o/g", "git@github.com:o/g"]) {
        expect(() => submitBrew("https://api.example.org", url, { fetch: fetcher })).toThrow();
    }

    expect(calls).toBe(0);
});

test("the SDK upgrades HTTP repository input before transport and leaves host policy to the server", async () => {
    const repository = "https://github.com/o/g";
    let calls = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        expect(String(input)).toBe("https://api.example.org/api/brews/submit");
        expect(JSON.parse(String(init?.body))).toEqual({ repository: "https://www.github.com/O/G.git" });

        return Response.json({ repository, commit: "a".repeat(40), commitUrl: "https://github.com/o/g/tree/" + "a".repeat(40),
            submittedAt: new Date().toISOString(), status: "pending", reason: null });
    }) as typeof fetch;
    expect((await submitBrew("https://api.example.org", "http://www.github.com/O/G.git", { fetch: fetcher })).repository).toBe(repository);
    expect(calls).toBe(1);
});
