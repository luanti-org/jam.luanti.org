import {
    ApiError,
    createIdentity,
    getAdminImage,
    getAdminQueue,
    type Identity,
    type ModerationDecision,
    moderateEntry,
    restoreIdentity,
} from "./sdk";
import { renderWorkshop } from "./markdown" with { type: "macro" };
import { populateLabels } from "./presentation";

const workshop = renderWorkshop();

const api = process.env.PUBLIC_API_URL!;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const keyInput = element<HTMLInputElement>("key");
populateLabels(workshop, {});
const statusLabels = {
    pending: "Pending", approved: "Published", rejected: "Rejected", superseded: "Superseded", removed: "Unpublished",
};
const statusOrder = { pending: 0, approved: 1, rejected: 2, superseded: 2, removed: 2 };
const operationLabels = { approve: "Approve", reject: "Reject", unpublish: "Unpublish", reinspect: "Reinspect" };

let identity: Identity | undefined;
let generation = 0;
let mutating = false;
let loadRequest: AbortController | undefined;
let reviewRequest: AbortController | undefined;
let imageUrls: string[] = [];

function controls() {
    const busy = !!loadRequest || mutating;
    element<HTMLFieldSetElement>("reviews").disabled = busy || !identity;
    element<HTMLButtonElement>("refresh").disabled = busy || !identity;
}

function clearRows() {
    element("queue").replaceChildren();
    element("entry-count").textContent = "";

    for (const url of imageUrls) {
        URL.revokeObjectURL(url);
    }

    imageUrls = [];
}

/** A definitive denial clears privileged display and pending loads, but retains the tab's key. */
function authorizationFailed(error: unknown) {
    if (!(error instanceof ApiError) || error.status !== 403) {
        return false;
    }

    loadRequest?.abort();
    loadRequest = undefined;
    reviewRequest?.abort();
    mutating = false;
    clearRows();
    element("result").textContent = `${message(error)}. Key retained; restore authorization and refresh.`;
    controls();

    return true;
}

function showKey(visible: boolean) {
    keyInput.type = visible ? "text" : "password";
    element("show-key").textContent = visible ? workshop.admin.hideKey : workshop.admin.showKey;
    element("show-key").setAttribute("aria-pressed", String(visible));
}

function clearIdentity() {
    generation++;
    loadRequest?.abort();
    loadRequest = undefined;
    reviewRequest?.abort();
    identity?.secretKey.fill(0);
    identity = undefined;
    mutating = false;
    clearRows();
    element("public-key").textContent = "";
    element("identity-info").hidden = true;
    element("result").textContent = "Key cleared.";
    keyInput.value = "";
    showKey(false);
    controls();
}

async function loadIdentity(key?: string) {
    clearIdentity();
    const current = generation;
    keyInput.value = key ?? "";

    try {
        const restored = key === undefined
            ? await createIdentity()
            : { identity: await restoreIdentity(key), phrase: key };

        if (current !== generation) {
            restored.identity.secretKey.fill(0);

            return;
        }

        identity = restored.identity;
        keyInput.value = restored.phrase;
        showKey(key === undefined);
        element("public-key").textContent = identity.publicKey;
        element("identity-info").hidden = false;
        controls();
        await refresh();
    } catch (error) {
        if (current === generation) {
            element("result").textContent = message(error).replace(/\brecovery phrase\b/gi, "key");
        }
    }
}

