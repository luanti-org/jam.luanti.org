import {
    ApiError,
    getSubmissionStatus,
    ingredientCatalog,
    jam,
    listBrews,
    submitBrew,
} from "./sdk";
import siteIcons from "./assets/icons";
import { renderProse, renderWizard, renderWorkshop } from "./markdown" with { type: "macro" };
import { eventDates, populateLabels, recentlyPublished, substitute } from "./presentation";

const workshop = renderWorkshop();
const dialogue = renderWizard();

const api = process.env.PUBLIC_API_URL!;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Only repository-owned Markdown is compiled to HTML; API content stays in text nodes.
const prose = await renderProse();

for (const node of document.querySelectorAll<HTMLElement>("[data-prose]")) {
    node.innerHTML = prose[node.dataset.prose as keyof typeof prose];
}

populateLabels(workshop, { engine: jam.engine, ...eventDates(jam) });

const panel = element<HTMLDialogElement>("workshop-panel");
const room = document.querySelector<HTMLElement>(".workshop")!;
const wizard = element<HTMLButtonElement>("wizard");
const speech = element<HTMLButtonElement>("speech");

type PanelId = keyof typeof workshop.panels;

let greeted = false;
let speechTimeout: ReturnType<typeof setTimeout> | undefined;
let panelOpener: HTMLElement | undefined;
let shelfLoaded = false;
let refreshShelfAfterCauldron = false;

function stopSpeaking() {
    clearTimeout(speechTimeout);
    speech.hidden = true;
    wizard.classList.remove("talking");
}

function speak(text: string) {
    stopSpeaking();
    speech.textContent = text;
    speech.hidden = panel.open;
    element("wizard-remark").textContent = `"${text}"`;
    wizard.classList.add("talking");
    speechTimeout = setTimeout(stopSpeaking, dialogue.speechDurationMs);
}

function wizardRemark() {
    const text = greeted
        ? randomQuip()
        : dialogue.greeting;
    greeted = true;

    return text;
}

function randomQuip() {
    const quips = dialogue.quips;

    return quips[Math.floor(Math.random() * quips.length)] ?? dialogue.greeting;
}

/** Fit the menu inside the room's frame while keeping the rest of the page usable. */
function alignPanel() {
    if (!panel.open) {
        return;
    }

    const bounds = room.querySelector(".room")!.getBoundingClientRect();
    panel.style.left = `${bounds.left}px`;
    panel.style.top = `${bounds.top}px`;
    panel.style.width = `${bounds.width}px`;
    panel.style.height = `${bounds.height}px`;
}

new ResizeObserver(alignPanel).observe(room);
window.addEventListener("scroll", alignPanel, { passive: true });
window.addEventListener("resize", alignPanel);
window.visualViewport?.addEventListener("resize", alignPanel);

function openPanel(id: PanelId, opener: HTMLElement) {
    stopSpeaking();
    panelOpener = opener;

    for (const section of panel.querySelectorAll<HTMLElement>(".panel-body > section")) {
        section.hidden = section.id !== id;
    }

    panel.dataset.theme = element(id).dataset.theme;
    element("panel-title").textContent = workshop.panels[id].title;
    element("refresh-shelf").hidden = id !== "shelf-panel";
    document.documentElement.classList.add("menu-open");

    // A modal dialog makes the footer inert. Disable only the room objects covered by this menu.
    for (const object of room.querySelectorAll<HTMLElement>("[data-panel], #speech")) {
        object.inert = true;
    }

    panel.show();
    alignPanel();
    panel.querySelector(".panel-body")!.scrollTop = 0;

    if (id === "rules-panel") {
        speak(wizardRemark());
    }

    if (id === "shelf-panel") {
        updateShelfPresentation();

        if (!shelfLoaded || Date.now() - shelfRequestedAt >= shelfRefreshMs) {
            void shelf();
        }
    }
}

for (const hotspot of document.querySelectorAll<HTMLButtonElement>("[data-panel]")) {
    const id = hotspot.dataset.panel as PanelId;
    hotspot.addEventListener("click", () => openPanel(id, hotspot));
}

