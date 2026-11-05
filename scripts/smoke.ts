import { repositoryInfo } from "../server/repositories";
import { checkRuntime, inspectRepository } from "../server/submissions";

const candidates = [
    "https://github.com/luanti-org/minetest_game",
    "https://gitlab.com/sztest/fdmcube",
    "https://codeberg.org/mineclonia/mineclonia",
    "https://git.minetest.land/VoxeLibre/VoxeLibre",
];

checkRuntime();

for (const repository of candidates) {
    const info = repositoryInfo(repository);
    console.log(`Inspecting ${info.repository}`);

    try {
        const snapshot = await inspectRepository(info, Date.now() + 120000, Infinity);
        console.log(`PASS ${info.host}: ${snapshot.commit}, ${snapshot.title}, WebP ${snapshot.screenshot.length} bytes`);
    } catch (error) {
        console.error(`UNAVAILABLE ${info.host}: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