async function refresh() {
    if (!identity || mutating) {
        return;
    }

    // Preserve displayed rows, actions and lazy image requests until the entire replacement succeeds.
    loadRequest?.abort();
    const request = new AbortController();
    loadRequest = request;
    const key = identity;
    controls();
    element("result").textContent = "Loading entries...";

    try {
        const entries = await getAdminQueue(api, key, { signal: request.signal });

        if (request.signal.aborted) {
            return;
        }

        reviewRequest?.abort();
        clearRows();
        reviewRequest = request;

        // Review oldest pending work first; published and historical groups show newest submissions first.
        entries.sort((a, b) => {
            const group = statusOrder[a.status] - statusOrder[b.status];
            const time = a.submittedAt.localeCompare(b.submittedAt);

            return group || (a.status === "pending" ? time : -time)
                || a.repository.localeCompare(b.repository) || a.commit.localeCompare(b.commit);
        });

        const rows = new Map<(typeof entries)[number], HTMLLIElement>();

        for (const entry of entries) {
            const row = document.createElement("li");
            const heading = document.createElement("div");
            const title = document.createElement("h3");
            const link = document.createElement("a");
            const status = document.createElement("span");
            const commit = document.createElement("code");
            const submitted = document.createElement("time");
            const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
            row.className = "review-row";
            heading.className = "review-heading";
            link.textContent = entry.title ?? entry.repository.replace(/^https:\/\//, "");
            link.href = entry.title ? entry.commitUrl : entry.repository;
            status.className = "review-status";
            status.dataset.status = entry.status;
            icon.setAttribute("aria-hidden", "true");
            use.setAttribute("href", `#status-${entry.status}`);
            icon.append(use);
            status.append(icon, statusLabels[entry.status]);
            commit.textContent = entry.commit.slice(0, 10);
            commit.title = entry.commit;
            submitted.dateTime = entry.submittedAt;
            submitted.textContent = new Date(entry.submittedAt).toLocaleString();
            title.append(link);
            heading.append(status, title, commit, submitted);

            if (entry.title) {
                const repository = document.createElement("a");
                repository.className = "review-repository";
                repository.href = entry.repository;
                repository.textContent = entry.repository.replace(/^https:\/\//, "");
                heading.append(repository);
            }

            if (!entry.title) {
                const source = document.createElement("a");
                source.href = entry.commitUrl;
                source.append(commit);
                heading.insertBefore(source, submitted);
            }

            row.append(heading);

            const purged = entry.status !== "pending" && entry.status !== "approved";

            if (!purged) {
                const details = document.createElement("details");
                const summary = document.createElement("summary");
                const description = document.createElement("p");
                const image = document.createElement("img");
                const imageStatus = document.createElement("p");
                summary.textContent = "Review details";
                description.textContent = entry.description;
                image.alt = entry.title ?? entry.repository;
                image.hidden = true;
                imageStatus.className = "hint";
                imageStatus.textContent = entry.hasScreenshot ? "Loading screenshot..." : "No screenshot supplied.";
                details.append(summary, description);

                if (entry.hasScreenshot) {
                    details.append(image);
                }

                details.append(imageStatus);
                row.append(details);
                let imageRequested = false;

                // Screenshots are signed and fetched only when an administrator opens this row's details.
                details.addEventListener("toggle", () => {
                    if (!entry.hasScreenshot || !details.open || imageRequested || request.signal.aborted) {
                        return;
                    }

                    imageRequested = true;
                    void getAdminImage(api, key, entry.repository, entry.commit, { signal: request.signal })
                        .then((blob) => {
                            if (request.signal.aborted) {
                                return;
                            }

                            const url = URL.createObjectURL(blob);
                            imageUrls.push(url);
                            image.src = url;
                            image.hidden = false;
                            imageStatus.remove();
                        })
                        .catch((error) => {
                            if (!request.signal.aborted && !authorizationFailed(error)) {
                                imageStatus.textContent = `Screenshot unavailable: ${message(error)}. Refresh to retry.`;
                            }
                        });
                });
            }

            if (entry.reason) {
                const explanation = document.createElement("p");
                explanation.className = "hint";
                explanation.textContent = entry.reason;
                row.append(explanation);
            }

            const actions = document.createElement("div");
            const reason = document.createElement("input");
            actions.className = "review-actions";
            reason.maxLength = 2000;
            reason.placeholder = "Public reason for rejection or removal";
            reason.setAttribute("aria-label", `Public reason for ${entry.title ?? entry.repository}`);

            if (!purged) {
                actions.append(reason);
            }

            const operations: ModerationDecision["operation"][] = entry.status === "pending"
                ? ["approve", "reject"]
                : entry.status === "approved" ? ["unpublish"] : ["reinspect"];

            for (const operation of operations) {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = operationLabels[operation];
                button.dataset.operation = operation;
                button.addEventListener("click", async () => {
                    if (mutating || loadRequest || request.signal.aborted) {
                        return;
                    }

                    const needsReason = operation === "reject" || operation === "unpublish";

                    if (needsReason && !reason.value.trim()) {
                        element("result").textContent = "Enter a public reason.";
                        reason.focus();

                        return;
                    }

                    mutating = true;
                    controls();
                    let saved = false;

                    try {
                        await moderateEntry(
                            api,
                            key,
                            {
                                repository: entry.repository,
                                commit: entry.commit,
                                revision: entry.revision,
                                operation,
                                ...(needsReason ? { reason: reason.value.trim() } : {}),
                            },
                            { signal: request.signal },
                        );
                        saved = true;
                    } catch (error) {
                        if (!request.signal.aborted && !authorizationFailed(error)) {
                            element("result").textContent = `${message(error)}. Refresh before another action.`;
                        }
                    } finally {
                        if (!request.signal.aborted) {
                            request.abort();
                            mutating = false;
                            clearRows();
                            controls();

                            if (saved) {
                                void refresh();
                            }
                        }
                    }
                });
                actions.append(button);
            }

            row.append(actions);
            element("queue").append(row);
            rows.set(entry, row);
        }

        const repositories = Map.groupBy(entries, (entry) => entry.repository);

        for (const commits of repositories.values()) {
            if (commits.length < 2) {
                continue;
            }

            commits.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || a.commit.localeCompare(b.commit));
            const [latest, ...history] = commits;
            const details = document.createElement("details");
            const summary = document.createElement("summary");
            const list = document.createElement("ul");
            list.className = "review-history";
            summary.textContent = `Previous commits (${history.length})`;

            for (const previous of history) {
                list.append(rows.get(previous)!);
            }

            details.append(summary, list);
            rows.get(latest)!.append(details);
        }

        element("entry-count").textContent = `(${repositories.size})`;
        element("result").textContent = entries.length ? "" : "No entries.";
    } catch (error) {
        if (!request.signal.aborted && !authorizationFailed(error)) {
            element("result").textContent = `${message(error)}. Previous list retained; refresh to retry.`;
        }
    } finally {
        if (!request.signal.aborted) {
            loadRequest = undefined;
            controls();
        }
    }
}

element("create").addEventListener("click", () => void loadIdentity());
element("key-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void loadIdentity(keyInput.value);
});
element("show-key").addEventListener("click", () => showKey(keyInput.type === "password"));
element("clear").addEventListener("click", clearIdentity);
element("refresh").addEventListener("click", () => void refresh());
controls();