speech.addEventListener("click", () => openPanel("rules-panel", wizard));
element("close-panel").addEventListener("click", () => panel.close());
panel.addEventListener("close", () => {
    stopSpeaking();
    document.documentElement.classList.remove("menu-open");

    for (const object of room.querySelectorAll<HTMLElement>("[data-panel], #speech")) {
        object.inert = false;
    }

    panelOpener?.focus();

    if (!element("submission-panel").hidden && refreshShelfAfterCauldron) {
        refreshShelfAfterCauldron = false;
        void shelf(true);
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.open) {
        event.preventDefault();
        panel.close();
    }
});

// Ambient remarks never open a panel, take focus, or announce themselves to assistive technology.
setInterval(() => {
    if (!document.hidden && !panel.open && !speech.matches(":focus") && !wizard.matches(":focus")) {
        speak(randomQuip());
    }
}, dialogue.quipIntervalMs);

document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        stopSpeaking();
    }
});

const mediaLabels = workshop.mediaLabels;

for (const ingredient of ingredientCatalog) {
    const theme = ingredient.category === "Theme";
    const row = document.createElement("article");
    const title = document.createElement("h4");
    row.className = `ingredient ${theme ? "paper" : "crate"}`;
    row.append(title);

    if (ingredient.url) {
        const link = document.createElement("a");
        link.href = ingredient.url;
        link.textContent = ingredient.name;

        const source = siteIcons[ingredient.id];

        if (source) {
            const icon = document.createElement("img");
            icon.className = "site-icon";
            icon.src = source;
            icon.alt = "";
            icon.width = 16;
            icon.height = 16;
            link.prepend(icon);
        }

        title.append(link);
    } else {
        title.textContent = ingredient.name;
    }

    if (theme && ingredient.description) {
        const description = document.createElement("p");
        description.textContent = ingredient.description;
        row.append(description);
    }

    const stickers = document.createElement("div");
    stickers.className = "media-stickers";

    for (const medium of ingredient.media ?? []) {
        const sticker = document.createElement("span");
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        sticker.className = "media-sticker";
        sticker.title = mediaLabels[medium];
        sticker.setAttribute("role", "img");
        sticker.setAttribute("aria-label", mediaLabels[medium]);
        icon.setAttribute("aria-hidden", "true");
        icon.setAttribute("viewBox", "0 0 24 24");
        use.setAttribute("href", `#icon-${medium}`);
        icon.append(use);
        sticker.append(icon);
        stickers.append(sticker);
    }

    const labels = document.createElement("div");
    labels.className = "ingredient-labels";
    labels.append(stickers);

    if (ingredient.license) {
        const license = document.createElement("span");
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        license.className = "license-label";
        license.title = substitute(workshop.licenseLabel, { license: ingredient.license });
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("aria-hidden", "true");
        use.setAttribute("href", "#icon-license");
        icon.append(use);
        license.append(icon, ingredient.license);
        labels.append(license);
    }

    row.append(labels);
    element(theme ? "theme-ingredients" : "resource-ingredients").append(row);
}

// Production HTML already contains these links; development fills them from the same collection.
if (!document.querySelector("[data-footer-link]")) {
    for (const item of workshop.footer.links) {
        const itemElement = document.createElement("li");
        itemElement.dataset.footerLink = "";
        const link = document.createElement("a");
        link.href = item.href;
        link.textContent = item.label;
        itemElement.append(link);
        element("footer-links").insertBefore(itemElement, element("text-version-item"));
    }
}

const motionSwitch = element<HTMLInputElement>("reduce-motion");
const systemMotion = matchMedia("(prefers-reduced-motion: reduce)");
let motionOverride: string | null = null;

try {
    motionOverride = localStorage.getItem("workshop.reducedMotion");
} catch {
    // Storage can be unavailable; the switch still works for this visit.
}

function updateMotion() {
    const reduced = motionOverride === null ? systemMotion.matches : motionOverride === "true";
    document.documentElement.dataset.reducedMotion = String(reduced);
    motionSwitch.checked = reduced;
}

motionSwitch.addEventListener("change", () => {
    motionOverride = String(motionSwitch.checked);

    try {
        localStorage.setItem("workshop.reducedMotion", motionOverride);
    } catch {
        // Keep the in-memory preference when browser storage is blocked.
    }

    updateMotion();
});
systemMotion.addEventListener("change", updateMotion);
updateMotion();

const submissionCopy = workshop.submission;
const form = element<HTMLFormElement>("submit-form");
const repository = element<HTMLInputElement>("repository");
const submitButton = element<HTMLButtonElement>("submit-button");
let statusRequest: AbortController | undefined;
let currentStatus: Awaited<ReturnType<typeof getSubmissionStatus>> | undefined;

