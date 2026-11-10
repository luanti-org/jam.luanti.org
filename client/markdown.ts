import hosts from "../content/hosts.json";
import wizard from "../content/wizard.json";
import workshop from "../content/workshop.json";
import rules from "../content/rules.md" with { type: "text" };
import pantry from "../content/pantry.md" with { type: "text" };
import cauldron from "../content/cauldron.md" with { type: "text" };
import credits from "../content/credits.md" with { type: "text" };
import { ingredientCatalog, jam } from "./sdk";
import { copyAt, copyAttributes, eventDates, substitute } from "./presentation";
import { submissionTemplate } from "./submission";

function eventValues() {
    return {
        title: workshop.title,
        year: jam.id,
        engine: jam.engine,
        participationFile: jam.participationFile,
        supportedHosts: hosts.map(({ host }) => host).join(", "),
        ...eventDates(jam, "UTC"),
    };
}

export function renderWorkshop(): typeof workshop {
    const values = eventValues();

    return JSON.parse(JSON.stringify(workshop), (_key, value) =>
        typeof value === "string" ? substitute(value, values) : value);
}

export function renderWizard() {
    for (const timing of [wizard.quipIntervalMs, wizard.speechDurationMs]) {
        if (!Number.isSafeInteger(timing) || timing <= 0 || timing > 2147483647) {
            throw new Error("Wizard timings must be positive timer durations in milliseconds");
        }
    }

    return wizard;
}

/** Repository-owned Markdown accepts escaped {{values}} and standalone {{!widgets}}. */
export function renderMarkdown(source: string, localDates = false, widgets: Record<string, string> = {}) {
    const values = eventValues();
    const html = Bun.markdown.html(source, { noHtmlBlocks: true, noHtmlSpans: true, autolinks: true, headings: { ids: true } });
    const inserted = new Set<string>();

    function value(name: string, inCode = false) {
        if (!Object.hasOwn(values, name)) {
            throw new Error(`Unknown event value: ${name}`);
        }

        const value = Bun.escapeHTML(values[name as keyof typeof values]);

        if (localDates && !inCode && (name === "startsAt" || name === "endsAt")) {
            return `<time datetime="${jam[name]}" data-event-value="${name}">${value}</time>`;
        }

        if (localDates && !inCode && name === "timeZone") {
            return `<span data-event-value="timeZone">${value}</span>`;
        }

        return value;
    }

    // Treat code as a whole so widget examples stay literal, while values in code still work.
    return html.replace(/(<pre\b[^>]*>[\s\S]*?<\/pre>|<code\b[^>]*>[\s\S]*?<\/code>)|<p>\s*\{\{!(\w+)\}\}\s*<\/p>|\{\{(!?)(\w+)\}\}/g,
        (_match, code: string | undefined, block: string | undefined, indicator: string | undefined, inline: string | undefined) => {
            if (code) {
                return code.replace(/\{\{(\w+)\}\}/g, (token, name: string) => Object.hasOwn(values, name) ? value(name, true) : token);
            }

            const name = (block ?? inline)!;

            if (block || indicator === "!") {
                if (!Object.hasOwn(widgets, name)) {
                    throw new Error(`Unknown widget: ${name}`);
                }

                if (!block) {
                    throw new Error(`Widget must occupy its own paragraph: ${name}`);
                }

                if (inserted.has(name)) {
                    throw new Error(`Duplicate widget: ${name}`);
                }

                inserted.add(name);

                return widgets[name];
            }

            return value(name);
        });
}

// Text imports let Bun's watcher track the Markdown used by the frontend macros.
const proseSources = { rules, pantry, cauldron, credits };

function prose(name: keyof typeof proseSources, localDates = false, widgets: Record<string, string> = {}) {
    return renderMarkdown(proseSources[name], localDates, widgets);
}

function guideIngredients(themes: boolean) {
    const copy = renderWorkshop();

    return ingredientCatalog.filter((ingredient) => (ingredient.category === "Theme") === themes).map((ingredient) => {
        const name = Bun.escapeHTML(ingredient.name);
        const title = ingredient.url ? `<a href="${Bun.escapeHTML(ingredient.url)}">${name}</a>` : name;
        const theme = themes ? ` (${copy.optionalTheme.toLowerCase()})` : "";
        const media = ingredient.media?.map((medium) => copy.mediaLabels[medium]).join(", ");
        const license = ingredient.license ? substitute(copy.licenseLabel, { license: ingredient.license }) : "";

        return `<article><h4>${title}${Bun.escapeHTML(theme)}</h4>`
            + (ingredient.description ? `<p>${Bun.escapeHTML(ingredient.description)}</p>` : "")
            + (media ? `<p>${Bun.escapeHTML(copy.guide.mediaLabel)} ${Bun.escapeHTML(media)}</p>` : "")
            + (license ? `<p>${Bun.escapeHTML(license)}</p>` : "") + "</article>";
    }).join("");
}

