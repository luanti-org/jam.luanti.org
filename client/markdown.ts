import hosts from "../content/hosts.json";
import wizard from "../content/wizard.json";
import workshop from "../content/workshop.json";
import rules from "../content/rules.md" with { type: "text" };
import pantry from "../content/pantry.md" with { type: "text" };
import cauldron from "../content/cauldron.md" with { type: "text" };
import credits from "../content/credits.md" with { type: "text" };
import { ingredientCatalog, jam } from "./sdk";
import { copyAt, copyAttributes, eventDates, substitute } from "./presentation";

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

/** Only repository-owned Markdown is compiled. Tokens insert escaped event values, never passages or layout. */
export function renderMarkdown(source: string, localDates = false) {
    const values = eventValues();
    const html = Bun.markdown.html(source, { noHtmlBlocks: true, noHtmlSpans: true, autolinks: true, headings: { ids: true } });

    return html.replace(/\{\{(\w+)\}\}/g, (_token, name: string) => {
        if (!Object.hasOwn(values, name)) {
            throw new Error(`Unknown event value: ${name}`);
        }

        const value = Bun.escapeHTML(values[name as keyof typeof values]);

        if (localDates && (name === "startsAt" || name === "endsAt")) {
            return `<time datetime="${jam[name]}" data-event-value="${name}">${value}</time>`;
        }

        if (localDates && name === "timeZone") {
            return `<span data-event-value="timeZone">${value}</span>`;
        }

        return value;
    });
}

// Text imports let Bun's watcher track the Markdown used by the frontend macros.
const proseSources = { rules, pantry, cauldron, credits };

function prose(name: keyof typeof proseSources, localDates = false) {
    return renderMarkdown(proseSources[name], localDates);
}

export async function renderProse(localDates = true) {
    const [rules, pantry, cauldron] = await Promise.all([
        prose("rules", localDates), prose("pantry", localDates), prose("cauldron", localDates),
    ]);

    return { rules, pantry, cauldron };
}

function footerLinks() {
    return renderWorkshop().footer.links.map((item) =>
        `<li data-footer-link><a href="${Bun.escapeHTML(item.href)}">${Bun.escapeHTML(item.label)}</a></li>`).join("");
}

/** HTML owns page structure; Markdown owns prose, and JSON owns labels and ordered catalogues. */
export async function renderPage(template: string, page: "index" | "guide" | "admin") {
    const copy = renderWorkshop();
    const values = eventValues();
    const rewriter = new HTMLRewriter();

    for (const [attribute, target] of Object.entries(copyAttributes)) {
        rewriter.on(`[${attribute}]`, {
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

    rewriter.on("[data-event-value]", {
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
        const content = await renderProse(page === "index");
        rewriter.on("[data-prose]", {
            element(element) {
                const name = element.getAttribute("data-prose")! as keyof typeof content;

                if (!Object.hasOwn(content, name)) {
                    throw new Error(`Unknown prose document: ${name}`);
                }

                element.setInnerContent(content[name], { html: true });
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
        rewriter.on("#guide-ingredients", {
            element(element) {
                element.setInnerContent(ingredientCatalog.map((ingredient) => {
                    const name = Bun.escapeHTML(ingredient.name);
                    const title = ingredient.url ? `<a href="${Bun.escapeHTML(ingredient.url)}">${name}</a>` : name;
                    const theme = ingredient.category === "Theme" ? ` (${copy.optionalTheme.toLowerCase()})` : "";
                    const media = ingredient.media?.map((medium) => copy.mediaLabels[medium]).join(", ");
                    const license = ingredient.license ? substitute(copy.licenseLabel, { license: ingredient.license }) : "";

                    return `<article><h3>${title}${Bun.escapeHTML(theme)}</h3>`
                        + (ingredient.description ? `<p>${Bun.escapeHTML(ingredient.description)}</p>` : "")
                        + (media ? `<p>${Bun.escapeHTML(copy.guide.mediaLabel)} ${Bun.escapeHTML(media)}</p>` : "")
                        + (license ? `<p>${Bun.escapeHTML(license)}</p>` : "") + "</article>";
                }).join(""), { html: true });
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
    return rewriter.transform(new Response(template.replaceAll("{{textGuideLabel}}", () => Bun.escapeHTML(copy.footer.plainTextLabel)))).text();
}