function showReceipt() {
    element("submission-entry").hidden = true;
    element("submission-receipt").hidden = false;
    element("status-action-result").textContent = "";
}

function showStatus(state: Awaited<ReturnType<typeof getSubmissionStatus>>, submitted = false) {
    const link = document.createElement("a");
    link.href = state.commitUrl;
    link.textContent = state.commit.slice(0, 7);
    link.title = state.commit;
    const result = submissionCopy.statuses[state.status];
    const feedback = state.reason ? `: "${state.reason}"` : ".";
    element("status").replaceChildren(`${submissionCopy.commitLabel} `, link, ` ${result}${feedback}`);

    const changed = currentStatus && (currentStatus.id !== state.id
        || currentStatus.status !== state.status || currentStatus.reason !== state.reason);

    if (submitted || changed) {
        if (panel.open && !element("submission-panel").hidden) {
            refreshShelfAfterCauldron = true;
        } else {
            // Inspection/status requests can finish after the participant returns to the room.
            void shelf(true);
        }
    }

    currentStatus = state;
}

async function status() {
    const id = new URL(location.href).searchParams.get("submission");

    if (!id) {
        return;
    }

    statusRequest?.abort();
    const request = new AbortController();
    statusRequest = request;
    element("status").textContent = submissionCopy.checking;
    element("status-action-result").textContent = "";

    try {
        const state = await getSubmissionStatus(api, id, { signal: request.signal });

        if (!request.signal.aborted) {
            showStatus(state);
        }
    } catch (error) {
        if (!request.signal.aborted) {
            element("status").textContent = message(error);
        }
    }
}

// This is presentation validation only; the server owns the repository host and namespace policy.
function validateRepository() {
    let webUrl = false;

    try {
        webUrl = ["http:", "https:"].includes(new URL(repository.value).protocol);
    } catch {
        // Required/type=url validation also explains empty or malformed input.
    }

    repository.setCustomValidity(repository.value && !webUrl ? submissionCopy.httpsError : "");
}

repository.addEventListener("input", validateRepository);
element("copy-status-link").addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(location.href);
        element("status-action-result").textContent = submissionCopy.linkCopied;
    } catch {
        element("status-action-result").textContent = submissionCopy.copyFailure;
    }
});
element("refresh-status").addEventListener("click", () => void status());
element("another-game").addEventListener("click", () => {
    statusRequest?.abort();
    currentStatus = undefined;
    const url = new URL(location.href);
    url.searchParams.delete("submission");
    history.replaceState(null, "", url);
    form.reset();
    repository.setCustomValidity("");
    element("submission-entry").hidden = false;
    element("submission-receipt").hidden = true;
    element("submit-result").textContent = "";
    repository.focus();
});

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    validateRepository();

    if (submitButton.disabled || !form.reportValidity()) {
        return;
    }

    submitButton.disabled = true;
    repository.disabled = true;
    form.setAttribute("aria-busy", "true");
    submitButton.querySelector<HTMLElement>(".spinner")!.hidden = false;
    element("submit-label").textContent = submissionCopy.inspecting;
    element("inspection-help").hidden = false;
    element("submit-result").textContent = "";

    try {
        repository.value = repository.value.replace(/^http:\/\//i, "https://");
        const result = await submitBrew(api, repository.value);
        const url = new URL(location.href);
        url.searchParams.set("submission", result.id);
        history.replaceState(null, "", url);
        showReceipt();
        showStatus(result, true);

        if (panel.open && !element("submission-panel").hidden) {
            element("status").focus();
        }
    } catch (error) {
        const template = error instanceof ApiError && error.status === 422
            ? submissionCopy.inspectionFailure : submissionCopy.submitFailure;
        element("submit-result").textContent = substitute(template, { error: message(error) });
    } finally {
        submitButton.disabled = false;
        repository.disabled = false;
        form.removeAttribute("aria-busy");
        submitButton.querySelector<HTMLElement>(".spinner")!.hidden = true;
        element("submit-label").textContent = submissionCopy.submit;
        element("inspection-help").hidden = true;
    }
});

let shelfEntries: Awaited<ReturnType<typeof listBrews>> = [];
const viewedPublications = new Set<string>();
const shelfRefreshMs = 5 * 60 * 1000;
let shelfRequestedAt = 0;
let shelfRefreshPending = false;