export async function renderProse(localDates = true, mode: "workshop" | "guide" = "workshop") {
    const [rules, pantry, cauldron] = await Promise.all([
        prose("rules", localDates),
        prose("pantry", localDates, {
            themes: mode === "guide" ? guideIngredients(true) : '<div id="theme-ingredients" class="ingredient-shelf"></div>',
            resources: mode === "guide" ? guideIngredients(false) : '<div id="resource-ingredients" class="ingredient-shelf"></div>',
        }),
        prose("cauldron", localDates, { submission: mode === "guide" ? "" : submissionTemplate }),
    ]);

    return { rules, pantry, cauldron };
}

function footerLinks() {
    return renderWorkshop().footer.links.map((item) =>
        `<li data-footer-link><a href="${Bun.escapeHTML(item.href)}">${Bun.escapeHTML(item.label)}</a></li>`).join("");
}

/** HTML owns the page shell; Markdown composes prose and widgets; JSON supplies labels and catalogues. */
export async function renderPage(template: string, page: "index" | "guide" | "admin") {
    const copy = renderWorkshop();
    const values = eventValues();
    const rewriter = new HTMLRewriter();
    const labels = new HTMLRewriter();

    for (const [attribute, target] of Object.entries(copyAttributes)) {
        labels.on(`[${attribute}]`, {
            element(element) {
                const value = copyAt(copy, element.getAttribute(attribute)!);

                if (target === "text") {
                    element.setInnerContent(value);
                } else {
                    element.setAttribute(target, value);
                }
            },
        });
    }

    labels.on("[data-event-value]", {
        element(element) {
            const name = element.getAttribute("data-event-value")!;

            if (!Object.hasOwn(values, name)) {
                throw new Error(`Unknown event value: ${name}`);
            }

            element.setInnerContent(values[name as keyof typeof values]);

            if (element.tagName === "time" && (name === "startsAt" || name === "endsAt")) {
                element.setAttribute("datetime", jam[name]);
            }
        },
    });
    rewriter.on("#text-version-item", {
        element(element) {
            element.before(footerLinks(), { html: true });
        },
    });

    if (page !== "admin") {
        const content = await renderProse(page === "index", page === "guide" ? "guide" : "workshop");
        rewriter.on("[data-prose]", {
            element(element) {
                const name = element.getAttribute("data-prose")! as keyof typeof content;

                if (!Object.hasOwn(content, name)) {
                    throw new Error(`Unknown prose document: ${name}`);
                }

                element.setInnerContent(content[name], { html: true });
                element.setAttribute("data-rendered", "");
            },
        });
    }

    if (page === "guide") {
        // Bun can emit an empty script entry even for HTML that only imports CSS.
        rewriter.on('script, link[rel="modulepreload"]', {
            element(element) {
                element.remove();
            },
        });
        const credits = await prose("credits");
        rewriter.on("#guide-credits", {
            element(element) {
                element.setInnerContent(credits, { html: true });
            },
        });
        rewriter.on("#guide-artwork", {
            element(element) {
                element.setInnerContent(copy.artwork.map((item) =>
                    `<li><a href="${Bun.escapeHTML(item.url)}">${Bun.escapeHTML(item.title)}</a>${renderMarkdown(item.credit)}</li>`).join(""), { html: true });
            },
        });
        rewriter.on("#guide-footer-links", {
            element(element) {
                element.setInnerContent(footerLinks(), { html: true });
            },
        });
    }

    // HTMLRewriter treats noscript as raw text. Resolve this short link label before parsing it.
    const composed = rewriter.transform(new Response(template.replaceAll("{{textGuideLabel}}", () => Bun.escapeHTML(copy.footer.plainTextLabel))));

    // A separate pass resolves labels inside inserted widget markup as well as the page shell.
    return labels.transform(composed).text();
}
