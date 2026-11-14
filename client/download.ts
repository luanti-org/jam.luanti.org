import hosts from "../content/hosts.json";

/** Archives use the submitted commit, including for repositories in nested GitLab groups. */
export function archiveUrl(repository: string, commit: string) {
    const url = new URL(repository);
    const host = hosts.find(({ host }) => host === url.hostname);

    // An operator may add a host before the frontend is rebuilt.
    if (!host) {
        return null;
    }

    const path = host.archive.replaceAll("{sha}", commit).replace("{repo}", url.pathname.split("/").at(-1)!);

    return `${repository}${path}`;
}

export function downloadLink(entry: { repository: string; commit: string; title: string | null }, label: string) {
    const href = archiveUrl(entry.repository, entry.commit);

    if (!href) {
        return null;
    }

    const link = document.createElement("a");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    link.className = "entry-download";
    link.href = href;
    link.title = `${label}: ${entry.title ?? entry.repository} (ZIP)`;
    link.setAttribute("aria-label", link.title);
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    path.setAttribute("d", "M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4");
    icon.append(path);
    link.append(icon);

    return link;
}