function updateShelfPresentation() {
    const now = Date.now();
    const shelfOpen = panel.open && !element("shelf-panel").hidden;

    if (shelfOpen) {
        // Viewing clears the room badge for these publications until this tab is refreshed.
        // Card badges still identify recent games; a later approval can light the room badge again.
        for (const entry of shelfEntries) {
            viewedPublications.add(`${entry.id}:${entry.publishedAt}`);
        }

        if (shelfLoaded) {
            element("panel-title").textContent = `${workshop.panels["shelf-panel"].title} (${shelfEntries.length})`;
        }
    }

    const recent = shelfEntries.some((entry) => recentlyPublished(entry.publishedAt, now)
        && !viewedPublications.has(`${entry.id}:${entry.publishedAt}`));
    element("shelf-new").hidden = !recent;
    element("shelf-new").setAttribute("title", workshop.shelf.newLabel);
    const hotspot = document.querySelector<HTMLButtonElement>(".brews")!;
    const label = workshop.panels["shelf-panel"].accessibleLabel;
    hotspot.setAttribute("aria-label", recent ? `${label}. ${workshop.shelf.newLabel}` : label);

    for (const badge of element("shelf-list").querySelectorAll<HTMLElement>("[data-published-at]")) {
        badge.hidden = !recentlyPublished(badge.dataset.publishedAt!, now);
    }
}

async function shelf(afterChange = false) {
    const refresh = element<HTMLButtonElement>("refresh-shelf");

    if (refresh.disabled) {
        // Coalesce routine refreshes, but follow older in-flight reads with one fresh read after a change.
        shelfRefreshPending ||= afterChange;

        return;
    }

    shelfRequestedAt = Date.now();
    refresh.disabled = true;

    if (!shelfLoaded) {
        element("shelf-result").textContent = workshop.shelf.loading;
        element("shelf-result").hidden = false;
    }

    try {
        const entries = await listBrews(api);
        const rows = document.createDocumentFragment();

        for (const entry of entries) {
            const card = document.createElement("article");
            const title = document.createElement("h3");
            const link = document.createElement("a");
            const description = document.createElement("p");
            link.href = entry.repository;
            link.textContent = entry.title;
            title.append(link);
            description.textContent = entry.description;

            const badge = document.createElement("span");
            badge.className = "new-badge";
            badge.dataset.publishedAt = entry.publishedAt;
            badge.textContent = workshop.shelf.new;
            badge.title = workshop.shelf.newLabel;
            title.append(" ", badge);
            card.append(title);

            if (entry.hasScreenshot) {
                const image = document.createElement("img");
                image.src = `${api}/api/brews/${entry.id}/images/${entry.commit}`;
                image.alt = entry.title;
                image.loading = "lazy";
                image.addEventListener("error", () => {
                    const notice = document.createElement("p");
                    notice.className = "fine-print";
                    notice.textContent = workshop.shelf.screenshotUnavailable;
                    image.replaceWith(notice);
                }, { once: true });
                card.append(image);
            }

            card.append(description);
            rows.append(card);
        }

        element("shelf-list").replaceChildren(rows);
        shelfEntries = entries;
        shelfLoaded = true;
        updateShelfPresentation();
        element("shelf-result").textContent = entries.length ? "" : workshop.shelf.empty;
        element("shelf-result").hidden = entries.length > 0;
    } catch (error) {
        element("shelf-result").textContent = substitute(workshop.shelf.failure, { error: message(error) });
        element("shelf-result").hidden = false;
    } finally {
        refresh.disabled = false;

        if (shelfRefreshPending) {
            shelfRefreshPending = false;
            void shelf();
        }
    }
}

element("refresh-shelf").addEventListener("click", () => void shelf());

// The room badge and gallery share this one load; opening the shelf during it does not refetch.
void shelf();
setInterval(() => {
    updateShelfPresentation();

    if (Date.now() - shelfRequestedAt >= shelfRefreshMs) {
        void shelf();
    }
}, 30000);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
        updateShelfPresentation();

        if (Date.now() - shelfRequestedAt >= shelfRefreshMs) {
            void shelf();
        }
    }
});

// A saved receipt opens its status immediately; ordinary visits begin in the room.
if (new URL(location.href).searchParams.has("submission")) {
    showReceipt();
    openPanel("submission-panel", document.querySelector<HTMLButtonElement>(".cauldron")!);
    void status();
}
