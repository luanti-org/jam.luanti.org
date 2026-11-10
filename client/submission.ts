import { ApiError, getRepositoryStatus, submitBrew } from "./sdk";
import { substitute } from "./presentation";
import type workshop from "../content/workshop.json";

export const submissionTemplate = `<form id="submit-form">
    <input
        id="repository"
        type="url"
        required
        maxlength="2048"
        data-copy-aria-label="submission.repositoryLabel"
        data-copy-placeholder="submission.repositoryPlaceholder"
        autocomplete="url"
        spellcheck="false"
    />
    <div class="submission-actions">
        <button id="submit-button" class="primary" type="submit">
            <span class="spinner" aria-hidden="true" hidden></span>
            <span id="submit-label" data-copy="submission.submit"></span>
        </button>
        <button
            id="refresh-status"
            type="button"
            data-copy="submission.refresh"
        ></button>
        <p id="status" role="status" tabindex="-1"></p>
    </div>
</form>
<p
    id="inspection-help"
    class="fine-print"
    data-copy="submission.inspectionHelp"
    role="status"
    hidden
></p>`;

export function initSubmission(root: HTMLElement, api: string, submissionCopy: typeof workshop.submission, onChange: () => void) {
    const formNode = root.querySelector<HTMLFormElement>("#submit-form");

    if (!formNode) {
        return;
    }

    const form = formNode;
    const element = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
    const message = (error: unknown) => error instanceof Error ? error.message : String(error);
    const repository = element<HTMLInputElement>("repository");
    const submitButton = element<HTMLButtonElement>("submit-button");
    const checkButton = element<HTMLButtonElement>("refresh-status");
    let currentStatus: Awaited<ReturnType<typeof submitBrew>> | undefined;

    function submissionBusy(busy: boolean, inspecting = false) {
        submitButton.disabled = busy;
        checkButton.disabled = busy;
        repository.disabled = busy;

        if (busy) {
            form.setAttribute("aria-busy", "true");
        } else {
            form.removeAttribute("aria-busy");
        }

        submitButton.querySelector<HTMLElement>(".spinner")!.hidden = !inspecting;
        element("submit-label").textContent = inspecting ? submissionCopy.inspecting : submissionCopy.submit;
        element("inspection-help").hidden = !inspecting;
    }

    function showStatus(state: Awaited<ReturnType<typeof submitBrew>>, submitted = false) {
        const link = document.createElement("a");
        link.href = state.commitUrl;
        link.textContent = state.commit.slice(0, 7);
        link.title = state.commit;
        const result = submissionCopy.statuses[state.status];
        const feedback = state.reason ? `: "${state.reason}"` : ".";
        element("status").replaceChildren(`${submissionCopy.commitLabel} `, link, ` ${result}${feedback}`);

        const changed = currentStatus && (currentStatus.repository !== state.repository || currentStatus.commit !== state.commit
            || currentStatus.status !== state.status || currentStatus.reason !== state.reason);

        if (submitted || changed) {
            onChange();
        }

        currentStatus = state;
    }

    async function status() {
        validateRepository();

        if (checkButton.disabled || !form.reportValidity()) {
            return;
        }

        submissionBusy(true);
        element("status").textContent = submissionCopy.checking;

        try {
            const state = await getRepositoryStatus(api, repository.value);
            repository.value = state.repository;
            showStatus(state);
        } catch (error) {
            element("status").textContent = message(error);
        } finally {
            submissionBusy(false);
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

    repository.addEventListener("input", () => {
        validateRepository();
        currentStatus = undefined;
        element("status").textContent = "";
    });
    checkButton.addEventListener("click", () => void status());

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        validateRepository();

        if (submitButton.disabled || !form.reportValidity()) {
            return;
        }

        submissionBusy(true, true);
        element("status").textContent = "";

        try {
            repository.value = repository.value.replace(/^http:\/\//i, "https://");
            const result = await submitBrew(api, repository.value);
            showStatus(result, true);

            if (!root.hidden && root.closest("dialog")?.open) {
                element("status").focus();
            }
        } catch (error) {
            const template = error instanceof ApiError && error.status === 422
                ? submissionCopy.inspectionFailure : submissionCopy.submitFailure;
            element("status").textContent = substitute(template, { error: message(error) });
        } finally {
            submissionBusy(false);
        }
    });
}
